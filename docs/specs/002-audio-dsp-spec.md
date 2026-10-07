# Audio and DSP Specification

## Runtime

Audio synthesis runs in an `AudioWorkletProcessor` so sample generation stays off the UI thread. The UI sends immutable setting snapshots and note messages over the worklet port.

## Pitch

For MIDI note `n`:

`f0 = 440 * 2^((n - 69) / 12)`

For oscillator coarse tuning `s` semitones, fine tuning `c` cents and per-channel stereo detune `d` cents:

`f = f0 * 2^((100s + c + d) / 1200)`

Left and right stereo-detune signs are opposite.

## Mix topology

Let `m2` and `m3` be normalized 0..1 mix values.

`S12 = S1 * (1 - m2) + S2 * m2`

`Sout = S12 * (1 - m3) + S3 * m3`

Therefore final effective weights are:

- `w1 = (1 - m2)(1 - m3)`
- `w2 = m2(1 - m3)`
- `w3 = m3`

At `m2 = 0.5` and `m3 = 1/3`, all three weights equal approximately one third.

## AM OSC 3

When enabled, Osc 3 modulates the amplitude of the Osc 1+2 stage instead of being blended as the third audible layer:

`Sout = S12 * (0.5 + 0.5 * S3)`

The offset keeps modulation unipolar for an immediately understandable teaching mode.

## Stereo

Each oscillator has independent left/right phase offset. Pan uses equal-power channel gains. Stereo detune offsets left and right frequencies in opposite directions.

## Voice management

Voices are keyed by MIDI note. Repeated note-on for an already-active note is ignored by the host engine. Voice level is normalized by the square root of active voice count to reduce abrupt loudness growth during chords.

An 8 ms attack and 40 ms release smooth note edges. The final output passes through a bounded `tanh` soft clip as a last-resort browser safety measure.

## HQ

HQ currently enables 2x internal waveform sampling. This is a first-stage anti-aliasing measure and intentionally does not claim bit-identical parity with FL Studio's proprietary HQ oscillator rendering.

## Determinism

Pure pitch, waveform, mix and color functions live outside the worklet in `src/dsp/synth.ts` and are covered by Node's built-in test runner so the most important math can be verified even without browser dependencies installed.
