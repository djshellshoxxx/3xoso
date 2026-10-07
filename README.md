# 3xOSO

3xOSO is a visual three-oscillator synthesizer and synthesis-learning tool inspired by the workflow of FL Studio's 3x Osc.

The project is built around one rule: **every audible change should also produce an understandable visual and numerical change**.

Each oscillator has a live waveform, numeric parameter readouts, pitch-aware color, level-aware size/thickness, and an optional explanation of the math behind what is happening. A separate master view shows how the three oscillator signals combine, interfere, beat, widen, cancel, and change timbre.

## Project goals

- Preserve the compact three-oscillator workflow that makes 3x Osc useful.
- Rebuild the interaction model around visual learning instead of knob memorization.
- Make pitch, phase, detune, amplitude, panning, and waveform shape immediately visible.
- Show useful real-time formulas and numeric values without requiring DSP knowledge.
- Remain musical and fun enough to use as a real sound-design playground.
- Run efficiently in a browser first, with architecture that can later support a desktop/plugin version.

## Core experience

3xOSO contains three independently visualized oscillators and one combined-output visualization.

The oscillator views show waveform shape, motion, pitch, level, phase, pan, tuning, harmonic character, and contribution to the mix. The master view shows the resulting waveform and can optionally overlay the individual sources.

Low-frequency content trends toward blue. High-frequency content trends toward red. Output level affects waveform height and stroke thickness. Visual behavior is informative rather than decorative.

Three interface levels are planned:

- **Play**: immediate sound design with minimal explanations.
- **Learn**: formulas, parameter explanations, beat-frequency detection, phase/interference cues, and guided examples.
- **Analyze**: deeper metering, spectrum/harmonic inspection, stereo correlation, and comparison tools.

## Reference behavior

The project is inspired by 3x Osc rather than being a graphical clone. The parity target covers its oscillator concepts: sine, triangle, square, saw, rounded saw, noise and custom source options; invert; stereo phase offset; stereo detune; coarse and fine tuning; pan; oscillator mix behavior; Oscillator 3 amplitude modulation; high-quality oscillator mode; and phase randomization.

3xOSO may add educational controls such as solo, mute, freeze, compare, scope triggering, guided challenges, and visual overlays where they improve learning.

## Documentation

- [Product specification](docs/PRODUCT_SPEC.md)
- [Engineering specification](docs/ENGINEERING_SPEC.md)
- [3x Osc parity specification](docs/CONTROL_PARITY.md)
- [UI and interaction wireframe](docs/UI_WIREFRAME.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Feature roadmap](docs/FEATURE_ROADMAP.md)
- [Testing and verification plan](docs/TEST_PLAN.md)

## Recommended implementation

Initial target:

- TypeScript
- React
- Vite
- Web Audio API
- AudioWorklet for synthesis
- Canvas 2D for scopes and educational overlays
- Web MIDI where available

The audio thread and visualization thread remain separated. The UI consumes analysis data from bounded buffers and never blocks audio rendering.

## Scope

The first major release focuses on the synthesizer/oscillator experience. It intentionally does not try to recreate FL Studio's surrounding channel rack, sampler, mixer, effects or full DAW environment.

## Status

Specification and architecture phase.
