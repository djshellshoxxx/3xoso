# Architecture

`src/dsp/synth.ts` contains pure deterministic synthesis math used by both tests and visualization.

`public/three-osc-processor.js` is the real-time AudioWorklet processor. It owns voices and oscillator phase state. No React or DOM APIs are used there.

`src/audio/AudioEngine.ts` owns `AudioContext`, the worklet node, analyser and host-side active-note tracking.

`src/components/WaveScope.tsx` owns Canvas rendering. Individual scopes are parameter-derived teaching displays; the combined scope consumes analyser samples after audio startup.

`src/components/OscillatorPanel.tsx` is a stateless parameter editor. `FormulaPanel.tsx` derives equations and final weights. `Keyboard.tsx` contains the physical/computer-key mapping.

`src/App.tsx` owns the authoritative settings state. Setting updates are copied into the worklet through message passing.

The site is static and deploys under `/3xoso/` on GitHub Pages. No backend, account, telemetry or network audio service is required.
