# 3xOSO

3xOSO is a browser-based visual synthesis learning instrument inspired by the oscillator section of FL Studio's 3x Osc. It is built around one rule: every audible change should also produce an understandable visual and numerical change.

Each oscillator has an animated waveform, numeric parameter readouts, pitch-aware color, level-aware size/thickness, and live derived-frequency math. A separate combined scope shows how the three signals interact.

## Current implementation

- Three polyphonic oscillators running in an AudioWorklet.
- Sine, triangle, square, saw, rounded saw and noise generation.
- Custom selector retained for conceptual parity; FL Studio's actual Custom source comes from the separate Channel Sampler and is outside this synth-only scope.
- Invert, stereo phase offsets, stereo detune, coarse tune (-24..+24 semitones), fine tune (-100..+100 cents), pan and Osc 2/3 mix controls.
- Sequential 3x Osc-style mixing: Osc 2 crossfades against Osc 1, then Osc 3 crossfades against the Osc 1+2 result.
- AM OSC 3, phase randomization and HQ 2x sampling mode.
- Animated individual scopes and a final analyser-driven output scope.
- Logarithmic blue-to-red pitch color and contribution-driven waveform height/thickness.
- Learning Mode with live frequency formulas, mix equations and final oscillator contribution percentages.
- Computer-keyboard polyphony and pointer-playable piano.
- Guided learning experiments: equal thirds, phase cancellation, octave stack and wide detune.
- Responsive Circuit Drift Labs visual design.
- Deterministic DSP tests, Playwright browser smoke test, GitHub Actions CI and GitHub Pages deployment workflow.

## Run

```bash
npm install
npm run dev
```

The deterministic DSP tests only require Node 22:

```bash
npm test
```

Production verification:

```bash
npm run build
npm run e2e
```

## Keyboard

`A W S E D F T G Y H U J K` plays C4 through C5 chromatically.

## Architecture

The UI is TypeScript + React + Vite. Audio runs in `public/three-osc-processor.js` as an AudioWorklet. Canvas 2D scopes stay on the UI thread. Pure synthesis math lives in `src/dsp/synth.ts` and is tested independently.

The app is static and deploys under `/3xoso/` on GitHub Pages. It has no backend, account system, telemetry or remote audio service.

## Engineering docs

- [Product specification](docs/specs/001-product-spec.md)
- [Audio/DSP specification](docs/specs/002-audio-dsp-spec.md)
- [Visualization and learning specification](docs/specs/003-visual-learning-spec.md)
- [Controls and interaction specification](docs/specs/004-controls-and-interaction.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Testing](docs/TESTING.md)

## Scope

The first release focuses on the synthesizer/oscillator experience only. It intentionally does not reproduce FL Studio's Channel Rack, sampler, mixer, effects, wrapper or DAW environment.
