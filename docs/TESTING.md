# Testing

## Fast deterministic tests

`npm test` uses Node 22's built-in test runner with type stripping. It covers MIDI frequency conversion, cents ratios, canonical oscillator values, sequential mix semantics, the equal-thirds reference setting and frequency-color direction.

## Production build

`npm run build` type-checks the React application and builds the Vite bundle.

## Browser smoke test

`npm run e2e` uses Playwright to open the production preview and verify the complete learning shell renders all three oscillators and the live-math panel.

## Manual audio checks

Browser audio requires a user gesture. Before release, verify note attack/release, chords, panic, each waveform, inversion cancellation, stereo phase, detune, pan, equal-thirds mixing, AM mode, HQ toggle and phase randomization with headphones at a conservative output level.
