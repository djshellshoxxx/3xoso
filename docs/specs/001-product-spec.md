# 3xOSO Product Specification

## Purpose

3xOSO is a synthesis learning instrument whose central rule is that every audible change should have an immediately visible explanation. It reproduces the useful oscillator-level behavior of 3x Osc without copying FL Studio's surrounding Channel Sampler UI.

## Core learning loop

1. The player changes or plays a parameter.
2. The relevant waveform changes immediately.
3. Numeric values reveal the exact parameter and derived frequency.
4. Learning Mode shows the equation causing the change.
5. The player hears the same relationship represented visually.

## Required oscillator model

Each of three oscillators exposes waveform, invert, phase offset per stereo channel, stereo detune, coarse tuning, fine tuning and pan. Oscillators 2 and 3 expose mix level. Oscillator 1 is the base signal and therefore has no mix-level control.

Waveforms are sine, triangle, square, saw, rounded saw and noise. A Custom selector is shown for conceptual parity, but loading an arbitrary Channel Sampler source is outside the synth-only scope.

Global controls are AM OSC 3, HQ and Phase Rand. 3xOSO additionally exposes a master safety level because it runs directly in a browser audio context rather than through FL Studio's mixer.

## Visualization contract

Every oscillator gets a dedicated animated scope. Frequency controls trace hue on a logarithmic low-to-high scale from blue to red. Effective mix contribution controls trace height and stroke width. The final signal has a physically separate combined scope.

The visual representation is explanatory rather than decorative. A disabled oscillator goes flat. Inverting phase flips the trace. Tuning changes both frequency readout and trace density. Mix controls visibly shrink upstream oscillators as downstream oscillators take a larger share.

## Learning Mode

Learning Mode may be toggled without affecting sound. It shows:

- `f = f0 * 2^(cents / 1200)` for every oscillator.
- The Osc 1/Osc 2 blend equation.
- The second-stage Osc 3 blend equation.
- Effective final contribution percentages.
- An AM-specific equation when AM OSC 3 is enabled.

## Guided experiments

The product includes one-click experiments intended to teach a specific relation rather than just provide presets:

- Equal thirds: demonstrates the non-obvious 50% Osc 2 + ~33% Osc 3 settings required for equal final shares.
- Phase cancel: identical oscillators with one inverted demonstrate cancellation.
- Octave stack: separates pitch ratio from waveform shape.
- Wide drift: demonstrates stereo detuning and phase spread.

## Acceptance criteria

A build is acceptable when the three oscillator rows, combined scope, keyboard, Learning Mode and global controls render on desktop and mobile; playing a note creates audio only after user gesture; release ramps prevent hard note-off discontinuities; deterministic DSP tests pass; the production bundle builds; and the browser smoke test confirms the complete learning shell.
