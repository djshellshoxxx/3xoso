# 3xOSO

A visual three-oscillator synthesizer and learning tool, inspired by the workflow of FL Studio's 3x Osc.

**Live:** https://djshellshoxxx.github.io/3xoso/

Every knob you turn changes both the sound and a picture of the sound, so you can learn what synthesis is doing by watching and listening.

## What it does

- **Three oscillators**, each with sine, triangle, square, saw, rounded saw and noise shapes, plus coarse tune, fine tune, volume, pan, phase offset, invert, mute and solo.
- **Osc 3 as AM**: oscillator 3 can wobble the volume of oscillators 1 and 2 (tremolo or metallic sidebands).
- **A live scope per oscillator.** More cycles on screen means a higher pitch. Taller and thicker means louder. Colour runs from blue (low) to red (high).
- **Harmonic fingerprint** bars that show the sine-wave recipe behind each shape.
- **Mix scope** that draws the three waves and their sum, so you can see interference, beating and cancellation.
- **Real output scope and spectrum**, measured from the audio itself.
- **Mix analysis** that names the interval between oscillators, the beat rate (|f₁ − f₂|), phase cancellation and AM behaviour.
- **Learn mode**: hover over any control to see what it does and the maths behind it, using the current values. **Play mode** hides the explanations.
- **8 guided lessons**: pure tone, harmonics, octaves and fifths, beating, phase cancellation, detune width, AM, and noise.
- **25 presets**: basses (sub, Reese, acid, wobble, drop), pads, leads, keys and plucks, and FX (riser, laser, wind, gate). Each one comes with a demo pattern.
- **Low-pass filter** with resonance and an envelope amount, plus a global **pitch bend**.
- **Fixed Hz mode** per oscillator: set the speed directly, from 0.1 Hz (an LFO) to 8 kHz. A spinning **speed wheel** and a frequency-zone map show how fast each oscillator is going.
- **Pitch-coloured panels**: an oscillator's panel turns darker and bluer as its pitch drops, and lighter and redder as it rises.
- **16-step sequencer** with tempo, note length and root note.
- **Loop** of 1, 2 or 4 bars (or one-shot), drawn as a **spinning ring** with a loop counter and a flash on each repeat.
- **Two automation lanes**: draw a curve or pick a shape. They can drive the filter, pitch, volumes, pans or Fixed Hz, and the knob being moved glows and moves on its own. There are one-click **filter sweep, bass drop, riser and wobble** macros.
- ADSR envelope, on-screen keyboard, computer-keyboard playing (`Z`–`M`, `Q`–`I`), Space to start and stop playback, Hold, and Web MIDI input in Chrome or Edge.

## Running it

It is a static site with no build step: `index.html`, `style.css` and `app.js`.

- **Locally:** open `index.html` in a browser.
- **GitHub Pages:** `.github/workflows/pages.yml` publishes the site on every push to `main`. If it's not live yet, go to *Settings → Pages → Build and deployment* and set *Source* to **GitHub Actions**.

## How the sound is made

Each waveform is built as a sum of 64 harmonics (`wave(θ) = Σ bₙ·sin(n·θ)`) and loaded into a Web Audio `PeriodicWave`. The scopes are drawn from the same harmonics, so what you see is exactly what you hear. The phase offset is rotated into each harmonic. All three oscillators of a note start on the same audio sample, so phase cancellation is exact.

## Background docs

The original design notes are in [`docs/`](docs/).
