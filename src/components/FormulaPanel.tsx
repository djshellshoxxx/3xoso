import { effectiveFrequency, formatHz } from '../dsp/synth'
import type { SynthSettings } from '../types/synth'

export function FormulaPanel({ settings, baseFrequency }: { settings: SynthSettings; baseFrequency: number }) {
  const [a, b, c] = settings.oscillators
  const m2 = b.enabled ? b.mix : 0
  const m3 = c.enabled ? c.mix : 0
  const w1 = a.enabled ? (1 - m2) * (1 - m3) : 0
  const w2 = b.enabled ? m2 * (1 - m3) : 0
  const w3 = c.enabled ? m3 : 0
  return <aside className="formula-panel">
    <div className="eyebrow">LIVE SYNTHESIS MATH</div>
    <h2>What the engine is doing</h2>
    {settings.oscillators.map((osc, i) => <div className="equation" key={i}>
      <code>f{i + 1} = f₀ × 2^(({osc.coarseSemitones}×100 {osc.fineCents >= 0 ? '+' : '−'} {Math.abs(osc.fineCents)}) / 1200)</code>
      <span>{formatHz(baseFrequency)} → <strong>{formatHz(effectiveFrequency(baseFrequency, osc.coarseSemitones, osc.fineCents))}</strong></span>
    </div>)}
    <div className="equation primary"><code>S₁₂ = {(1 - m2).toFixed(2)}S₁ + {m2.toFixed(2)}S₂</code><span>Osc 2 is a normalized ratio: its share rises as Osc 1 falls.</span></div>
    <div className="equation primary"><code>S = {settings.amOsc3 ? 'S₁₂ × (0.5 + 0.5S₃)' : `${(1 - m3).toFixed(2)}S₁₂ + ${m3.toFixed(2)}S₃`}</code><span>{settings.amOsc3 ? 'Osc 3 is acting as an amplitude modulator.' : 'Osc 3 is mixed after the Osc 1 + 2 stage.'}</span></div>
    <div className="weights"><span>Effective mix</span><b>OSC 1 {(w1 * 100).toFixed(1)}%</b><b>OSC 2 {(w2 * 100).toFixed(1)}%</b><b>OSC 3 {(w3 * 100).toFixed(1)}%</b></div>
  </aside>
}
