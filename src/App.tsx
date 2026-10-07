import { useEffect, useMemo, useRef, useState } from 'react'
import { AudioEngine } from './audio/AudioEngine'
import { FormulaPanel } from './components/FormulaPanel'
import { Keyboard, keyMap } from './components/Keyboard'
import { OscillatorPanel } from './components/OscillatorPanel'
import { WaveScope } from './components/WaveScope'
import { midiToFrequency } from './dsp/synth'
import { defaultSettings, type OscillatorSettings, type SynthSettings } from './types/synth'
import './styles.css'

function mixContributions(settings: SynthSettings) {
  const [, b, c] = settings.oscillators
  const m2 = b.enabled ? b.mix : 0
  const m3 = c.enabled && !settings.amOsc3 ? c.mix : 0
  return [(1 - m2) * (1 - m3), m2 * (1 - m3), settings.amOsc3 ? 0 : m3]
}

export default function App() {
  const engine = useRef(new AudioEngine())
  const [settings, setSettings] = useState<SynthSettings>(defaultSettings)
  const [started, setStarted] = useState(false)
  const [note, setNote] = useState(60)
  const [active, setActive] = useState<Set<number>>(new Set())
  const [learning, setLearning] = useState(true)
  const baseFrequency = midiToFrequency(note)
  const contributions = useMemo(() => mixContributions(settings), [settings])

  useEffect(() => { if (started) engine.current.setSettings(settings) }, [settings, started])

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
      const mapped = keyMap[event.key.toLowerCase()]
      if (mapped === undefined) return
      event.preventDefault(); void play(mapped)
    }
    const up = (event: KeyboardEvent) => {
      const mapped = keyMap[event.key.toLowerCase()]
      if (mapped === undefined) return
      event.preventDefault(); stop(mapped)
    }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  })

  const ensureAudio = async () => {
    if (!started) { await engine.current.start(settings); setStarted(true) }
  }
  const play = async (n: number) => {
    await ensureAudio(); setNote(n); engine.current.noteOn(n); setActive(prev => new Set(prev).add(n))
  }
  const stop = (n: number) => { engine.current.noteOff(n); setActive(prev => { const next = new Set(prev); next.delete(n); return next }) }
  const applyExperiment = (name: string) => {
    const base = structuredClone(defaultSettings) as SynthSettings
    if (name === 'equal') {
      base.oscillators[0].waveform = 'sine'; base.oscillators[1].waveform = 'triangle'; base.oscillators[2].waveform = 'sawtooth'
      base.oscillators[0].coarseSemitones = 0; base.oscillators[1].coarseSemitones = 0; base.oscillators[2].coarseSemitones = 0
      base.oscillators[1].mix = .5; base.oscillators[2].mix = 1 / 3
    } else if (name === 'cancel') {
      base.oscillators[0].waveform = 'sine'; base.oscillators[1].waveform = 'sine'; base.oscillators[2].enabled = false
      base.oscillators[1].coarseSemitones = 0; base.oscillators[1].fineCents = 0; base.oscillators[1].invert = true; base.oscillators[1].mix = .5
    } else if (name === 'octaves') {
      base.oscillators[0].waveform = 'sawtooth'; base.oscillators[1].waveform = 'sawtooth'; base.oscillators[2].waveform = 'sine'
      base.oscillators[0].coarseSemitones = -12; base.oscillators[1].coarseSemitones = 0; base.oscillators[2].coarseSemitones = 12
      base.oscillators[1].mix = .45; base.oscillators[2].mix = .24
    } else if (name === 'wide') {
      base.oscillators.forEach(o => { o.waveform = 'sawtooth'; o.detuneCents = 9 })
      base.oscillators[0].detuneCents = -7; base.oscillators[1].fineCents = 7; base.oscillators[2].fineCents = -9
      base.oscillators[1].mix = .5; base.oscillators[2].mix = .34; base.phaseRandom = .15
    }
    setSettings(base)
  }

  const updateOsc = (index: number, patch: Partial<OscillatorSettings>) => setSettings(prev => {
    const oscillators = [...prev.oscillators] as SynthSettings['oscillators']
    oscillators[index] = { ...oscillators[index], ...patch }
    return { ...prev, oscillators }
  })

  return <main>
    <header className="hero">
      <div><div className="eyebrow">CIRCUIT DRIFT LABS · VISUAL SYNTHESIS LAB</div><h1>3xOSO <span>three oscillators, made visible</span></h1></div>
      <div className="hero-actions"><button className={learning ? 'active' : ''} onClick={() => setLearning(v => !v)}>Learning {learning ? 'ON' : 'OFF'}</button><button className="panic" onClick={() => { engine.current.panic(); setActive(new Set()) }}>PANIC</button></div>
    </header>

    <section className="master-scope">
      <WaveScope settings={settings} baseFrequency={baseFrequency} title={`COMBINED OUTPUT · root MIDI ${note} · ${baseFrequency.toFixed(2)} Hz`} analyser={engine.current.getAnalyser()} combined />
      <div className="master-controls">
        <label><span>MASTER <output>{Math.round(settings.master * 100)}%</output></span><input type="range" min="0" max="0.9" step="0.01" value={settings.master} onChange={e => setSettings({ ...settings, master: Number(e.target.value) })} /></label>
        <label><span>PHASE RAND <output>{Math.round(settings.phaseRandom * 100)}%</output></span><input type="range" min="0" max="1" step="0.01" value={settings.phaseRandom} onChange={e => setSettings({ ...settings, phaseRandom: Number(e.target.value) })} /></label>
        <label className="inline-check"><input type="checkbox" checked={settings.hq} onChange={e => setSettings({ ...settings, hq: e.target.checked })} />HQ 2×</label>
        <label className="inline-check"><input type="checkbox" checked={settings.amOsc3} onChange={e => setSettings({ ...settings, amOsc3: e.target.checked })} />AM OSC 3</label>
      </div>
    </section>

    <div className="workspace">
      <div className="osc-stack">{settings.oscillators.map((osc, index) => <OscillatorPanel key={index} index={index} osc={osc} baseFrequency={baseFrequency} contribution={contributions[index]} update={patch => updateOsc(index, patch)} />)}</div>
      {learning && <FormulaPanel settings={settings} baseFrequency={baseFrequency} />}
    </div>

    <section className="play-zone">
      <div><div className="eyebrow">PLAY IT</div><h2>{started ? 'Audio engine armed' : 'Press a key to start audio'}</h2><p>Computer keys A–K map chromatically from C4. Chords work. Wave thickness and height track each oscillator’s effective mix contribution.</p></div>
      <div>
        <div className="experiment-row" aria-label="Guided synthesis experiments">
          <button onClick={() => applyExperiment('equal')}><b>Equal thirds</b><span>50% Osc 2 + 33% Osc 3</span></button>
          <button onClick={() => applyExperiment('cancel')}><b>Phase cancel</b><span>Same sine, one inverted</span></button>
          <button onClick={() => applyExperiment('octaves')}><b>Octave stack</b><span>Sub + root + octave</span></button>
          <button onClick={() => applyExperiment('wide')}><b>Wide drift</b><span>Detune the stereo field</span></button>
        </div>
        <Keyboard active={active} noteOn={play} noteOff={stop} />
      </div>
    </section>

    <section className="lab-strip">
      <article><b>COLOR = PITCH</b><span>Low frequencies bias blue. As frequency rises, traces move through cyan/green toward red.</span></article>
      <article><b>SIZE = LEVEL</b><span>Trace height and thickness communicate the oscillator’s current contribution to the normalized mix.</span></article>
      <article><b>SHAPE = TIMBRE</b><span>Switch waveforms while holding a note and watch geometry change with the harmonic character.</span></article>
      <article><b>PHASE = START POINT</b><span>Split left/right phase to see and hear how stereo phase relationships widen or cancel signals.</span></article>
    </section>
  </main>
}
