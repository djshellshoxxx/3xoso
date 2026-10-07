# Visualization and Learning Specification

## Frequency color

Frequency is mapped logarithmically from 40 Hz to 12 kHz. Low frequencies bias blue, the middle band introduces green/cyan, and high frequencies bias red. Log mapping is required because musical pitch perception and semitone spacing are logarithmic.

## Level geometry

Each oscillator's effective final mix contribution controls two redundant visual variables: vertical amplitude and stroke thickness. Redundancy makes the level relation readable even when waveform shape or display size changes.

## Scope animation

Individual scopes are deterministic educational renderings derived from the oscillator parameters. The final combined scope switches to the real Web Audio `AnalyserNode` signal as soon as audio has started. Before audio startup it displays a deterministic calculated preview.

Noise uses a deterministic pseudo-random visual function so the drawing is lively without causing React state churn. Rounded saw uses the same nonlinear shaping curve as the worklet approximation.

## Numeric overlays

Every oscillator header shows derived frequency. Every range control shows its current numerical value and unit. The formula panel displays source values and the evaluated result instead of only symbolic algebra.

## Accessibility

All range controls are native inputs. Waveform selection is a labeled button group. Playable keys are buttons and retain visible text labels. Learning information is duplicated in text and never encoded solely by color.
