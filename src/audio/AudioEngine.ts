import { midiToFrequency } from '../dsp/synth'
import type { SynthSettings } from '../types/synth'

export class AudioEngine {
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private analyser: AnalyserNode | null = null
  private activeNotes = new Set<number>()

  async start(settings: SynthSettings): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' })
      await this.context.audioWorklet.addModule(`${import.meta.env.BASE_URL}three-osc-processor.js`)
      this.node = new AudioWorkletNode(this.context, 'three-osc-processor', {
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = 2048
      this.analyser.smoothingTimeConstant = 0.76
      this.node.connect(this.analyser)
      this.analyser.connect(this.context.destination)
    }
    await this.context.resume()
    this.setSettings(settings)
  }

  setSettings(settings: SynthSettings): void {
    this.node?.port.postMessage({ type: 'settings', settings })
  }

  noteOn(note: number, velocity = 1): void {
    if (!this.node || this.activeNotes.has(note)) return
    this.activeNotes.add(note)
    this.node.port.postMessage({ type: 'noteOn', note, frequency: midiToFrequency(note), velocity })
  }

  noteOff(note: number): void {
    if (!this.node || !this.activeNotes.has(note)) return
    this.activeNotes.delete(note)
    this.node.port.postMessage({ type: 'noteOff', note })
  }

  panic(): void {
    this.activeNotes.clear()
    this.node?.port.postMessage({ type: 'panic' })
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser
  }
}
