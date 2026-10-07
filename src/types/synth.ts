import type { Waveform } from '../dsp/synth'

export type ExtendedWaveform = Waveform | 'roundedSaw' | 'noise' | 'custom'

export interface OscillatorSettings {
  waveform: ExtendedWaveform
  invert: boolean
  phaseLeft: number
  phaseRight: number
  detuneCents: number
  coarseSemitones: number
  fineCents: number
  pan: number
  mix: number
  enabled: boolean
}

export interface SynthSettings {
  oscillators: [OscillatorSettings, OscillatorSettings, OscillatorSettings]
  amOsc3: boolean
  hq: boolean
  phaseRandom: number
  master: number
}

export const defaultOscillator = (index: number): OscillatorSettings => ({
  waveform: index === 0 ? 'sine' : index === 1 ? 'triangle' : 'sawtooth',
  invert: false,
  phaseLeft: 0,
  phaseRight: 0,
  detuneCents: 0,
  coarseSemitones: index === 1 ? 12 : index === 2 ? -12 : 0,
  fineCents: 0,
  pan: 0,
  mix: index === 0 ? 1 : 0.5,
  enabled: true,
})

export const defaultSettings: SynthSettings = {
  oscillators: [defaultOscillator(0), defaultOscillator(1), defaultOscillator(2)],
  amOsc3: false,
  hq: true,
  phaseRandom: 0,
  master: 0.55,
}
