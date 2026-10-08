// 3xOSO — native three-oscillator synth (VST3 / CLAP / Standalone). A Circuit Drift Labs tool.
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_audio_plugin_client/juce_audio_plugin_client.h>

using juce::jmax; using juce::jmin; using juce::jlimit;
namespace cdl
{
const juce::Colour base { 0xff0e1116 }, surface { 0xff171b22 }, edge { 0xff2a303a }, orange { 0xffe8532a },
                   teal { 0xff4fb6c4 }, text { 0xffe6e8ec }, muted { 0xff8a929e };

static const char* markSvg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none'>"
    "<rect x='2' y='2' width='44' height='44' rx='5' fill='#0B1119' stroke='#35485C'/>"
    "<path d='M8 30h8l5-15 7 21 5-12h7' stroke='#607A96' stroke-width='2.4' stroke-linejoin='round' stroke-linecap='round'/>"
    "<circle cx='9' cy='30' r='2' fill='#A8B2BC'/><circle cx='40' cy='24' r='2' fill='#A8B2BC'/>"
    "<path d='M2 13 13 2' stroke='#27394D' stroke-width='2'/></svg>";

static const juce::StringArray waves { "Sine", "Triangle", "Square", "Saw", "R-Saw", "Noise" };
static const juce::StringArray chordNames { "Off", "Major", "Minor", "Sus4", "Maj7", "Min7", "Power", "Octaves" };
static const std::vector<std::vector<int>> chordIv { { 0 }, { 0, 4, 7 }, { 0, 3, 7 }, { 0, 5, 7 }, { 0, 4, 7, 11 }, { 0, 3, 7, 10 }, { 0, 7, 12 }, { 0, 12, -12 } };

// Event feed for the "matrix" text stream in the editor (audio thread -> UI thread, lock free).
struct Feed
{
    struct Ev { int kind = 0, a = 0, b = 0; };
    juce::AbstractFifo fifo { 128 };
    Ev buf[128];
    void push (int k, int a, int b) { int s1, n1, s2, n2; fifo.prepareToWrite (1, s1, n1, s2, n2); if (n1) buf[s1] = { k, a, b }; fifo.finishedWrite (n1 + n2); }
    bool pop (Ev& e) { int s1, n1, s2, n2; fifo.prepareToRead (1, s1, n1, s2, n2); if (n1) e = buf[s1]; fifo.finishedRead (n1 + n2); return n1 > 0; }
};

struct Sound : juce::SynthesiserSound { bool appliesToNote (int) override { return true; } bool appliesToChannel (int) override { return true; } };

struct Params
{
    std::atomic<float> *wave[3], *coarse[3], *fine[3], *level[3], *pan[3];
    std::atomic<float> *cutoff, *res, *fenv, *a, *d, *s, *r, *drift, *master;
};

static float polyBlep (float t, float dt)
{
    if (t < dt) { t /= dt; return t + t - t * t - 1.0f; }
    if (t > 1.0f - dt) { t = (t - 1.0f) / dt; return t * t + t + t + 1.0f; }
    return 0.0f;
}

struct Voice : juce::SynthesiserVoice
{
    explicit Voice (const Params& p) : P (p) {}
    bool canPlaySound (juce::SynthesiserSound* s) override { return dynamic_cast<Sound*> (s) != nullptr; }

    void startNote (int note, float vel, juce::SynthesiserSound*, int pitchWheel) override
    {
        hz = juce::MidiMessage::getMidiNoteInHertz (note);
        level = vel;
        bend = (pitchWheel - 8192) / 8192.0f * 2.0f;
        for (auto& ph : phase) ph = 0.0f;
        driftNow = driftTarget = 0.0f;
        s1[0] = s1[1] = s2[0] = s2[1] = 0.0f;
        adsr.setSampleRate (getSampleRate());
        adsr.setParameters ({ jmax (0.001f, P.a->load()), jmax (0.001f, P.d->load()), P.s->load(), jmax (0.005f, P.r->load()) });
        adsr.noteOn();
    }
    void stopNote (float, bool allowTail) override { if (allowTail) adsr.noteOff(); else { adsr.reset(); clearCurrentNote(); } }
    void pitchWheelMoved (int v) override { bend = (v - 8192) / 8192.0f * 2.0f; }
    void controllerMoved (int, int) override {}

    void renderNextBlock (juce::AudioBuffer<float>& out, int start, int num) override
    {
        if (! adsr.isActive()) { clearCurrentNote(); return; }
        const float sr = (float) getSampleRate();
        adsr.setParameters ({ jmax (0.001f, P.a->load()), jmax (0.001f, P.d->load()), P.s->load(), jmax (0.005f, P.r->load()) });
        // analog drift: slow random walk, up to +-15 cents at full depth
        if (--driftCount <= 0) { driftTarget = (rng.nextFloat() * 2.0f - 1.0f) * P.drift->load() * 15.0f; driftCount = (int) (sr * 0.25f); }
        const float dAmt = 0.0005f * (float) num;
        driftNow += (driftTarget - driftNow) * jmin (1.0f, dAmt);

        float inc[3], lv[3], gl[3], gr[3];
        int shp[3];
        float lvSum = 0.0f;
        for (int i = 0; i < 3; ++i)
        {
            const float cents = P.coarse[i]->load() * 100.0f + P.fine[i]->load() + driftNow * (i == 0 ? 0.5f : (i == 1 ? 1.0f : -1.0f)) + bend * 100.0f;
            inc[i] = hz * std::pow (2.0f, cents / 1200.0f) / sr;
            lv[i] = P.level[i]->load();
            lvSum += lv[i];
            shp[i] = (int) P.wave[i]->load();
            const float pn = (P.pan[i]->load() + 1.0f) * 0.25f * juce::MathConstants<float>::pi;
            gl[i] = std::cos (pn); gr[i] = std::sin (pn);
        }
        const float norm = 0.35f / jmax (1.0f, lvSum);
        const float cut = P.cutoff->load(), fenv = P.fenv->load();
        const float k = 2.0f - 1.95f * P.res->load();
        const float master = P.master->load();

        for (int n = 0; n < num; ++n)
        {
            float l = 0.0f, r = 0.0f;
            for (int i = 0; i < 3; ++i)
            {
                float& ph = phase[i];
                const float dt = inc[i];
                float v = 0.0f;
                switch (shp[i])
                {
                    case 0: v = std::sin (ph * juce::MathConstants<float>::twoPi); break;
                    case 1: v = 1.0f - 4.0f * std::abs (ph - 0.5f); break;
                    case 2: v = (ph < 0.5f ? 1.0f : -1.0f) + polyBlep (ph, dt) - polyBlep (std::fmod (ph + 0.5f, 1.0f), dt); break;
                    case 3: v = 2.0f * ph - 1.0f - polyBlep (ph, dt); break;
                    case 4: { const float a = ph * juce::MathConstants<float>::twoPi; v = 0.6f * (std::sin (a) + 0.5f * std::sin (2 * a) + 0.33f * std::sin (3 * a) + 0.25f * std::sin (4 * a)); break; }
                    default: v = rng.nextFloat() * 2.0f - 1.0f; break;
                }
                ph += dt; if (ph >= 1.0f) ph -= 1.0f;
                v *= lv[i];
                l += v * gl[i]; r += v * gr[i];
            }
            const float e = adsr.getNextSample();
            const float fc = jlimit (20.0f, 0.45f * sr, cut * std::pow (2.0f, fenv * 4.0f * e));
            const float g = std::tan (juce::MathConstants<float>::pi * fc / sr);
            const float a1 = 1.0f / (1.0f + g * (g + k)), a2 = g * a1, a3 = g * a2;
            float in[2] = { l, r }, o[2];
            for (int c = 0; c < 2; ++c)
            {
                const float v3 = in[c] - s2[c];
                const float v1 = a1 * s1[c] + a2 * v3;
                const float v2 = s2[c] + a2 * s1[c] + a3 * v3;
                s1[c] = 2.0f * v1 - s1[c]; s2[c] = 2.0f * v2 - s2[c];
                o[c] = v2 * e * level * norm * master * 2.0f;
            }
            out.addSample (0, start + n, o[0]);
            if (out.getNumChannels() > 1) out.addSample (1, start + n, o[1]);
        }
        if (! adsr.isActive()) clearCurrentNote();
    }

    const Params& P;
    juce::ADSR adsr;
    juce::Random rng;
    float phase[3] {}, hz = 440.0f, level = 1.0f, bend = 0.0f, driftNow = 0.0f, driftTarget = 0.0f, s1[2] {}, s2[2] {};
    int driftCount = 0;
};

static juce::AudioProcessorValueTreeState::ParameterLayout makeLayout()
{
    using namespace juce;
    AudioProcessorValueTreeState::ParameterLayout L;
    const int shapesDefault[3] = { 3, 2, 0 }, coarseDefault[3] = { 0, -12, -24 };
    const float levelDefault[3] = { 0.8f, 0.5f, 0.4f };
    for (int i = 0; i < 3; ++i)
    {
        const String n = String (i + 1), nm = "Osc " + n + " ";
        L.add (std::make_unique<AudioParameterChoice> (ParameterID { "wave" + n, 1 }, nm + "Wave", waves, shapesDefault[i]));
        L.add (std::make_unique<AudioParameterInt> (ParameterID { "coarse" + n, 1 }, nm + "Coarse", -36, 36, coarseDefault[i]));
        L.add (std::make_unique<AudioParameterFloat> (ParameterID { "fine" + n, 1 }, nm + "Fine", NormalisableRange<float> (-100.0f, 100.0f, 0.1f), 0.0f));
        L.add (std::make_unique<AudioParameterFloat> (ParameterID { "level" + n, 1 }, nm + "Level", NormalisableRange<float> (0.0f, 1.0f, 0.001f), levelDefault[i]));
        L.add (std::make_unique<AudioParameterFloat> (ParameterID { "pan" + n, 1 }, nm + "Pan", NormalisableRange<float> (-1.0f, 1.0f, 0.001f), 0.0f));
    }
    L.add (std::make_unique<AudioParameterFloat> (ParameterID { "cutoff", 1 }, "Cutoff", NormalisableRange<float> (20.0f, 20000.0f, 0.1f, 0.3f), 18000.0f));
    L.add (std::make_unique<AudioParameterFloat> (ParameterID { "res", 1 }, "Resonance", NormalisableRange<float> (0.0f, 1.0f, 0.001f), 0.0f));
    L.add (std::make_unique<AudioParameterFloat> (ParameterID { "fenv", 1 }, "Env > Filter", NormalisableRange<float> (0.0f, 1.0f, 0.001f), 0.0f));
    L.add (std::make_unique<AudioParameterFloat> (ParameterID { "a", 1 }, "Attack", NormalisableRange<float> (0.001f, 4.0f, 0.001f, 0.4f), 0.01f));
    L.add (std::make_unique<AudioParameterFloat> (ParameterID { "d", 1 }, "Decay", NormalisableRange<float> (0.001f, 4.0f, 0.001f, 0.4f), 0.3f));
    L.add (std::make_unique<AudioParameterFloat> (ParameterID { "s", 1 }, "Sustain", NormalisableRange<float> (0.0f, 1.0f, 0.001f), 0.8f));
    L.add (std::make_unique<AudioParameterFloat> (ParameterID { "r", 1 }, "Release", NormalisableRange<float> (0.005f, 6.0f, 0.001f, 0.4f), 0.3f));
    L.add (std::make_unique<AudioParameterFloat> (ParameterID { "drift", 1 }, "Drift", NormalisableRange<float> (0.0f, 1.0f, 0.001f), 0.0f));
    L.add (std::make_unique<AudioParameterChoice> (ParameterID { "chord", 1 }, "Chord", chordNames, 0));
    L.add (std::make_unique<AudioParameterFloat> (ParameterID { "master", 1 }, "Master", NormalisableRange<float> (0.0f, 1.0f, 0.001f), 0.6f));
    return L;
}

struct Preset { const char* name; std::vector<std::pair<const char*, float>> v; };
static const std::vector<Preset> presets {
    { "Init Saw Stack", {} },
    { "Sub Bass", { { "wave1", 0 }, { "coarse1", -12 }, { "level1", 0.9f }, { "wave2", 1 }, { "coarse2", -24 }, { "level2", 0.5f }, { "level3", 0 }, { "cutoff", 900 }, { "d", 0.5f }, { "s", 0.9f } } },
    { "Reese Bass", { { "wave1", 3 }, { "coarse1", -12 }, { "fine1", -14 }, { "wave2", 3 }, { "coarse2", -12 }, { "fine2", 14 }, { "level2", 0.8f }, { "wave3", 0 }, { "coarse3", -24 }, { "cutoff", 1400 }, { "res", 0.3f }, { "drift", 0.5f } } },
    { "Warm Pad", { { "wave1", 4 }, { "fine1", -8 }, { "wave2", 4 }, { "coarse2", 0 }, { "fine2", 9 }, { "level2", 0.7f }, { "wave3", 1 }, { "coarse3", 12 }, { "level3", 0.3f }, { "cutoff", 3200 }, { "a", 0.8f }, { "r", 1.8f }, { "drift", 0.6f } } },
    { "Pluck Lead", { { "wave1", 2 }, { "wave2", 3 }, { "coarse2", 7 }, { "level2", 0.4f }, { "level3", 0 }, { "cutoff", 700 }, { "res", 0.4f }, { "fenv", 0.7f }, { "d", 0.2f }, { "s", 0.0f }, { "r", 0.2f } } },
    { "Acid Squelch", { { "wave1", 3 }, { "coarse1", -12 }, { "level2", 0 }, { "level3", 0 }, { "cutoff", 300 }, { "res", 0.85f }, { "fenv", 0.8f }, { "d", 0.25f }, { "s", 0.1f } } },
    { "Power Fifths", { { "wave1", 3 }, { "wave2", 3 }, { "coarse2", 7 }, { "fine2", 6 }, { "wave3", 3 }, { "coarse3", -12 }, { "cutoff", 5000 }, { "chord", 6 } } },
    { "Glass Bells", { { "wave1", 0 }, { "wave2", 0 }, { "coarse2", 19 }, { "level2", 0.4f }, { "wave3", 0 }, { "coarse3", 28 }, { "level3", 0.2f }, { "d", 1.5f }, { "s", 0.0f }, { "r", 2.0f }, { "chord", 4 } } },
};

class Processor : public juce::AudioProcessor
{
public:
    Processor() : AudioProcessor (BusesProperties().withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
                  apvts (*this, nullptr, "STATE", makeLayout())
    {
        for (int i = 0; i < 3; ++i)
        {
            const auto n = juce::String (i + 1);
            P.wave[i] = apvts.getRawParameterValue ("wave" + n); P.coarse[i] = apvts.getRawParameterValue ("coarse" + n);
            P.fine[i] = apvts.getRawParameterValue ("fine" + n); P.level[i] = apvts.getRawParameterValue ("level" + n);
            P.pan[i] = apvts.getRawParameterValue ("pan" + n);
        }
        P.cutoff = apvts.getRawParameterValue ("cutoff"); P.res = apvts.getRawParameterValue ("res"); P.fenv = apvts.getRawParameterValue ("fenv");
        P.a = apvts.getRawParameterValue ("a"); P.d = apvts.getRawParameterValue ("d"); P.s = apvts.getRawParameterValue ("s"); P.r = apvts.getRawParameterValue ("r");
        P.drift = apvts.getRawParameterValue ("drift"); P.master = apvts.getRawParameterValue ("master");
        chordP = apvts.getRawParameterValue ("chord");
        synth.addSound (new Sound());
        for (int i = 0; i < 16; ++i) synth.addVoice (new Voice (P));
    }

    const juce::String getName() const override { return "3xOSO"; }
    void prepareToPlay (double sr, int) override { synth.setCurrentPlaybackSampleRate (sr); }
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& l) const override { return l.getMainOutputChannelSet() == juce::AudioChannelSet::stereo(); }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 6.0; }

    void processBlock (juce::AudioBuffer<float>& buf, juce::MidiBuffer& midi) override
    {
        juce::ScopedNoDenormals nd;
        buf.clear();
        const int chord = (int) chordP->load();
        juce::MidiBuffer expanded;
        for (const auto meta : midi)
        {
            const auto m = meta.getMessage();
            if (m.isNoteOnOrOff())
            {
                feed.push (m.isNoteOn() ? 1 : 2, m.getNoteNumber(), m.getVelocity());
                for (int iv : chordIv[(size_t) juce::jlimit (0, 7, chord)])
                {
                    const int n = m.getNoteNumber() + iv;
                    if (n < 0 || n > 127) continue;
                    expanded.addEvent (m.isNoteOn() ? juce::MidiMessage::noteOn (m.getChannel(), n, m.getVelocity())
                                                    : juce::MidiMessage::noteOff (m.getChannel(), n, m.getVelocity()), meta.samplePosition);
                }
            }
            else
            {
                if (m.isController()) feed.push (3, m.getControllerNumber(), m.getControllerValue());
                expanded.addEvent (m, meta.samplePosition);
            }
        }
        synth.renderNextBlock (buf, expanded, 0, buf.getNumSamples());
        const float pk = buf.getMagnitude (0, buf.getNumSamples());
        peak.store (pk);
        int active = 0;
        for (int i = 0; i < synth.getNumVoices(); ++i) active += synth.getVoice (i)->isVoiceActive() ? 1 : 0;
        voicesActive.store (active);
    }

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }
    int getNumPrograms() override { return (int) presets.size(); }
    int getCurrentProgram() override { return program; }
    const juce::String getProgramName (int i) override { return presets[(size_t) juce::jlimit (0, (int) presets.size() - 1, i)].name; }
    void changeProgramName (int, const juce::String&) override {}
    void setCurrentProgram (int i) override
    {
        if (i < 0 || i >= (int) presets.size()) return;
        program = i;
        // reset everything to defaults, then apply the preset values
        for (auto* p : getParameters())
            if (auto* rp = dynamic_cast<juce::RangedAudioParameter*> (p)) rp->setValueNotifyingHost (rp->getDefaultValue());
        for (auto& [id, val] : presets[(size_t) i].v)
            if (auto* rp = apvts.getParameter (id)) rp->setValueNotifyingHost (rp->convertTo0to1 (val));
    }
    void getStateInformation (juce::MemoryBlock& d) override { if (auto x = apvts.copyState().createXml()) copyXmlToBinary (*x, d); }
    void setStateInformation (const void* data, int size) override
    {
        if (auto x = getXmlFromBinary (data, size)) if (x->hasTagName (apvts.state.getType())) apvts.replaceState (juce::ValueTree::fromXml (*x));
    }

    // "Surprise me": a musical random sound
    void surprise()
    {
        juce::Random r;
        auto set = [this] (const char* id, float real) { if (auto* p = apvts.getParameter (id)) p->setValueNotifyingHost (p->convertTo0to1 (real)); };
        static const int steps[] = { -24, -12, -12, 0, 0, 7, 12, 12, 19 };
        for (int i = 1; i <= 3; ++i)
        {
            const auto n = juce::String (i);
            set (("wave" + n).toRawUTF8(), (float) r.nextInt (5));
            set (("coarse" + n).toRawUTF8(), (float) steps[r.nextInt (9)]);
            set (("fine" + n).toRawUTF8(), r.nextFloat() * 30.0f - 15.0f);
            set (("level" + n).toRawUTF8(), i == 1 ? 0.8f : 0.2f + r.nextFloat() * 0.6f);
            set (("pan" + n).toRawUTF8(), r.nextFloat() * 1.0f - 0.5f);
        }
        set ("cutoff", 300.0f * std::pow (2.0f, r.nextFloat() * 5.5f));
        set ("res", r.nextFloat() * 0.7f); set ("fenv", r.nextFloat() * 0.8f);
        set ("a", r.nextFloat() < 0.3f ? 0.3f + r.nextFloat() : 0.005f + r.nextFloat() * 0.05f);
        set ("d", 0.1f + r.nextFloat() * 0.8f); set ("s", r.nextFloat()); set ("r", 0.1f + r.nextFloat() * 1.5f);
        set ("drift", r.nextFloat() * 0.8f);
    }

    juce::AudioProcessorValueTreeState apvts;
    Feed feed;
    std::atomic<float> peak { 0.0f };
    std::atomic<int> voicesActive { 0 };

private:
    Params P;
    std::atomic<float>* chordP;
    juce::Synthesiser synth;
    int program = 0;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Processor)
};

// ------------------------------------------------------------------ Circuit Drift Labs look
struct CdlLook : juce::LookAndFeel_V4
{
    CdlLook()
    {
        setColour (juce::ComboBox::backgroundColourId, surface); setColour (juce::ComboBox::outlineColourId, edge);
        setColour (juce::ComboBox::textColourId, text); setColour (juce::ComboBox::arrowColourId, teal);
        setColour (juce::PopupMenu::backgroundColourId, surface); setColour (juce::PopupMenu::textColourId, text);
        setColour (juce::PopupMenu::highlightedBackgroundColourId, orange.withAlpha (0.25f));
        setColour (juce::TextButton::buttonColourId, surface); setColour (juce::TextButton::textColourOffId, muted);
        setColour (juce::TextButton::textColourOnId, orange); setColour (juce::Label::textColourId, muted);
        setDefaultSansSerifTypefaceName ("Inter");
    }
    void drawRotarySlider (juce::Graphics& g, int x, int y, int w, int h, float pos, float a0, float a1, juce::Slider& s) override
    {
        const float size = (float) juce::jmin (w, h), cx = x + w * 0.5f, cy = y + h * 0.5f, ro = size * 0.5f - 2.0f, rb = ro - 6.0f;
        const float ang = a0 + pos * (a1 - a0);
        juce::Path track, val;
        track.addCentredArc (cx, cy, ro, ro, 0, a0, a1, true);
        val.addCentredArc (cx, cy, ro, ro, 0, a0, ang, true);
        g.setColour (edge.withAlpha (0.6f)); g.strokePath (track, juce::PathStrokeType (3.0f, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
        g.setColour (orange); g.strokePath (val, juce::PathStrokeType (3.0f, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
        g.setGradientFill (juce::ColourGradient (juce::Colour (0xff232833), cx, cy - rb, juce::Colour (0xff14181f), cx, cy + rb, false));
        g.fillEllipse (cx - rb, cy - rb, rb * 2, rb * 2);
        g.setColour (edge); g.drawEllipse (cx - rb, cy - rb, rb * 2, rb * 2, 1.0f);
        g.setColour (s.isMouseOverOrDragging() ? orange.brighter (0.3f) : orange);
        g.drawLine (cx + std::sin (ang) * rb * 0.25f, cy - std::cos (ang) * rb * 0.25f, cx + std::sin (ang) * rb * 0.95f, cy - std::cos (ang) * rb * 0.95f, 2.0f);
    }
    void drawButtonBackground (juce::Graphics& g, juce::Button& b, const juce::Colour&, bool hover, bool down) override
    {
        auto r = b.getLocalBounds().toFloat().reduced (0.5f);
        const bool on = b.getToggleState();
        g.setColour (on ? orange.withAlpha (0.15f) : (hover || down ? surface.brighter (0.08f) : surface));
        g.fillRoundedRectangle (r, 4.0f);
        g.setColour (on ? orange : (hover ? teal : edge)); g.drawRoundedRectangle (r, 4.0f, 1.0f);
    }
    juce::Font getTextButtonFont (juce::TextButton&, int) override { return juce::Font (juce::FontOptions (juce::Font::getDefaultMonospacedFontName(), 11.0f, juce::Font::plain)); }
};

struct Knob : juce::Component
{
    Knob (juce::AudioProcessorValueTreeState& s, const juce::String& id, const juce::String& name)
        : att (s, id, slider)
    {
        slider.setSliderStyle (juce::Slider::RotaryVerticalDrag);
        slider.setTextBoxStyle (juce::Slider::NoTextBox, false, 0, 0);
        slider.setRotaryParameters (juce::degreesToRadians (225.0f), juce::degreesToRadians (495.0f), true);
        slider.setDoubleClickReturnValue (true, s.getParameter (id)->convertFrom0to1 (s.getParameter (id)->getDefaultValue()));
        slider.setPopupDisplayEnabled (true, true, nullptr);
        label.setText (name.toUpperCase(), juce::dontSendNotification);
        label.setJustificationType (juce::Justification::centred);
        label.setFont (juce::Font (juce::FontOptions (juce::Font::getDefaultMonospacedFontName(), 9.5f, juce::Font::plain)));
        label.setInterceptsMouseClicks (false, false);
        addAndMakeVisible (slider); addAndMakeVisible (label);
    }
    void resized() override { auto b = getLocalBounds(); label.setBounds (b.removeFromBottom (14)); slider.setBounds (b); }
    juce::Slider slider; juce::Label label; juce::AudioProcessorValueTreeState::SliderAttachment att;
};

class Editor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit Editor (Processor& p) : AudioProcessorEditor (p), proc (p)
    {
        setLookAndFeel (&look);
        logo = juce::Drawable::createFromImageData (cdl::markSvg, std::strlen (cdl::markSvg));
        const char* names[5] = { "coarse", "fine", "level", "pan", "" };
        for (int i = 0; i < 3; ++i)
        {
            const auto n = juce::String (i + 1);
            waveBox[i].addItemList (waves, 1);
            addAndMakeVisible (waveBox[i]);
            waveAtt[i] = std::make_unique<juce::AudioProcessorValueTreeState::ComboBoxAttachment> (p.apvts, "wave" + n, waveBox[i]);
            for (int k = 0; k < 4; ++k)
            { knobs.push_back (std::make_unique<Knob> (p.apvts, juce::String (names[k]) + n, names[k])); addAndMakeVisible (*knobs.back()); }
        }
        auto add = [&] (const char* id, const char* nm) { knobs.push_back (std::make_unique<Knob> (p.apvts, id, nm)); addAndMakeVisible (*knobs.back()); };
        add ("cutoff", "cutoff"); add ("res", "reso"); add ("fenv", "env>flt");
        add ("a", "attack"); add ("d", "decay"); add ("s", "sustain"); add ("r", "release");
        add ("drift", "drift"); add ("master", "master");
        chordBox.addItemList (chordNames, 1); addAndMakeVisible (chordBox);
        chordAtt = std::make_unique<juce::AudioProcessorValueTreeState::ComboBoxAttachment> (p.apvts, "chord", chordBox);
        for (int i = 0; i < p.getNumPrograms(); ++i) presetBox.addItem (p.getProgramName (i), i + 1);
        presetBox.setSelectedId (p.getCurrentProgram() + 1, juce::dontSendNotification);
        presetBox.onChange = [this] { proc.setCurrentProgram (presetBox.getSelectedId() - 1); };
        addAndMakeVisible (presetBox);
        surpriseBtn.onClick = [this] { proc.surprise(); };
        addAndMakeVisible (surpriseBtn);
        setSize (860, 540);
        startTimerHz (30);
    }
    ~Editor() override { setLookAndFeel (nullptr); }

    void paint (juce::Graphics& g) override
    {
        auto full = getLocalBounds().toFloat();
        g.fillAll (base);
        // header
        g.setColour (surface); g.fillRect (0, 0, getWidth(), 40);
        g.setColour (edge); g.drawHorizontalLine (40, 0, (float) getWidth());
        g.setColour (orange); { juce::Path n; n.addLineSegment ({ 0, 0, 18, 0 }, 2); }
        juce::Path notch; notch.startNewSubPath (0, 18); notch.lineTo (18, 0);
        g.strokePath (notch, juce::PathStrokeType (2.0f));
        // LED
        const float db = juce::Decibels::gainToDecibels (ledLevel, -60.0f);
        const bool clip = ledLevel > 1.0f;
        const float t = juce::jlimit (0.0f, 1.0f, (db + 60.0f) / 60.0f);
        g.setColour (clip ? juce::Colours::red : juce::Colour (0xff3a3f48).interpolatedWith (juce::Colours::white, t));
        g.fillEllipse (14, 16, 9, 9);
        if (logo) logo->drawWithin (g, juce::Rectangle<float> (34, 6, 28, 28), juce::RectanglePlacement::centred, 1.0f);
        g.setColour (text); g.setFont (juce::Font (juce::FontOptions (juce::Font::getDefaultMonospacedFontName(), 15.0f, juce::Font::bold)));
        g.drawText ("3x", 70, 8, 30, 24, juce::Justification::centredLeft);
        g.setColour (orange); g.drawText ("OSO", 90, 8, 50, 24, juce::Justification::centredLeft);
        g.setColour (muted); g.setFont (juce::Font (juce::FontOptions (juce::Font::getDefaultMonospacedFontName(), 9.5f, juce::Font::plain)));
        g.drawText ("CIRCUIT DRIFT LABS", 140, 8, 160, 24, juce::Justification::centredLeft);
        // sections
        auto section = [&] (juce::Rectangle<int> r, const juce::String& title, juce::Colour c) {
            g.setColour (surface); g.fillRoundedRectangle (r.toFloat(), 4.0f);
            g.setColour (edge); g.drawRoundedRectangle (r.toFloat(), 4.0f, 1.0f);
            g.setColour (c); g.fillRect (r.getX() + 10, r.getY() + 10, 2, 12);
            g.setColour (text); g.setFont (juce::Font (juce::FontOptions (juce::Font::getDefaultMonospacedFontName(), 10.5f, juce::Font::bold)));
            g.drawText (title.toUpperCase(), r.getX() + 18, r.getY() + 8, r.getWidth() - 24, 16, juce::Justification::centredLeft);
        };
        for (int i = 0; i < 3; ++i) section ({ 16 + i * 276, 56, 260, 200 }, "Oscillator " + juce::String (i + 1), orange);
        section ({ 16, 272, 260, 120 }, "Filter", teal);
        section ({ 292, 272, 260, 120 }, "Envelope", teal);
        section ({ 568, 272, 276, 120 }, "Voice", orange);
        // matrix stream
        auto r = juce::Rectangle<int> (16, 404, 828, 106);
        g.setColour (edge); g.drawRect (r, 1);
        g.setFont (juce::Font (juce::FontOptions (juce::Font::getDefaultMonospacedFontName(), 10.0f, juce::Font::plain)));
        const int n = lines.size();
        for (int i = 0; i < n; ++i)
        {
            const int idx = n - 1 - i; // newest at bottom
            const int row = 9 - i;
            float a = 0.75f;
            if (row <= 1) a = 0.2f * (float) (row + 1) * 0.5f; else if (row >= 8) a = 0.2f * (float) (10 - row) * 0.5f;
            g.setColour (juce::Colour (0xff7bc96f).withAlpha (a));
            g.drawText (lines[idx], r.getX() + 8, r.getY() + 3 + row * 10, r.getWidth() - 16, 10, juce::Justification::centredLeft);
        }
        g.setColour (muted); g.setFont (9.0f);
        g.drawText ("v1.0.0", getWidth() - 80, getHeight() - 22, 64, 14, juce::Justification::centredRight);
        juce::ignoreUnused (full);
    }

    void resized() override
    {
        for (int i = 0; i < 3; ++i)
        {
            const int x = 16 + i * 276;
            waveBox[i].setBounds (x + 16, 86, 228, 24);
            for (int k = 0; k < 4; ++k) knobs[(size_t) (i * 4 + k)]->setBounds (x + 12 + (k % 2) * 118, 120 + (k / 2) * 66 - (k / 2) * 0, 114, 66);
        }
        // knobs: 12 osc knobs, then cutoff,res,fenv, a,d,s,r, drift, master
        auto K = [this] (int i) -> Knob& { return *knobs[(size_t) i]; };
        for (int k = 0; k < 3; ++k) K (12 + k).setBounds (28 + k * 78, 300, 72, 84);
        for (int k = 0; k < 4; ++k) K (15 + k).setBounds (304 + k * 60, 300, 58, 84);
        K (19).setBounds (584, 300, 72, 84); K (20).setBounds (664, 300, 72, 84);
        chordBox.setBounds (748, 318, 84, 24);
        surpriseBtn.setBounds (748, 352, 84, 26);
        presetBox.setBounds (getWidth() - 236, 8, 220, 24);
    }

    void timerCallback() override
    {
        const float pk = proc.peak.exchange (0.0f);
        ledLevel = juce::jmax (pk, ledLevel * 0.85f);
        Feed::Ev e; bool changed = false;
        while (proc.feed.pop (e))
        {
            const char* nn[] = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };
            if (e.kind == 1) addLine ("MIDI  note-on  " + juce::String (nn[e.a % 12]) + juce::String (e.a / 12 - 1) + "  vel " + juce::String (e.b));
            else if (e.kind == 2) addLine ("MIDI  note-off " + juce::String (nn[e.a % 12]) + juce::String (e.a / 12 - 1));
            else addLine ("MIDI  cc " + juce::String (e.a) + " = " + juce::String (e.b));
            changed = true;
        }
        for (auto& k : knobs)
        {
            const double v = k->slider.getValue();
            auto it = lastVals.find (k.get());
            if (it == lastVals.end()) lastVals[k.get()] = v;
            else if (std::abs (it->second - v) > 1e-6)
            { addLine ("CTRL  " + k->label.getText().toLowerCase() + " -> " + juce::String (v, 2)); it->second = v; changed = true; }
        }
        if (changed || ++idle < 3) { if (changed) idle = 0; }
        const int voices = proc.voicesActive.load();
        if (voices != lastVoices) { addLine ("AUDIO voices " + juce::String (voices) + "  peak " + juce::String (juce::Decibels::gainToDecibels (ledLevel, -90.0f), 1) + " dB"); lastVoices = voices; changed = true; }
        repaint (0, 0, 40, 40);
        if (changed) repaint (16, 404, 828, 106);
    }

private:
    void addLine (const juce::String& s) { lines.add (s); while (lines.size() > 10) lines.remove (0); }

    Processor& proc;
    CdlLook look;
    std::unique_ptr<juce::Drawable> logo;
    juce::ComboBox waveBox[3], chordBox, presetBox;
    std::unique_ptr<juce::AudioProcessorValueTreeState::ComboBoxAttachment> waveAtt[3], chordAtt;
    std::vector<std::unique_ptr<Knob>> knobs;
    std::map<Knob*, double> lastVals;
    juce::TextButton surpriseBtn { "Surprise me" };
    juce::StringArray lines;
    float ledLevel = 0.0f;
    int idle = 0, lastVoices = -1;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Editor)
};

juce::AudioProcessorEditor* Processor::createEditor() { return new Editor (*this); }
} // namespace cdl

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new cdl::Processor(); }
