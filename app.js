/* 3xOSO — visual 3-oscillator synth.
 * Plain JavaScript + Web Audio API. No build step: open index.html or serve via GitHub Pages.
 *
 * Signal flow per note (voice):
 *   osc1 -> gain -> pan --\
 *                         +--> amGain --> envelope --> master --> limiter --> analyser --> speakers
 *   osc2 -> gain -> pan --/       ^
 *   osc3 -> gain -> pan ----------|-----> envelope   (normal mode)
 *           gain ------------> amGain.gain           (AM mode: osc 3 wobbles the volume of 1 + 2)
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- constants
  const N_HARM = 64;          // harmonics used to build each waveform
  const TABLE = 2048;         // samples in the drawing lookup tables
  const SLOWMO = 1 / 400;     // scopes scroll at 1/400 of real time so motion is visible
  const VOICE_LEVEL = 0.3;    // headroom per voice
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const INTERVALS = ['unison', 'minor 2nd', 'major 2nd', 'minor 3rd', 'major 3rd', 'perfect 4th',
    'tritone', 'perfect 5th', 'minor 6th', 'major 6th', 'minor 7th', 'major 7th'];
  const SHAPES = [
    { id: 'sine', label: 'Sine' },
    { id: 'triangle', label: 'Tri' },
    { id: 'square', label: 'Square' },
    { id: 'saw', label: 'Saw' },
    { id: 'rsaw', label: 'R-Saw' },
    { id: 'noise', label: 'Noise' },
  ];
  const OSC_COLORS = ['#4fc3ff', '#ffb347', '#c58cff'];

  // ---------------------------------------------------------------- state
  const defaultOsc = () => ({ shape: 'sine', coarse: 0, fine: 0, vol: 0.8, pan: 0, phase: 0, invert: false, mute: false, solo: false });

  const state = {
    osc: [
      { ...defaultOsc(), shape: 'saw', vol: 0.8 },
      { ...defaultOsc(), shape: 'square', coarse: -12, vol: 0.5 },
      { ...defaultOsc(), shape: 'sine', coarse: -24, vol: 0.4 },
    ],
    am: false,
    master: 0.6,
    attack: 0.01, decay: 0.3, sustain: 0.8, release: 0.3,
    octave: 4,
    windowMs: 10,
    freeze: false,
    hold: false,
    learn: true,
  };

  let lastNote = 57;          // A3 = 220 Hz; scopes show this note when nothing is playing

  // ---------------------------------------------------------------- maths helpers
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const midiFreq = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const oscCents = (o) => o.coarse * 100 + o.fine;
  const oscFreq = (i, note = lastNote) => midiFreq(note) * Math.pow(2, oscCents(state.osc[i]) / 1200);

  function noteName(n) { return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1); }
  function freqToNote(f) {
    const exact = 69 + 12 * Math.log2(f / 440);
    const n = Math.round(exact);
    return { name: noteName(n), cents: Math.round((exact - n) * 100) };
  }
  const fmtHz = (f) => (f >= 1000 ? (f / 1000).toFixed(2) + ' kHz' : f.toFixed(f < 10 ? 2 : 1) + ' Hz');
  const fmtCents = (c) => (c >= 0 ? '+' : '') + c + '¢';

  function anySolo() { return state.osc.some((o) => o.solo); }
  function audible(i) {
    const o = state.osc[i];
    if (o.mute) return false;
    if (anySolo() && !o.solo) return false;
    return o.vol > 0;
  }
  // Signed level actually sent to the mix (0 when muted, negative when inverted).
  function effLevel(i) {
    const o = state.osc[i];
    if (o.mute || (anySolo() && !o.solo)) return 0;
    return o.vol * (o.invert ? -1 : 1);
  }

  // Sine-series amplitudes b[n] for each shape:  wave(θ) = Σ b[n]·sin(nθ)
  function harmonics(shape) {
    const b = new Float32Array(N_HARM + 1);
    for (let n = 1; n <= N_HARM; n++) {
      const odd = n % 2 === 1;
      switch (shape) {
        case 'sine': b[n] = n === 1 ? 1 : 0; break;
        case 'triangle': b[n] = odd ? (8 / (Math.PI * Math.PI * n * n)) * (((n - 1) / 2) % 2 ? -1 : 1) : 0; break;
        case 'square': b[n] = odd ? 4 / (Math.PI * n) : 0; break;
        case 'saw': b[n] = (2 / (Math.PI * n)) * (odd ? 1 : -1); break;
        case 'rsaw': b[n] = (2 / (Math.PI * n)) * (odd ? 1 : -1) * Math.exp(-(n - 1) / 4); break;
        default: b[n] = 0;
      }
    }
    return b;
  }

  // Lookup table (for drawing) + harmonic list, rebuilt whenever shape or phase changes.
  const tables = [0, 1, 2].map(() => ({ data: new Float32Array(TABLE), b: harmonics('sine'), shape: 'sine' }));
  function rebuildTable(i) {
    const o = state.osc[i];
    const t = tables[i];
    t.shape = o.shape;
    t.b = harmonics(o.shape);
    if (o.shape === 'noise') {
      for (let k = 0; k < TABLE; k++) t.data[k] = Math.random() * 2 - 1;
      return;
    }
    const ph = (o.phase * Math.PI) / 180;
    const last = o.shape === 'sine' ? 1 : N_HARM;
    for (let k = 0; k < TABLE; k++) {
      const th = (2 * Math.PI * k) / TABLE + ph;
      let s = 0;
      for (let n = 1; n <= last; n++) if (t.b[n]) s += t.b[n] * Math.sin(n * th);
      t.data[k] = s;
    }
  }
  // Value of oscillator i's raw wave after `cycles` cycles (fractional part is the position in the cycle).
  function waveAt(i, cycles) {
    if (tables[i].shape === 'noise') return Math.random() * 2 - 1;
    const p = cycles - Math.floor(cycles);
    return tables[i].data[(p * TABLE) | 0];
  }

  // ---------------------------------------------------------------- audio engine
  let actx = null, masterGain, limiter, analyser, noiseBuffer;
  const periodicWaves = [null, null, null];
  const voices = new Map();     // midi note -> Voice
  const pressed = new Set();    // notes physically held down right now

  function ensureAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { alert('Sorry, this browser does not support the Web Audio API.'); return; }
    actx = new AC();
    masterGain = actx.createGain();
    masterGain.gain.value = state.master;
    limiter = actx.createDynamicsCompressor();
    limiter.threshold.value = -6; limiter.knee.value = 6; limiter.ratio.value = 12;
    limiter.attack.value = 0.003; limiter.release.value = 0.15;
    analyser = actx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.6;
    masterGain.connect(limiter).connect(analyser).connect(actx.destination);

    noiseBuffer = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let k = 0; k < d.length; k++) d[k] = Math.random() * 2 - 1;

    for (let i = 0; i < 3; i++) rebuildPeriodicWave(i);
  }

  // Build the Web Audio waveform straight from the same harmonics used for drawing,
  // with the phase offset rotated into each harmonic: sin(n(θ+φ)) = sin nθ·cos nφ + cos nθ·sin nφ
  function rebuildPeriodicWave(i) {
    if (!actx) return;
    const o = state.osc[i];
    const b = harmonics(o.shape === 'noise' ? 'sine' : o.shape);
    const ph = (o.phase * Math.PI) / 180;
    const real = new Float32Array(N_HARM + 1);
    const imag = new Float32Array(N_HARM + 1);
    for (let n = 1; n <= N_HARM; n++) {
      real[n] = b[n] * Math.sin(n * ph);
      imag[n] = b[n] * Math.cos(n * ph);
    }
    periodicWaves[i] = actx.createPeriodicWave(real, imag, { disableNormalization: true });
  }

  class Voice {
    constructor(note, velocity) {
      const t = actx.currentTime;
      this.note = note;
      this.velocity = velocity;
      this.env = actx.createGain();
      this.env.gain.value = 0;
      this.env.connect(masterGain);
      this.amGain = actx.createGain();
      this.amGain.connect(this.env);
      this.slots = [0, 1, 2].map(() => {
        const g = actx.createGain();
        const p = actx.createStereoPanner();
        g.connect(p);
        return { src: null, kind: null, g, p };
      });
      this.slots[0].p.connect(this.amGain);
      this.slots[1].p.connect(this.amGain);
      this.slots[2].p.connect(this.env);
      // All three sources start at exactly the same moment so their phases line up.
      for (let i = 0; i < 3; i++) this.makeSource(i, t);
      this.routeOsc3();
      this.update(true);

      const peak = VOICE_LEVEL * velocity;
      const g = this.env.gain;
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(peak, t + state.attack);
      g.setTargetAtTime(peak * state.sustain, t + state.attack, state.decay / 4 + 0.001);
    }

    makeSource(i, t) {
      const s = this.slots[i];
      const o = state.osc[i];
      if (s.src) { try { s.src.stop(); } catch (e) { /* already stopped */ } s.src.disconnect(); }
      let src;
      if (o.shape === 'noise') {
        src = actx.createBufferSource();
        src.buffer = noiseBuffer;
        src.loop = true;
        src.connect(s.g);
        src.start(t, Math.random() * noiseBuffer.duration);
        s.kind = 'noise';
      } else {
        src = actx.createOscillator();
        src.setPeriodicWave(periodicWaves[i]);
        src.frequency.value = midiFreq(this.note);
        src.detune.value = oscCents(o);
        src.connect(s.g);
        src.start(t);
        s.kind = 'osc';
      }
      s.src = src;
    }

    // Changing shape or phase: oscillators swap their waveform in place; noise <-> tone needs a new source.
    refreshSource(i) {
      const s = this.slots[i];
      const wantNoise = state.osc[i].shape === 'noise';
      if (wantNoise !== (s.kind === 'noise')) this.makeSource(i, actx.currentTime);
      else if (!wantNoise) s.src.setPeriodicWave(periodicWaves[i]);
    }

    routeOsc3() {
      const s = this.slots[2];
      s.g.disconnect();
      if (state.am) s.g.connect(this.amGain.gain);
      else s.g.connect(s.p);
    }

    update(immediate = false) {
      const t = actx.currentTime;
      const set = (param, v) => (immediate ? (param.value = v) : param.setTargetAtTime(v, t, 0.012));
      for (let i = 0; i < 3; i++) {
        const s = this.slots[i];
        const o = state.osc[i];
        const lvl = effLevel(i);
        if (i === 2 && state.am) set(s.g.gain, 0.5 * lvl);
        else set(s.g.gain, lvl);
        set(s.p.pan, o.pan);
        if (s.kind === 'osc') set(s.src.detune, oscCents(o));
      }
      // AM: gain swings between 1 - depth and 1, depth = osc 3 volume.
      set(this.amGain.gain, state.am ? 1 - 0.5 * Math.abs(effLevel(2)) : 1);
    }

    release() {
      if (this.released) return;
      this.released = true;
      const t = actx.currentTime;
      const g = this.env.gain;
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
      else { const v = g.value; g.cancelScheduledValues(t); g.setValueAtTime(v, t); }
      g.setTargetAtTime(0, t, state.release / 4 + 0.001);
      const end = t + state.release * 1.6 + 0.05;
      for (const s of this.slots) { try { s.src.stop(end); } catch (e) { /* ignore */ } }
      setTimeout(() => this.env.disconnect(), (end - t) * 1000 + 200);
    }
  }

  function noteOn(note, velocity = 0.9) {
    ensureAudio();
    if (!actx) return;
    pressed.add(note);
    lastNote = note;
    const old = voices.get(note);
    if (old) old.release();
    voices.set(note, new Voice(note, velocity));
    setKeyDown(note, true);
    refreshReadouts();
  }

  function noteOff(note) {
    pressed.delete(note);
    if (state.hold) return;
    const v = voices.get(note);
    if (v) { v.release(); voices.delete(note); }
    setKeyDown(note, false);
  }

  function releaseUnpressed() {
    for (const [note, v] of voices) {
      if (!pressed.has(note)) { v.release(); voices.delete(note); setKeyDown(note, false); }
    }
  }

  function stopAll() {
    pressed.clear();
    for (const [note, v] of voices) { v.release(); setKeyDown(note, false); }
    voices.clear();
  }

  function updateVoices() { for (const v of voices.values()) v.update(); }

  // ---------------------------------------------------------------- explanations
  const INFO = {
    shape: {
      title: 'Waveform shape',
      body: '<p>The shape of one cycle decides the <b>tone colour</b> (timbre). Any repeating shape is secretly a stack of sine waves at 1×, 2×, 3×… the base frequency — these are called <b>harmonics</b>.</p><p><b>Sine</b>: only the 1st harmonic, pure and soft. <b>Triangle</b>: odd harmonics, very quiet ones — mellow. <b>Square</b>: odd harmonics at 1/n — hollow, woody. <b>Saw</b>: every harmonic at 1/n — bright and buzzy. <b>R-Saw</b> (rounded saw): saw with the high harmonics faded out — softer. <b>Noise</b>: random values, every frequency at once, no pitch.</p>',
      live: (i) => {
        const b = tables[i].b;
        if (state.osc[i].shape === 'noise') return 'noise: no harmonics, energy spread over all frequencies';
        const parts = [];
        for (let n = 1; n <= 6; n++) parts.push(`h${n}=${Math.abs(b[n]).toFixed(3)}`);
        return `wave(θ) = Σ bₙ·sin(n·θ)\n${parts.join('  ')}\nharmonic n sits at n × ${fmtHz(oscFreq(i))}`;
      },
    },
    coarse: {
      title: 'Coarse tune (semitones)',
      body: '<p>Shifts the pitch in semitones — piano-key steps. <b>12 semitones = 1 octave = double the frequency.</b> +7 is a perfect fifth (×1.5), +12 an octave up, −12 an octave down.</p><p>Watch the scope: a higher pitch fits more cycles into the same time window, and the colour moves from blue (low) to red (high).</p>',
      live: (i) => liveFreq(i),
    },
    fine: {
      title: 'Fine tune (cents)',
      body: '<p>A cent is 1/100 of a semitone. Small amounts of fine tune between two oscillators make them drift in and out of step, which you hear as <b>beating</b> or a thick, chorused sound.</p><p>The Mix panel shows the beat rate: two tones that differ by 2 Hz pulse twice a second.</p>',
      live: (i) => liveFreq(i),
    },
    vol: {
      title: 'Volume',
      body: '<p>How much of this oscillator goes into the mix. It scales the height of the wave (the <b>amplitude</b>). In the scopes, louder = taller and thicker line.</p><p>Loudness is roughly logarithmic: halving the volume is about −6 dB, which sounds noticeably but not dramatically quieter.</p>',
      live: (i) => {
        const v = state.osc[i].vol;
        const db = v > 0 ? (20 * Math.log10(v)).toFixed(1) + ' dB' : '−∞ dB (silent)';
        return `level = ${v.toFixed(2)}\nin decibels: 20·log10(${v.toFixed(2)}) = ${db}`;
      },
    },
    pan: {
      title: 'Pan',
      body: '<p>Places the oscillator between the left (−1) and right (+1) speaker. Panning two slightly detuned oscillators to opposite sides is a classic trick for a wide stereo sound.</p>',
      live: (i) => {
        const p = state.osc[i].pan;
        const a = ((p + 1) * Math.PI) / 4;
        return `pan = ${p.toFixed(2)}\nleft gain  = cos(${a.toFixed(2)}) = ${Math.cos(a).toFixed(2)}\nright gain = sin(${a.toFixed(2)}) = ${Math.sin(a).toFixed(2)}`;
      },
    },
    phase: {
      title: 'Phase offset',
      body: '<p>Where in its cycle the wave starts. On its own you cannot hear phase — but when two oscillators play the <b>same pitch</b>, phase decides whether they add up (0°) or cancel each other out (180°).</p><p>Try it: two sines at the same pitch, set one to 180° and the sound disappears.</p>',
      live: (i) => `start point = ${state.osc[i].phase}° of 360°\n= ${(state.osc[i].phase / 360).toFixed(3)} of a cycle\n= ${((state.osc[i].phase / 360) * 1000 / oscFreq(i)).toFixed(3)} ms delay at this pitch`,
    },
    invert: {
      title: 'Invert',
      body: '<p>Flips the wave upside down (multiplies it by −1). Alone it sounds identical. Mixed with an identical, non-inverted copy, the two cancel to <b>silence</b>. This is "polarity" — why a flipped microphone cable can make a sound go thin.</p>',
    },
    mute: { title: 'Mute', body: '<p>Silences this oscillator so you can hear what the others are doing. The scope stays visible but dimmed.</p>' },
    solo: { title: 'Solo', body: '<p>Plays only the soloed oscillator(s). Great for hearing each ingredient on its own before mixing them back together.</p>' },
    am: {
      title: 'Osc 3 as amplitude modulator (AM)',
      body: '<p>Instead of being heard directly, oscillator 3 <b>moves the volume</b> of oscillators 1 and 2 up and down. Osc 3\'s volume knob becomes the modulation <b>depth</b>.</p><p>Slow modulation (below ~20 Hz) sounds like <b>tremolo</b>. Fast modulation creates new frequencies called <b>sidebands</b> at f ± f₃ — metallic, bell-like tones.</p>',
      live: () => {
        const d = Math.abs(effLevel(2));
        return `out = (osc1 + osc2) × (1 − d/2 + d/2 · osc3)\nd = ${d.toFixed(2)}  → volume swings between ${(1 - d).toFixed(2)} and 1.00\nrate = ${fmtHz(oscFreq(2))}`;
      },
    },
    scope: {
      title: 'Oscilloscope',
      body: '<p>Draws the wave: time runs left to right, the height is the air pressure the speaker makes. More cycles across the screen = higher pitch. Taller = louder. Colour = pitch, from <span style="color:#4fc3ff">blue (low)</span> to <span style="color:#ff5050">red (high)</span>.</p><p>It scrolls in slow motion (400× slower than real time) so you can see movement.</p>',
      live: (i) => liveFreq(i),
    },
    harm: {
      title: 'Harmonic fingerprint',
      body: '<p>Each bar is one harmonic: bar 1 is the base frequency, bar 2 is twice it, bar 3 three times, and so on. This is the recipe of sine waves that builds the shape above. More tall bars on the right = brighter sound.</p>',
      live: (i) => INFO.shape.live(i),
    },
    mixScope: {
      title: 'Mix scope',
      body: '<p>The thin coloured lines are the three oscillators; the <b>white line is their sum</b> — the actual wave you hear. Where peaks line up the sum grows (constructive interference); where one is up and another down they cancel (destructive interference).</p><p>Widen the time window to around 1 second to see slow beating appear as the white shape swelling and shrinking.</p>',
    },
    window: {
      title: 'Time window',
      body: '<p>How much time the scopes show across their width. Short windows (a few ms) show the shape of single cycles. Long windows (hundreds of ms) show slow changes such as beating and tremolo.</p>',
      live: () => `window = ${state.windowMs.toFixed(1)} ms\ncycles of A4 (440 Hz) visible = ${(440 * state.windowMs / 1000).toFixed(1)}`,
    },
    freeze: { title: 'Freeze', body: '<p>Stops the scopes from scrolling so you can study the shape. The sound keeps playing.</p>' },
    outScope: {
      title: 'Real output',
      body: '<p>This is measured from the audio actually being produced (after the envelope and the safety limiter), not calculated. It is lined up on each upward zero crossing so repeating waves stand still.</p>',
    },
    spectrum: {
      title: 'Spectrum',
      body: '<p>Splits the sound into its frequencies (an FFT). Left = low, right = high, height = how strong. A sine is one spike; a saw is a row of spikes getting shorter; noise is a flat carpet. The coloured lines mark each oscillator\'s base frequency.</p>',
    },
    attack: { title: 'Attack', body: '<p>Time for a note to fade in from silence to full level. Short = plucky/percussive, long = swelling pads.</p>', live: () => adsrLive() },
    decay: { title: 'Decay', body: '<p>After the attack peak, the time to fall to the sustain level.</p>', live: () => adsrLive() },
    sustain: { title: 'Sustain', body: '<p>The level the note holds at while the key is down (a level, not a time). 0 = the note dies away even while held, like a pluck.</p>', live: () => adsrLive() },
    release: { title: 'Release', body: '<p>Time to fade to silence after you let go of the key.</p>', live: () => adsrLive() },
    master: { title: 'Master volume', body: '<p>Overall output level. A gentle limiter after it stops loud combinations from clipping.</p>' },
    hold: { title: 'Hold', body: '<p>Keeps notes ringing after you let go of the key, so you can use both hands on the controls. Turn Hold off (or press Stop all) to release them.</p>' },
    panic: { title: 'Stop all', body: '<p>Releases every sounding note.</p>' },
  };

  function liveFreq(i) {
    const o = state.osc[i];
    if (o.shape === 'noise') return 'noise has no pitch — tuning does not change it';
    const f0 = midiFreq(lastNote);
    const f = oscFreq(i);
    const nn = freqToNote(f);
    return `note ${noteName(lastNote)} = 440 × 2^((${lastNote} − 69)/12) = ${fmtHz(f0)}\n` +
      `f = ${f0.toFixed(2)} × 2^((${o.coarse} + ${o.fine}/100)/12)\n  = ${fmtHz(f)}  (${nn.name} ${fmtCents(nn.cents)})\n` +
      `period = 1/f = ${(1000 / f).toFixed(3)} ms\nwavelength in air = 343/f = ${(343 / f).toFixed(2)} m`;
  }
  function adsrLive() {
    return `attack ${fmtTime(state.attack)} → decay ${fmtTime(state.decay)} → sustain ${(state.sustain * 100).toFixed(0)}% → release ${fmtTime(state.release)}`;
  }
  function fmtTime(s) { return s < 1 ? (s * 1000).toFixed(0) + ' ms' : s.toFixed(2) + ' s'; }

  let explainKey = null, explainOsc = 0;
  const elTitle = document.getElementById('explainTitle');
  const elBody = document.getElementById('explainBody');
  const elLive = document.getElementById('explainLive');

  function showInfo(key, oscIndex) {
    const info = INFO[key];
    if (!info || !state.learn) return;
    explainKey = key;
    explainOsc = oscIndex ?? 0;
    const prefix = oscIndex != null && key !== 'am' ? `Osc ${oscIndex + 1} — ` : '';
    elTitle.textContent = prefix + info.title;
    elBody.innerHTML = info.body;
    refreshExplainLive();
  }
  function refreshExplainLive() {
    const info = explainKey && INFO[explainKey];
    elLive.textContent = info && info.live ? info.live(explainOsc) : '';
  }
  function hookInfo(root) {
    root.querySelectorAll('[data-info]').forEach((el) => {
      const handler = () => {
        const oscEl = el.closest('.osc');
        showInfo(el.dataset.info, oscEl ? Number(oscEl.dataset.i) : null);
      };
      el.addEventListener('pointerenter', handler);
      el.addEventListener('focusin', handler);
      el.addEventListener('pointerdown', handler);
    });
  }

  // ---------------------------------------------------------------- oscillator panel UI
  const oscRow = document.getElementById('oscRow');
  const oscUI = [];

  const SLIDERS = [
    { key: 'coarse', label: 'Coarse', min: -48, max: 48, step: 1, def: 0, fmt: (v) => (v > 0 ? '+' : '') + v + ' st' },
    { key: 'fine', label: 'Fine', min: -100, max: 100, step: 1, def: 0, fmt: (v) => fmtCents(v) },
    { key: 'vol', label: 'Volume', min: 0, max: 1, step: 0.01, def: 0.8, fmt: (v) => Math.round(v * 100) + '%' },
    { key: 'pan', label: 'Pan', min: -1, max: 1, step: 0.01, def: 0, fmt: (v) => (Math.abs(v) < 0.005 ? 'C' : (v < 0 ? 'L ' : 'R ') + Math.round(Math.abs(v) * 100)) },
    { key: 'phase', label: 'Phase', min: 0, max: 360, step: 1, def: 0, fmt: (v) => v + '°' },
  ];

  function buildOscPanels() {
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('section');
      el.className = 'panel osc';
      el.dataset.i = i;
      el.innerHTML = `
        <div class="panel-head">
          <h2>Osc ${i + 1}</h2>
          <div class="flags">
            <button type="button" class="toggle mute" data-info="mute">M</button>
            <button type="button" class="toggle solo" data-info="solo">S</button>
          </div>
        </div>
        <canvas class="scope" data-info="scope"></canvas>
        <div class="waves" role="group" aria-label="Waveform" data-info="shape">
          ${SHAPES.map((s) => `<button type="button" class="wave-btn" data-shape="${s.id}">${s.label}</button>`).join('')}
        </div>
        <div class="sliders">
          ${SLIDERS.map((s) => `<label data-info="${s.key}">${s.label}<output></output>
            <input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}"></label>`).join('')}
        </div>
        <div class="checks">
          <label data-info="invert"><input type="checkbox" class="invert"> Invert</label>
          ${i === 2 ? '<label data-info="am"><input type="checkbox" class="am"> Use as AM for Osc 1 + 2</label>' : ''}
        </div>
        <div class="harm-wrap learn-only" data-info="harm">
          <div class="cap">Harmonic fingerprint</div>
          <canvas class="scope harm"></canvas>
        </div>
        <div class="readout"></div>`;
      oscRow.appendChild(el);

      const ui = {
        root: el,
        scope: el.querySelector('canvas.scope:not(.harm)'),
        harm: el.querySelector('canvas.harm'),
        readout: el.querySelector('.readout'),
        waveBtns: [...el.querySelectorAll('.wave-btn')],
        sliders: {},
        mute: el.querySelector('.mute'),
        solo: el.querySelector('.solo'),
        invert: el.querySelector('.invert'),
        am: el.querySelector('.am'),
      };
      el.querySelectorAll('input[type=range]').forEach((inp) => {
        const def = SLIDERS.find((s) => s.key === inp.dataset.key);
        ui.sliders[def.key] = { inp, out: inp.parentElement.querySelector('output'), def };
        inp.addEventListener('input', () => setOscParam(i, def.key, Number(inp.value)));
        inp.addEventListener('dblclick', () => setOscParam(i, def.key, def.def));
      });
      ui.waveBtns.forEach((b) => b.addEventListener('click', () => setOscParam(i, 'shape', b.dataset.shape)));
      ui.mute.addEventListener('click', () => setOscParam(i, 'mute', !state.osc[i].mute));
      ui.solo.addEventListener('click', () => setOscParam(i, 'solo', !state.osc[i].solo));
      ui.invert.addEventListener('change', () => setOscParam(i, 'invert', ui.invert.checked));
      if (ui.am) ui.am.addEventListener('change', () => setAM(ui.am.checked));
      oscUI.push(ui);
    }
  }

  function syncOscUI(i) {
    const o = state.osc[i];
    const ui = oscUI[i];
    for (const key in ui.sliders) {
      const s = ui.sliders[key];
      s.inp.value = o[key];
      s.out.textContent = s.def.fmt(o[key]);
    }
    ui.waveBtns.forEach((b) => b.classList.toggle('on', b.dataset.shape === o.shape));
    ui.mute.classList.toggle('on', o.mute);
    ui.solo.classList.toggle('on', o.solo);
    ui.invert.checked = o.invert;
    if (ui.am) ui.am.checked = state.am;
    ui.root.classList.toggle('silent', !audible(i));
  }

  function setOscParam(i, key, value) {
    const o = state.osc[i];
    o[key] = value;
    if (key === 'shape' || key === 'phase') {
      rebuildTable(i);
      rebuildPeriodicWave(i);
      for (const v of voices.values()) v.refreshSource(i);
    }
    updateVoices();
    syncOscUI(i);
    for (let k = 0; k < 3; k++) oscUI[k].root.classList.toggle('silent', !audible(k));
    refreshReadouts();
  }

  function setAM(on) {
    state.am = on;
    for (const v of voices.values()) { v.routeOsc3(); v.update(); }
    syncOscUI(2);
    showInfo('am', 2);
    refreshReadouts();
  }

  // ---------------------------------------------------------------- readouts and analysis
  const analysisEl = document.getElementById('analysis');

  function refreshReadouts() {
    for (let i = 0; i < 3; i++) {
      const o = state.osc[i];
      const ui = oscUI[i];
      if (o.shape === 'noise') {
        ui.readout.innerHTML = `<b>Noise</b> — no pitch · level <b>${Math.round(o.vol * 100)}%</b>`;
        continue;
      }
      const f = oscFreq(i);
      const nn = freqToNote(f);
      const role = i === 2 && state.am ? ' · <b>AM modulator</b>' : '';
      ui.readout.innerHTML = `<b>${fmtHz(f)}</b> · ${nn.name} ${fmtCents(nn.cents)} · period ${(1000 / f).toFixed(2)} ms${role}`;
    }
    refreshAnalysis();
    refreshExplainLive();
  }

  function refreshAnalysis() {
    const cards = [];
    const tonal = [0, 1, 2].filter((i) => audible(i) && state.osc[i].shape !== 'noise' && !(i === 2 && state.am));
    for (let a = 0; a < tonal.length; a++) {
      for (let b = a + 1; b < tonal.length; b++) {
        const i = tonal[a], j = tonal[b];
        const fi = oscFreq(i), fj = oscFreq(j);
        const diff = Math.abs(fi - fj);
        const semis = 12 * Math.log2(Math.max(fi, fj) / Math.min(fi, fj));
        const head = `Osc ${i + 1} + Osc ${j + 1}`;
        if (diff < 0.005) {
          const oi = state.osc[i], oj = state.osc[j];
          let dPhase = (oj.phase - oi.phase + (oi.invert !== oj.invert ? 180 : 0)) % 360;
          if (dPhase < 0) dPhase += 360;
          const both = oi.shape === 'sine' && oj.shape === 'sine';
          let verdict = 'partly reinforce';
          if (dPhase < 5 || dPhase > 355) verdict = 'line up and <b>reinforce</b> (louder)';
          else if (Math.abs(dPhase - 180) < 5) verdict = both || oi.shape === oj.shape ? '<b>cancel</b> each other out' : 'mostly oppose each other';
          else if (dPhase > 90 && dPhase < 270) verdict = 'partly <b>cancel</b>';
          const hot = Math.abs(dPhase - 180) < 5;
          cards.push(`<div class="card${hot ? ' hot' : ''}"><b>${head}</b><br>Same pitch. Phase difference <b>${dPhase.toFixed(0)}°</b> → they ${verdict}.</div>`);
        } else if (diff < 20) {
          cards.push(`<div class="card hot"><b>${head}</b><br>${fmtHz(fi)} vs ${fmtHz(fj)} → <b>beating at ${diff.toFixed(2)} Hz</b>: the volume pulses ${diff.toFixed(1)}× per second (|f₁ − f₂|).</div>`);
        } else {
          const r = Math.round(semis);
          const oct = Math.floor(r / 12);
          const name = INTERVALS[r % 12] === 'unison' && oct > 0 ? (oct === 1 ? 'octave' : oct + ' octaves') : INTERVALS[r % 12] + (oct ? ` + ${oct} oct` : '');
          const off = Math.round((semis - r) * 100);
          cards.push(`<div class="card"><b>${head}</b><br>${semis.toFixed(2)} semitones apart = <b>${name}</b>${off ? ` (${fmtCents(off)})` : ''}<br>frequency ratio ${(Math.max(fi, fj) / Math.min(fi, fj)).toFixed(3)} : 1</div>`);
        }
      }
    }
    if (state.am && audible(2)) {
      const f3 = oscFreq(2);
      const d = Math.abs(effLevel(2));
      const txt = f3 < 20
        ? `Osc 3 at ${fmtHz(f3)} is a <b>tremolo</b>: the volume of Osc 1 + 2 dips ${f3.toFixed(1)}× per second (depth ${Math.round(d * 100)}%).`
        : `Osc 3 at ${fmtHz(f3)} is too fast to hear as wobble, so it creates <b>sidebands</b> at f ± ${fmtHz(f3)} — new, often inharmonic tones.`;
      cards.push(`<div class="card hot"><b>Amplitude modulation</b><br>${txt}</div>`);
    }
    if ([0, 1, 2].some((i) => audible(i) && state.osc[i].shape === 'noise')) {
      cards.push('<div class="card"><b>Noise</b><br>Random values contain every frequency at once — see the flat carpet in the spectrum.</div>');
    }
    if (!cards.length) cards.push('<div class="card">Turn up two oscillators to see how they interact: intervals, beating and cancellation appear here.</div>');
    analysisEl.innerHTML = cards.join('');
  }

  // ---------------------------------------------------------------- canvases
  const canvases = new Map();   // element -> { g, w, h }
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const c = e.target;
      const r = c.getBoundingClientRect();
      const k = dpr();
      c.width = Math.max(1, Math.round(r.width * k));
      c.height = Math.max(1, Math.round(r.height * k));
      const g = c.getContext('2d');
      g.setTransform(k, 0, 0, k, 0, 0);
      canvases.set(c, { g, w: r.width, h: r.height });
    }
    drawEnvelope();
  });
  function watchCanvas(c) { ro.observe(c); }

  // Pitch -> colour: low frequencies blue, high frequencies red.
  function pitchColor(f, alpha = 1) {
    const x = clamp((Math.log2(f) - Math.log2(40)) / (Math.log2(5000) - Math.log2(40)), 0, 1);
    const hue = 220 - 220 * x;
    return `hsla(${hue}, 90%, 62%, ${alpha})`;
  }

  function drawGrid(g, w, h) {
    g.strokeStyle = '#1c2230';
    g.lineWidth = 1;
    g.beginPath();
    for (let k = 1; k < 4; k++) { const y = (h * k) / 4; g.moveTo(0, y); g.lineTo(w, y); }
    for (let k = 1; k < 10; k++) { const x = (w * k) / 10; g.moveTo(x, 0); g.lineTo(x, h); }
    g.stroke();
    g.strokeStyle = '#2c3548';
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
  }

  // Plot fn(t) for t across the window. If the signal is too dense for the pixels,
  // draw its min/max envelope as a filled band instead of an aliased line.
  function plot(g, w, h, fn, t0, win, maxFreq, scale, stroke, lineWidth) {
    const cycles = maxFreq * win;
    const sub = clamp(Math.ceil((cycles * 8) / w), 1, 24);
    const mid = h / 2;
    const amp = (h / 2 - 4) * scale;
    g.strokeStyle = stroke;
    g.lineWidth = lineWidth;
    g.lineJoin = 'round';
    if (sub === 1) {
      g.beginPath();
      for (let x = 0; x <= w; x++) {
        const y = mid - fn(t0 + (x / w) * win) * amp;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      return;
    }
    const top = new Float32Array(w + 1), bot = new Float32Array(w + 1);
    for (let x = 0; x <= w; x++) {
      let lo = Infinity, hi = -Infinity;
      for (let s = 0; s < sub; s++) {
        const v = fn(t0 + ((x + s / sub) / w) * win);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      top[x] = mid - hi * amp;
      bot[x] = mid - lo * amp;
    }
    g.beginPath();
    g.moveTo(0, top[0]);
    for (let x = 1; x <= w; x++) g.lineTo(x, top[x]);
    for (let x = w; x >= 0; x--) g.lineTo(x, bot[x]);
    g.closePath();
    g.fillStyle = stroke;
    g.globalAlpha *= 0.55;
    g.fill();
    g.globalAlpha /= 0.55;
    g.lineWidth = Math.min(lineWidth, 1.2);
    g.stroke();
  }

  function oscSignal(i) {
    const f = oscFreq(i);
    const lvl = state.osc[i].vol * (state.osc[i].invert ? -1 : 1);
    return (t) => waveAt(i, f * t) * lvl;
  }

  function drawOscScope(i, t0) {
    const c = canvases.get(oscUI[i].scope);
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    drawGrid(g, w, h);
    const o = state.osc[i];
    const f = o.shape === 'noise' ? 8000 : oscFreq(i);
    const color = o.shape === 'noise' ? 'rgba(220,220,230,0.9)' : pitchColor(f);
    g.globalAlpha = audible(i) ? 1 : 0.3;
    plot(g, w, h, oscSignal(i), t0, state.windowMs / 1000, f, 0.82, color, 1 + 2.5 * o.vol);
    g.globalAlpha = 1;
    g.fillStyle = '#8a93a8';
    g.font = '11px system-ui, sans-serif';
    const tag = o.shape === 'noise' ? 'noise' : `${fmtHz(f)} · ${(f * state.windowMs / 1000).toFixed(1)} cycles shown`;
    g.fillText(tag, 6, 14);
    if (i === 2 && state.am) g.fillText('AM modulator (not heard directly)', 6, h - 6);
  }

  function drawHarmonics(i) {
    const c = canvases.get(oscUI[i].harm);
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    const o = state.osc[i];
    const bars = 16;
    const bw = w / bars;
    if (o.shape === 'noise') {
      g.fillStyle = 'rgba(200,200,210,0.5)';
      for (let n = 0; n < bars; n++) g.fillRect(n * bw + 1, h * 0.35 + Math.random() * h * 0.2, bw - 2, h);
      return;
    }
    const b = tables[i].b;
    const f = oscFreq(i);
    for (let n = 1; n <= bars; n++) {
      const a = Math.abs(b[n]) / (4 / Math.PI);
      const bh = Math.max(a > 0 ? 2 : 0, a * (h - 4));
      g.fillStyle = pitchColor(f * n, 0.9);
      g.fillRect((n - 1) * bw + 1, h - bh, bw - 2, bh);
    }
  }

  function drawMix(t0) {
    const c = canvases.get(document.getElementById('mixScope'));
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    drawGrid(g, w, h);
    const win = state.windowMs / 1000;
    const lv = [0, 1, 2].map((i) => effLevel(i));
    const fq = [0, 1, 2].map((i) => oscFreq(i));
    const freqs = [0, 1, 2].map((i) => (state.osc[i].shape === 'noise' ? 8000 : fq[i]));
    // Each oscillator's contribution exactly as the audio engine mixes it (mute/solo/invert applied).
    const raw = (i, t) => waveAt(i, fq[i] * t) * lv[i];
    const sum = (t) => {
      let s = raw(0, t) + raw(1, t);
      if (state.am) s *= 1 - 0.5 * Math.abs(lv[2]) + 0.5 * raw(2, t);
      else s += raw(2, t);
      return s;
    };
    // Auto-scale so the sum fits.
    let peak = 0;
    for (let x = 0; x < 200; x++) peak = Math.max(peak, Math.abs(sum(t0 + (x / 200) * win)));
    const scale = 0.9 / Math.max(1, peak);
    const maxF = Math.max(...freqs);
    g.globalAlpha = 0.5;
    for (let i = 0; i < 3; i++) {
      if (!lv[i] && !state.osc[i].vol) continue;
      const color = i === 2 && state.am ? 'rgba(197,140,255,0.6)' : OSC_COLORS[i];
      plot(g, w, h, (t) => raw(i, t), t0, win, freqs[i], scale, color, 1);
    }
    g.globalAlpha = 1;
    plot(g, w, h, sum, t0, win, maxF, scale, '#ffffff', 2.2);
    g.fillStyle = '#8a93a8';
    g.font = '11px system-ui, sans-serif';
    g.fillText(`${state.windowMs < 100 ? state.windowMs.toFixed(1) : Math.round(state.windowMs)} ms across · note ${noteName(lastNote)}${scale < 0.89 ? ` · scaled ×${scale.toFixed(2)} to fit` : ''}`, 6, 14);
  }

  const timeBuf = new Float32Array(2048);
  let freqBuf = null;

  function drawOutput() {
    const c = canvases.get(document.getElementById('outScope'));
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    drawGrid(g, w, h);
    if (!analyser) { msg(g, w, h, 'Play a note to start audio'); return; }
    analyser.getFloatTimeDomainData(timeBuf);
    let start = 0;
    for (let k = 1; k < 1024; k++) if (timeBuf[k - 1] < 0 && timeBuf[k] >= 0) { start = k; break; }
    let peak = 0;
    for (let k = 0; k < timeBuf.length; k++) peak = Math.max(peak, Math.abs(timeBuf[k]));
    if (peak < 0.0005) { msg(g, w, h, 'silence'); return; }
    const n = 1024;
    const scale = 0.9 / Math.max(0.3, peak);
    g.strokeStyle = '#5ee6c4';
    g.lineWidth = 1.6;
    g.beginPath();
    for (let x = 0; x <= w; x++) {
      const v = timeBuf[start + Math.min(n - 1, Math.floor((x / w) * n))];
      const y = h / 2 - v * (h / 2) * scale;
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = '#8a93a8';
    g.font = '11px system-ui, sans-serif';
    g.fillText(`${(1000 * n / actx.sampleRate).toFixed(1)} ms · peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`, 6, 14);
  }

  function drawSpectrum() {
    const c = canvases.get(document.getElementById('spectrum'));
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    const fMin = 20, fMax = 20000;
    const xOf = (f) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * w;
    g.strokeStyle = '#1c2230';
    g.fillStyle = '#5b6478';
    g.font = '10px system-ui, sans-serif';
    g.lineWidth = 1;
    [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach((f) => {
      const x = xOf(f);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x + 2, h - 3);
    });
    for (let i = 0; i < 3; i++) {
      if (!audible(i) || state.osc[i].shape === 'noise') continue;
      const x = xOf(oscFreq(i));
      g.strokeStyle = OSC_COLORS[i];
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      g.setLineDash([]);
    }
    if (!analyser) { msg(g, w, h, 'Play a note to start audio'); return; }
    if (!freqBuf) freqBuf = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freqBuf);
    const binHz = actx.sampleRate / analyser.fftSize;
    const dbMin = -110, dbMax = -10;
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w; x++) {
      const f1 = fMin * Math.pow(fMax / fMin, x / w);
      const f2 = fMin * Math.pow(fMax / fMin, (x + 1) / w);
      let b1 = Math.floor(f1 / binHz), b2 = Math.max(b1 + 1, Math.floor(f2 / binHz));
      let m = -Infinity;
      for (let b = b1; b < b2 && b < freqBuf.length; b++) m = Math.max(m, freqBuf[b]);
      const y = h - clamp((m - dbMin) / (dbMax - dbMin), 0, 1) * (h - 14);
      g.lineTo(x, y);
    }
    g.lineTo(w, h);
    g.closePath();
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(79,140,255,0.75)');
    grad.addColorStop(0.5, 'rgba(94,230,196,0.75)');
    grad.addColorStop(1, 'rgba(255,90,80,0.75)');
    g.fillStyle = grad;
    g.fill();
  }

  function msg(g, w, h, text) {
    g.fillStyle = '#5b6478';
    g.font = '12px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(text, w / 2, h / 2 - 6);
    g.textAlign = 'left';
  }

  function drawEnvelope() {
    const c = canvases.get(document.getElementById('envCanvas'));
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    const hold = 0.5;
    const total = state.attack + state.decay + hold + state.release;
    const X = (t) => 6 + (t / total) * (w - 12);
    const Y = (v) => h - 8 - v * (h - 22);
    const pts = [
      [0, 0], [state.attack, 1], [state.attack + state.decay, state.sustain],
      [state.attack + state.decay + hold, state.sustain], [total, 0],
    ];
    g.beginPath();
    pts.forEach(([t, v], k) => (k ? g.lineTo(X(t), Y(v)) : g.moveTo(X(t), Y(v))));
    g.strokeStyle = '#5ee6c4';
    g.lineWidth = 2;
    g.stroke();
    g.lineTo(X(total), Y(0));
    g.lineTo(X(0), Y(0));
    g.fillStyle = 'rgba(94,230,196,0.12)';
    g.fill();
    g.fillStyle = '#8a93a8';
    g.font = '11px system-ui, sans-serif';
    const lbl = [['A', state.attack / 2], ['D', state.attack + state.decay / 2], ['S', state.attack + state.decay + hold / 2], ['R', state.attack + state.decay + hold + state.release / 2]];
    lbl.forEach(([s, t]) => g.fillText(s, X(t) - 3, 12));
  }

  // ---------------------------------------------------------------- animation loop
  let animTime = 0, lastFrame = performance.now(), frameCount = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!state.freeze) animTime += dt * SLOWMO;
    for (let i = 0; i < 3; i++) {
      drawOscScope(i, animTime);
      if (state.learn && frameCount % 6 === 0) drawHarmonics(i);
    }
    drawMix(animTime);
    drawOutput();
    drawSpectrum();
    frameCount++;
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- global controls
  function bindRange(id, key, fmt, onChange) {
    const inp = document.getElementById(id);
    const out = document.getElementById(id + 'Out');
    inp.value = state[key];
    const apply = () => {
      state[key] = Number(inp.value);
      if (out) out.textContent = fmt(state[key]);
      if (onChange) onChange();
    };
    inp.addEventListener('input', apply);
    apply();
    return { inp, sync: () => { inp.value = state[key]; if (out) out.textContent = fmt(state[key]); } };
  }

  const envControls = [
    bindRange('attack', 'attack', fmtTime, drawEnvelope),
    bindRange('decay', 'decay', fmtTime, drawEnvelope),
    bindRange('sustain', 'sustain', (v) => Math.round(v * 100) + '%', drawEnvelope),
    bindRange('release', 'release', fmtTime, drawEnvelope),
  ];
  bindRange('master', 'master', () => '', () => {
    if (masterGain) masterGain.gain.setTargetAtTime(state.master, actx.currentTime, 0.02);
  });

  // Time window slider is logarithmic: 1 ms .. 1000 ms.
  const winInp = document.getElementById('window');
  const winOut = document.getElementById('windowOut');
  function setWindowMs(ms) {
    state.windowMs = ms;
    winInp.value = Math.log(ms) / Math.log(1000);
    winOut.textContent = ms < 100 ? ms.toFixed(1) + ' ms' : Math.round(ms) + ' ms';
    refreshExplainLive();
  }
  winInp.addEventListener('input', () => {
    state.windowMs = Math.pow(1000, Number(winInp.value));
    winOut.textContent = state.windowMs < 100 ? state.windowMs.toFixed(1) + ' ms' : Math.round(state.windowMs) + ' ms';
    refreshExplainLive();
  });

  const freezeBtn = document.getElementById('freeze');
  freezeBtn.addEventListener('click', () => { state.freeze = !state.freeze; freezeBtn.classList.toggle('on', state.freeze); });

  const holdBtn = document.getElementById('hold');
  function setHold(on) {
    state.hold = on;
    holdBtn.classList.toggle('on', on);
    if (!on) releaseUnpressed();
  }
  holdBtn.addEventListener('click', () => setHold(!state.hold));
  document.getElementById('panic').addEventListener('click', () => { stopAll(); setHold(false); clearLesson(); });

  const modePlay = document.getElementById('modePlay');
  const modeLearn = document.getElementById('modeLearn');
  function setMode(learn) {
    state.learn = learn;
    document.body.classList.toggle('play-mode', !learn);
    modePlay.classList.toggle('on', !learn);
    modeLearn.classList.toggle('on', learn);
  }
  modePlay.addEventListener('click', () => setMode(false));
  modeLearn.addEventListener('click', () => setMode(true));

  // ---------------------------------------------------------------- keyboard
  const kb = document.getElementById('keyboard');
  const octOut = document.getElementById('octOut');
  const keyEls = new Map();   // midi -> element
  const KEYMAP = {
    z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, ',': 12,
    q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24,
  };
  const isBlack = (n) => [1, 3, 6, 8, 10].includes(((n % 12) + 12) % 12);
  const baseNote = () => (state.octave + 1) * 12;

  function buildKeyboard() {
    kb.innerHTML = '';
    keyEls.clear();
    const base = baseNote();
    const notes = [];
    for (let n = base; n <= base + 24; n++) notes.push(n);
    const whites = notes.filter((n) => !isBlack(n));
    const ww = 100 / whites.length;
    let wi = 0;
    for (const n of notes) {
      const el = document.createElement('div');
      el.className = 'key' + (isBlack(n) ? ' black' : '');
      el.dataset.note = n;
      if (isBlack(n)) {
        el.style.left = `calc(${wi * ww}% - ${ww * 0.32}%)`;
        el.style.width = `${ww * 0.64}%`;
      } else {
        wi++;
        if (n % 12 === 0) el.textContent = noteName(n);
      }
      if (voices.has(n)) el.classList.add('down');
      kb.appendChild(el);
      keyEls.set(n, el);
    }
    octOut.textContent = `C${state.octave}`;
  }

  function setKeyDown(note, down) {
    const el = keyEls.get(note);
    if (el) el.classList.toggle('down', down);
  }

  // Pointer play with glissando: drag across keys.
  const pointerNotes = new Map();   // pointerId -> note
  function noteFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    return el && el.classList.contains('key') ? Number(el.dataset.note) : null;
  }
  kb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    kb.setPointerCapture(e.pointerId);
    const n = noteFromPoint(e.clientX, e.clientY);
    if (n != null) { pointerNotes.set(e.pointerId, n); noteOn(n); }
  });
  kb.addEventListener('pointermove', (e) => {
    if (!pointerNotes.has(e.pointerId)) return;
    const n = noteFromPoint(e.clientX, e.clientY);
    const cur = pointerNotes.get(e.pointerId);
    if (n != null && n !== cur) { noteOff(cur); pointerNotes.set(e.pointerId, n); noteOn(n); }
  });
  const endPointer = (e) => {
    const cur = pointerNotes.get(e.pointerId);
    if (cur != null) { noteOff(cur); pointerNotes.delete(e.pointerId); }
  };
  kb.addEventListener('pointerup', endPointer);
  kb.addEventListener('pointercancel', endPointer);

  const keyNotes = new Map();   // key -> note (so octave changes mid-press still release correctly)
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (!(k in KEYMAP)) return;
    const n = baseNote() + KEYMAP[k];
    keyNotes.set(k, n);
    noteOn(n);
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (!keyNotes.has(k)) return;
    noteOff(keyNotes.get(k));
    keyNotes.delete(k);
  });
  window.addEventListener('blur', () => { for (const n of keyNotes.values()) noteOff(n); keyNotes.clear(); });

  document.getElementById('octDown').addEventListener('click', () => { state.octave = clamp(state.octave - 1, 0, 7); buildKeyboard(); });
  document.getElementById('octUp').addEventListener('click', () => { state.octave = clamp(state.octave + 1, 0, 7); buildKeyboard(); });

  // Web MIDI (Chrome/Edge). Silently skipped where unsupported.
  const midiStatus = document.getElementById('midiStatus');
  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess().then((access) => {
      const hook = () => {
        let count = 0;
        access.inputs.forEach((input) => {
          count++;
          input.onmidimessage = (msgEv) => {
            const [st, d1, d2] = msgEv.data;
            const cmd = st & 0xf0;
            if (cmd === 0x90 && d2 > 0) noteOn(d1, d2 / 127);
            else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) noteOff(d1);
          };
        });
        midiStatus.textContent = count ? `MIDI: ${count} input${count > 1 ? 's' : ''}` : 'MIDI: none';
        midiStatus.classList.toggle('dim', !count);
      };
      hook();
      access.onstatechange = hook;
    }).catch(() => { midiStatus.textContent = 'MIDI: blocked'; });
  } else {
    midiStatus.textContent = 'MIDI: n/a';
  }

  // ---------------------------------------------------------------- lessons
  const off = { vol: 0 };
  const LESSONS = [
    {
      title: 'A pure tone',
      osc: [{ shape: 'sine', vol: 0.8 }, off, off],
      windowMs: 10,
      text: '<p>One sine wave: the simplest sound there is. The spectrum shows a <b>single spike</b> — one frequency only.</p><p>Move Osc 1 <b>Coarse</b>: more cycles fit in the window as the pitch rises, and the colour shifts from blue to red. Move <b>Volume</b>: the wave gets taller and thicker.</p>',
    },
    {
      title: 'Harmonics: why a saw sounds buzzy',
      osc: [{ shape: 'saw', vol: 0.8 }, off, off],
      windowMs: 10,
      text: '<p>A saw wave is built from sine waves at 1×, 2×, 3×, 4×… the base frequency. See the <b>row of spikes</b> in the spectrum and the bars in the harmonic fingerprint.</p><p>Click through <b>Sine → Tri → Square → Saw</b>: Square and Tri only have <i>odd</i> harmonics (every other bar is missing), which is why they sound hollow.</p>',
    },
    {
      title: 'Octaves and fifths',
      osc: [{ shape: 'saw', vol: 0.6 }, { shape: 'saw', coarse: -12, vol: 0.5 }, { shape: 'saw', coarse: 7, vol: 0.4 }],
      windowMs: 20,
      text: '<p>Osc 2 is 12 semitones down (half the frequency, ratio 1:2). Osc 3 is 7 semitones up — a perfect fifth, very close to ratio 3:2.</p><p>Simple ratios line their cycles up often, which sounds smooth. The Mix panel names each interval. Try Osc 3 at +6 (tritone) and listen to the tension.</p>',
    },
    {
      title: 'Beating: two nearly equal pitches',
      osc: [{ shape: 'sine', vol: 0.6 }, { shape: 'sine', fine: 16, vol: 0.6 }, off],
      windowMs: 1000,
      text: '<p>Osc 2 is 16 cents sharp of Osc 1 — about 2 Hz apart. The two waves slide in and out of step, so the sum <b>swells and fades about twice a second</b>.</p><p>With a 1 second window you can see the white sum pulse. Move Osc 2 <b>Fine</b> toward 0 and the beating slows; move it away and it speeds up until it becomes a rough, then a two-note sound.</p>',
    },
    {
      title: 'Phase cancellation',
      osc: [{ shape: 'sine', vol: 0.7 }, { shape: 'sine', vol: 0.7, invert: true }, off],
      windowMs: 10,
      text: '<p>Two identical sine waves, but Osc 2 is <b>inverted</b>. Every peak meets a trough, so they add to <b>zero: silence</b>. The white sum line is flat.</p><p>Untick Invert and the sound comes back twice as strong. Or keep it ticked and drag Osc 2 <b>Phase</b> away from 0° to hear the sound gradually return.</p>',
    },
    {
      title: 'Detune for a wide, fat sound',
      osc: [{ shape: 'saw', fine: -12, pan: -0.7, vol: 0.6 }, { shape: 'saw', fine: 12, pan: 0.7, vol: 0.6 }, { shape: 'saw', coarse: -12, vol: 0.5 }],
      windowMs: 200,
      text: '<p>Osc 1 and 2 are detuned in opposite directions and panned left and right. Their slow drift creates the classic thick "supersaw" sound; Osc 3 adds a solid octave below.</p><p>Use headphones and move the <b>Pan</b> sliders to hear the width collapse and return.</p>',
    },
    {
      title: 'Osc 3 as a volume wobbler (AM)',
      osc: [{ shape: 'saw', vol: 0.7 }, off, { shape: 'sine', coarse: -48, vol: 0.9 }],
      am: true,
      windowMs: 500,
      text: '<p>Osc 3 is switched to <b>AM</b>: you do not hear it directly — it moves the volume of Osc 1 up and down. Tuned 4 octaves down it runs at about 14 Hz: a fast <b>tremolo</b>.</p><p>Raise Osc 3 <b>Coarse</b> slowly. Once it passes about 20 Hz you stop hearing a wobble and start hearing new metallic tones (sidebands). Osc 3 <b>Volume</b> sets the depth.</p>',
    },
    {
      title: 'Noise',
      osc: [{ shape: 'sine', vol: 0.5 }, off, { shape: 'noise', vol: 0.25 }],
      windowMs: 10,
      text: '<p>Noise is random — it has no repeating cycle and therefore no pitch. The spectrum shows a <b>flat carpet</b> across all frequencies instead of spikes.</p><p>Mixed quietly under a tone it adds breath or air. Try a short Attack and low Sustain for a percussive "chiff".</p>',
    },
  ];

  const lessonList = document.getElementById('lessonList');
  const lessonText = document.getElementById('lessonText');
  const lessonBtns = LESSONS.map((L, k) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${k + 1}. ${L.title}`;
    b.addEventListener('click', () => startLesson(k));
    li.appendChild(b);
    lessonList.appendChild(li);
    return b;
  });

  function clearLesson() {
    lessonBtns.forEach((b) => b.classList.remove('on'));
    lessonText.innerHTML = '';
  }

  function startLesson(k) {
    const L = LESSONS[k];
    ensureAudio();
    stopAll();
    for (let i = 0; i < 3; i++) {
      state.osc[i] = { ...defaultOsc(), ...L.osc[i] };
      rebuildTable(i);
      rebuildPeriodicWave(i);
    }
    state.am = !!L.am;
    state.attack = 0.05; state.decay = 0.3; state.sustain = 0.9; state.release = 0.4;
    envControls.forEach((c) => c.sync());
    drawEnvelope();
    setWindowMs(L.windowMs);
    for (let i = 0; i < 3; i++) syncOscUI(i);
    setHold(true);
    noteOn(57, 0.9);   // A3, 220 Hz
    pressed.delete(57);
    lessonBtns.forEach((b, j) => b.classList.toggle('on', j === k));
    lessonText.innerHTML = `<h3 style="margin:8px 0 6px;font-size:14px">${k + 1}. ${L.title}</h3>${L.text}<p class="dim small">Press <b>Stop all</b> when you are done.</p>`;
    refreshReadouts();
  }

  // ---------------------------------------------------------------- start
  buildOscPanels();
  for (let i = 0; i < 3; i++) { rebuildTable(i); syncOscUI(i); }
  buildKeyboard();
  hookInfo(document);
  document.querySelectorAll('canvas').forEach(watchCanvas);
  setWindowMs(state.windowMs);
  setMode(true);
  refreshReadouts();
  requestAnimationFrame(frame);
})();
