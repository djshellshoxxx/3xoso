import { useEffect, useRef } from 'react'
import { effectiveFrequency, mix3xOsc, oscillatorSample, rgbCss, spectralColor } from '../dsp/synth'
import type { OscillatorSettings, SynthSettings } from '../types/synth'

const visualSample = (shape: string, phase: number, index: number) => {
  const p = ((phase % 1) + 1) % 1
  if (shape === 'roundedSaw') {
    const saw = 2 * p - 1
    return Math.tanh(saw * 1.7) / Math.tanh(1.7)
  }
  if (shape === 'noise') {
    const x = Math.sin((index + 1) * 12.9898 + Math.floor(phase * 997) * 78.233) * 43758.5453
    return (x - Math.floor(x)) * 2 - 1
  }
  const canonical = shape === 'custom' ? 'sine' : shape
  return oscillatorSample(canonical as 'sine' | 'triangle' | 'square' | 'sawtooth', p)
}

const drawGrid = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
  ctx.strokeStyle = 'rgba(255,255,255,.055)'
  ctx.lineWidth = 1
  for (let x = 0; x <= w; x += w / 8) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
  }
  for (let y = 0; y <= h; y += h / 4) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
  }
}

interface ScopeProps {
  osc?: OscillatorSettings
  settings?: SynthSettings
  baseFrequency: number
  title: string
  contribution?: number
  analyser?: AnalyserNode | null
  combined?: boolean
}

export function WaveScope({ osc, settings, baseFrequency, title, contribution = 1, analyser, combined }: ScopeProps) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let frame = 0
    let raf = 0
    const draw = () => {
      const canvas = ref.current
      if (!canvas) return
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
        canvas.width = Math.floor(rect.width * dpr)
        canvas.height = Math.floor(rect.height * dpr)
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const w = rect.width
      const h = rect.height
      ctx.clearRect(0, 0, w, h)
      drawGrid(ctx, w, h)
      const center = h / 2
      const amp = Math.max(4, h * .38 * contribution)
      const values = new Float32Array(Math.max(64, Math.floor(w)))

      if (combined && analyser) {
        const raw = new Float32Array(analyser.fftSize)
        analyser.getFloatTimeDomainData(raw)
        for (let i = 0; i < values.length; i++) values[i] = raw[Math.floor(i / values.length * raw.length)]
      } else if (combined && settings) {
        const o = settings.oscillators
        for (let i = 0; i < values.length; i++) {
          const p = i / values.length * 2 + frame * .003
          const samples = o.map((item, idx) => item.enabled ? visualSample(item.waveform, p * effectiveFrequency(baseFrequency, item.coarseSemitones, item.fineCents) / baseFrequency, i + idx * 101) * (item.invert ? -1 : 1) : 0)
          values[i] = mix3xOsc(samples[0], samples[1], samples[2], o[1].enabled ? o[1].mix : 0, o[2].enabled ? o[2].mix : 0)
        }
      } else if (osc) {
        const f = effectiveFrequency(baseFrequency, osc.coarseSemitones, osc.fineCents)
        for (let i = 0; i < values.length; i++) {
          const phase = i / values.length * 2 * (f / baseFrequency) + frame * .003 * (f / baseFrequency) + osc.phaseLeft / 360
          values[i] = osc.enabled ? visualSample(osc.waveform, phase, i + frame) * (osc.invert ? -1 : 1) : 0
        }
      }

      const frequency = osc ? effectiveFrequency(baseFrequency, osc.coarseSemitones, osc.fineCents) : baseFrequency
      const color = spectralColor(frequency)
      ctx.shadowBlur = 16
      ctx.shadowColor = rgbCss(color, .55)
      ctx.strokeStyle = combined ? 'rgba(245,248,255,.95)' : rgbCss(color, .98)
      ctx.lineWidth = combined ? 2.6 : 1.5 + contribution * 3.2
      ctx.beginPath()
      for (let i = 0; i < values.length; i++) {
        const x = (i / (values.length - 1)) * w
        const y = center - values[i] * amp
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.shadowBlur = 0
      frame++
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [osc, settings, baseFrequency, contribution, analyser, combined])

  return <div className={`scope ${combined ? 'scope-combined' : ''}`}><span className="scope-label">{title}</span><canvas ref={ref} /></div>
}
