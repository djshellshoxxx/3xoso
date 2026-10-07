class ThreeOscProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.settings = {
      oscillators: [
        { waveform: 'sine', invert: false, phaseLeft: 0, phaseRight: 0, detuneCents: 0, coarseSemitones: 0, fineCents: 0, pan: 0, mix: 1, enabled: true },
        { waveform: 'triangle', invert: false, phaseLeft: 0, phaseRight: 0, detuneCents: 0, coarseSemitones: 12, fineCents: 0, pan: 0, mix: .5, enabled: true },
        { waveform: 'sawtooth', invert: false, phaseLeft: 0, phaseRight: 0, detuneCents: 0, coarseSemitones: -12, fineCents: 0, pan: 0, mix: .5, enabled: true },
      ],
      amOsc3: false,
      hq: true,
      phaseRandom: 0,
      master: .55,
    }
    this.voices = new Map()
    this.noiseState = 0x12345678
    this.port.onmessage = (event) => this.onMessage(event.data)
  }

  onMessage(msg) {
    if (msg.type === 'settings') this.settings = msg.settings
    if (msg.type === 'noteOn') this.noteOn(msg.note, msg.frequency, msg.velocity ?? 1)
    if (msg.type === 'noteOff') this.noteOff(msg.note)
    if (msg.type === 'panic') this.voices.clear()
  }

  noteOn(note, frequency, velocity) {
    const random = Math.max(0, Math.min(1, this.settings.phaseRandom || 0))
    const phase = () => Math.random() * random
    this.voices.set(note, {
      frequency, velocity, released: false, amp: 0, target: 1,
      phasesL: [phase(), phase(), phase()],
      phasesR: [phase(), phase(), phase()],
    })
  }

  noteOff(note) {
    const voice = this.voices.get(note)
    if (voice) { voice.released = true; voice.target = 0 }
  }

  noise() {
    let x = this.noiseState | 0
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5
    this.noiseState = x | 0
    return x / 2147483648
  }

  wave(shape, phase) {
    const p = ((phase % 1) + 1) % 1
    if (shape === 'sine') return Math.sin(2 * Math.PI * p)
    if (shape === 'triangle') return 1 - 4 * Math.abs(p - .25 - Math.floor(p - .25 + .5))
    if (shape === 'square') return p < .5 ? 1 : -1
    if (shape === 'sawtooth') return 2 * p - 1
    if (shape === 'roundedSaw') {
      const saw = 2 * p - 1
      return Math.tanh(saw * 1.7) / Math.tanh(1.7)
    }
    if (shape === 'noise') return this.noise()
    return Math.sin(2 * Math.PI * p)
  }

  oscSample(voice, osc, index, channel, oversample) {
    if (!osc.enabled) return 0
    const phases = channel === 0 ? voice.phasesL : voice.phasesR
    const stereoDetune = osc.detuneCents * (channel === 0 ? -1 : 1)
    const cents = osc.coarseSemitones * 100 + osc.fineCents + stereoDetune
    const frequency = voice.frequency * Math.pow(2, cents / 1200)
    const phaseOffset = (channel === 0 ? osc.phaseLeft : osc.phaseRight) / 360
    const current = phases[index]
    const step = frequency / sampleRate / oversample
    let sum = 0
    for (let k = 0; k < oversample; k++) sum += this.wave(osc.waveform, current + step * k + phaseOffset)
    phases[index] = (current + frequency / sampleRate) % 1
    const inv = osc.invert ? -1 : 1
    const pan = Math.max(-1, Math.min(1, osc.pan || 0))
    const panGain = channel === 0 ? Math.cos((pan + 1) * Math.PI / 4) : Math.sin((pan + 1) * Math.PI / 4)
    return (sum / oversample) * inv * panGain * Math.SQRT2
  }

  mix(voice, channel) {
    const oscs = this.settings.oscillators
    const oversample = this.settings.hq ? 2 : 1
    const a = this.oscSample(voice, oscs[0], 0, channel, oversample)
    const b = this.oscSample(voice, oscs[1], 1, channel, oversample)
    const c = this.oscSample(voice, oscs[2], 2, channel, oversample)
    const m2 = oscs[1].enabled ? Math.max(0, Math.min(1, oscs[1].mix)) : 0
    const m3 = oscs[2].enabled ? Math.max(0, Math.min(1, oscs[2].mix)) : 0
    const stage12 = a * (1 - m2) + b * m2
    if (this.settings.amOsc3) return stage12 * (0.5 + 0.5 * c)
    return stage12 * (1 - m3) + c * m3
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const left = out[0]
    const right = out[1] || out[0]
    for (let i = 0; i < left.length; i++) {
      let l = 0, r = 0
      for (const [note, voice] of this.voices) {
        const attack = 1 - Math.exp(-1 / (sampleRate * .008))
        const release = 1 - Math.exp(-1 / (sampleRate * .04))
        voice.amp += (voice.target - voice.amp) * (voice.released ? release : attack)
        const gain = voice.amp * voice.velocity * this.settings.master / Math.sqrt(Math.max(1, this.voices.size))
        l += this.mix(voice, 0) * gain
        r += this.mix(voice, 1) * gain
        if (voice.released && voice.amp < .0005) this.voices.delete(note)
      }
      left[i] = Math.tanh(l * 1.25) * .8
      right[i] = Math.tanh(r * 1.25) * .8
    }
    return true
  }
}
registerProcessor('three-osc-processor', ThreeOscProcessor)
