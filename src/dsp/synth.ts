export type Waveform = 'sine' | 'triangle' | 'square' | 'sawtooth'

export type RGB = { r: number; g: number; b: number }

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function midiToFrequency(note: number, a4 = 440): number {
  return a4 * Math.pow(2, (note - 69) / 12)
}

export function centsToRatio(cents: number): number {
  return Math.pow(2, cents / 1200)
}

export function semitonesToRatio(semitones: number): number {
  return Math.pow(2, semitones / 12)
}

export function normalizePhase(phase: number): number {
  return ((phase % 1) + 1) % 1
}

export function oscillatorSample(waveform: Waveform, phase: number): number {
  const p = normalizePhase(phase)
  switch (waveform) {
    case 'sine': return Math.sin(2 * Math.PI * p)
    case 'triangle': return 1 - 4 * Math.abs(p - 0.25 - Math.floor(p - 0.25 + 0.5))
    case 'square': return p < 0.5 ? 1 : -1
    case 'sawtooth': return 2 * p - 1
  }
}

export function normalizedBlend(a: number, b: number, amount: number): number {
  const t = clamp(amount, 0, 1)
  return a * (1 - t) + b * t
}

export function mix3xOsc(osc1: number, osc2: number, osc3: number, osc2Mix: number, osc3Mix: number): number {
  const stage12 = normalizedBlend(osc1, osc2, osc2Mix)
  return normalizedBlend(stage12, osc3, osc3Mix)
}

export function effectiveFrequency(baseHz: number, coarseSemitones: number, fineCents: number): number {
  return baseHz * semitonesToRatio(coarseSemitones) * centsToRatio(fineCents)
}

export function spectralColor(frequencyHz: number): RGB {
  const minHz = 40
  const maxHz = 12000
  const position = clamp((Math.log2(Math.max(frequencyHz, minHz)) - Math.log2(minHz)) / (Math.log2(maxHz) - Math.log2(minHz)), 0, 1)
  return {
    r: Math.round(50 + position * 205),
    g: Math.round(90 + Math.sin(position * Math.PI) * 120),
    b: Math.round(255 - position * 215),
  }
}

export function rgbCss({ r, g, b }: RGB, alpha = 1): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function formatHz(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(2)} kHz`
  return `${value.toFixed(2)} Hz`
}
