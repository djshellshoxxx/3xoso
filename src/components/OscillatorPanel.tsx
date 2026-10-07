import type { CSSProperties } from 'react'
import { effectiveFrequency, formatHz, rgbCss, spectralColor } from '../dsp/synth'
import type { ExtendedWaveform, OscillatorSettings } from '../types/synth'
import { WaveScope } from './WaveScope'

const shapes: { value: ExtendedWaveform; label: string; glyph: string }[] = [
  { value: 'sine', label: 'Sine', glyph: '∿' },
  { value: 'triangle', label: 'Triangle', glyph: '△' },
  { value: 'square', label: 'Square', glyph: '▱' },
  { value: 'sawtooth', label: 'Saw', glyph: '⟋' },
  { value: 'roundedSaw', label: 'Rounded saw', glyph: '⌁' },
  { value: 'noise', label: 'Noise', glyph: '≋' },
  { value: 'custom', label: 'Custom (sine fallback)', glyph: '◇' },
]

function Range({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void }) {
  return <label className="range-control">
    <span>{label}<output>{value > 0 && min < 0 ? '+' : ''}{Number.isInteger(step) ? value : value.toFixed(2)}{unit}</output></span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
  </label>
}

export function OscillatorPanel({ index, osc, baseFrequency, contribution, update }: { index: number; osc: OscillatorSettings; baseFrequency: number; contribution: number; update: (patch: Partial<OscillatorSettings>) => void }) {
  const frequency = effectiveFrequency(baseFrequency, osc.coarseSemitones, osc.fineCents)
  const color = rgbCss(spectralColor(frequency))
  return <section className="osc-card" style={{ '--osc-color': color } as CSSProperties}>
    <header>
      <div><span className="osc-number">OSC {index + 1}</span><strong>{formatHz(frequency)}</strong></div>
      <label className="toggle"><input type="checkbox" checked={osc.enabled} onChange={(e) => update({ enabled: e.target.checked })} /><span>{osc.enabled ? 'ON' : 'OFF'}</span></label>
    </header>
    <WaveScope osc={osc} baseFrequency={baseFrequency} title={`${shapes.find(s => s.value === osc.waveform)?.label ?? osc.waveform} · ${(contribution * 100).toFixed(0)}% contribution`} contribution={Math.max(.08, contribution)} />
    <div className="shape-row" role="group" aria-label={`Oscillator ${index + 1} waveform`}>
      {shapes.map((shape) => <button key={shape.value} title={shape.label} className={osc.waveform === shape.value ? 'active' : ''} onClick={() => update({ waveform: shape.value })}>{shape.glyph}<small>{shape.label}</small></button>)}
    </div>
    <div className="control-grid">
      <Range label="Coarse" value={osc.coarseSemitones} min={-24} max={24} step={1} unit=" st" onChange={(coarseSemitones) => update({ coarseSemitones })} />
      <Range label="Fine" value={osc.fineCents} min={-100} max={100} step={1} unit=" ct" onChange={(fineCents) => update({ fineCents })} />
      <Range label="Pan" value={osc.pan} min={-1} max={1} step={.01} unit="" onChange={(pan) => update({ pan })} />
      <Range label="Stereo detune" value={osc.detuneCents} min={-50} max={50} step={1} unit=" ct" onChange={(detuneCents) => update({ detuneCents })} />
      <Range label="Phase L" value={osc.phaseLeft} min={0} max={360} step={1} unit="°" onChange={(phaseLeft) => update({ phaseLeft })} />
      <Range label="Phase R" value={osc.phaseRight} min={0} max={360} step={1} unit="°" onChange={(phaseRight) => update({ phaseRight })} />
      {index > 0 && <Range label="Mix level" value={osc.mix * 100} min={0} max={100} step={1} unit="%" onChange={(mix) => update({ mix: mix / 100 })} />}
      <label className="switch-line"><input type="checkbox" checked={osc.invert} onChange={(e) => update({ invert: e.target.checked })} /><span>Invert phase</span></label>
    </div>
  </section>
}
