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
- **46 presets**: basses (sub, Reese, acid, wobble, drop), pads, leads, keys and plucks, and FX (riser, laser, wind, gate). Each one comes with a demo pattern.
- **Low-pass filter** with resonance and an envelope amount, plus a global **pitch bend**.
- **Fixed Hz mode** per oscillator: set the speed directly, from 0.1 Hz (an LFO) to 8 kHz. A spinning **speed wheel** and a frequency-zone map show how fast each oscillator is going.
- **Pitch-coloured panels**: an oscillator's panel turns darker and bluer as its pitch drops, and lighter and redder as it rises.
- **16-step sequencer** with tempo, note length and root note.
- **Loop** of 1, 2 or 4 bars (or one-shot), drawn as a **spinning ring** with a loop counter and a flash on each repeat.
- **Two automation lanes**: draw a curve or pick a shape. They can drive the filter, pitch, volumes, pans or Fixed Hz, and the knob being moved glows and moves on its own. There are one-click **filter sweep, bass drop, riser and wobble** macros.
- **Gator** (trance gate): 16 drawable steps, 5 gate shapes (square, pluck, swell, triangle, smooth), patterns, 1/4–1/32 speed, depth, length and smoothing. The volume of each gate is drawn as it plays.
- **Echo / Chorus / Delay**: one ping-pong delay with tempo sync, feedback, tone, stereo spread and a wobble LFO. Modes are Chorus, Flanger, Slapback, Echo, Ping-pong and Dub. Each echo is drawn as a tap that lights up as you hear it.
- **Reverb**: convolution reverb with Room, Plate, Hall, Cathedral and Infinite rooms. It shows the decay curve and rings spreading out from each note.
- **Modulators**: two free-running LFOs that can wobble any effect setting, the filter, volumes, pans or an oscillator's speed. Every effect knob can also be driven by the (now three) automation lanes.
- **Signal-chain strip** showing the path oscillators → filter → envelope → gator → echo → reverb → out, glowing with the sound. Click a stage to jump to it.
- **Surprise me & Mutate**: generate a brand-new musical sound, or nudge the current one so it slowly evolves.
- **My sounds**: save sounds in your browser, copy a **share link** that recreates the exact setup, and **record** what you hear to a WAV file.
- **Ear trainer**: listening games for waveforms, intervals and filter brightness, with a picture of the answer and a best-streak score.
- ADSR envelope, on-screen keyboard, computer-keyboard playing (`Z`–`M`, `Q`–`I`), Space to start and stop playback, Hold, and Web MIDI input in Chrome or Edge.

## Running it

It is a static site with no build step: `index.html`, `style.css` and `app.js`.

- **Locally:** open `index.html` in a browser.
- **GitHub Pages:** `.github/workflows/pages.yml` publishes the site on every push to `main`. If it's not live yet, go to *Settings → Pages → Build and deployment* and set *Source* to **GitHub Actions**.

## How the sound is made

Each waveform is built as a sum of 64 harmonics (`wave(θ) = Σ bₙ·sin(n·θ)`) and loaded into a Web Audio `PeriodicWave`. The scopes are drawn from the same harmonics, so what you see is exactly what you hear. The phase offset is rotated into each harmonic. All three oscillators of a note start on the same audio sample, so phase cancellation is exact.

## Part of Circuit Drift Labs

3xOSO is one of the open-source audio tools from [Circuit Drift Labs](https://djshellshoxxx.github.io/circuitdriftlabs/).

## Background docs

The original design notes are in [`docs/`](docs/).
