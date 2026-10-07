import test from 'node:test'
import assert from 'node:assert/strict'
import { centsToRatio, midiToFrequency, mix3xOsc, oscillatorSample, spectralColor } from '../src/dsp/synth.ts'

test('MIDI note 69 maps to concert A', () => {
  assert.ok(Math.abs(midiToFrequency(69) - 440) < 1e-10)
})

test('1200 cents maps to a 2:1 ratio', () => {
  assert.ok(Math.abs(centsToRatio(1200) - 2) < 1e-10)
})

test('canonical oscillator shapes are deterministic', () => {
  assert.ok(Math.abs(oscillatorSample('sine', 0.25) - 1) < 1e-8)
  assert.equal(oscillatorSample('square', 0.25), 1)
  assert.ok(Math.abs(oscillatorSample('triangle', 0.25) - 1) < 1e-8)
  assert.ok(Math.abs(oscillatorSample('sawtooth', 0.25) + 0.5) < 1e-8)
})

test('3x Osc mixing is sequential and normalized', () => {
  assert.ok(Math.abs(mix3xOsc(1, -1, 1, 0, 0) - 1) < 1e-10)
  assert.ok(Math.abs(mix3xOsc(1, -1, 1, 0.5, 0) - 0) < 1e-10)
  assert.ok(Math.abs(mix3xOsc(1, -1, 1, 0.5, 0.5) - 0.5) < 1e-10)
  assert.ok(Math.abs(mix3xOsc(1, -1, 1, 1, 0) + 1) < 1e-10)
})

test('50% oscillator 2 and one-third oscillator 3 yield equal weights', () => {
  const out1 = mix3xOsc(1, 0, 0, 0.5, 1 / 3)
  const out2 = mix3xOsc(0, 1, 0, 0.5, 1 / 3)
  const out3 = mix3xOsc(0, 0, 1, 0.5, 1 / 3)
  assert.ok(Math.abs(out1 - 1 / 3) < 1e-10)
  assert.ok(Math.abs(out2 - 1 / 3) < 1e-10)
  assert.ok(Math.abs(out3 - 1 / 3) < 1e-10)
})

test('spectral colors move from bass blue to treble red', () => {
  const low = spectralColor(55)
  const high = spectralColor(7040)
  assert.ok(low.b > low.r)
  assert.ok(high.r > high.b)
})
