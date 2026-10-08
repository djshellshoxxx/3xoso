/* 3xOSO — visual 3-oscillator synth.
 * Plain JavaScript + Web Audio API. No build step: open index.html or serve via GitHub Pages.
 *
 * Signal flow per note (voice):
 *   osc1 -> gain -> pan --\
 *                         +--> amGain --> low-pass filter --> envelope --> master --> limiter --> analyser --> speakers
 *   osc2 -> gain -> pan --/       ^                ^
 *   osc3 -> gain -> pan ----------|----------------/           (normal mode)
 *           gain ------------> amGain.gain                     (AM mode: osc 3 wobbles the volume of 1 + 2)
 *
 * Every knob is a "param" in one registry, so the sliders, presets, lessons and
 * automation lanes all read and write the same values.
 */
(() => {
  'use strict';

  // ================================================================ constants
  const N_HARM = 64;          // harmonics used to build each waveform
  const TABLE = 2048;         // samples in the drawing lookup tables
  const SLOWMO = 1 / 400;     // scopes scroll at 1/400 of real time so motion is visible
  const VOICE_LEVEL = 0.3;    // headroom per voice
  const LANE_PTS = 128;       // resolution of an automation lane
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const INTERVALS = ['unison', 'minor 2nd', 'major 2nd', 'minor 3rd', 'major 3rd', 'perfect 4th',
    'tritone', 'perfect 5th', 'minor 6th', 'major 6th', 'minor 7th', 'major 7th'];
  const SHAPES = [
    { id: 'sine', label: 'Sine' },
    { id: 'triangle', label: 'Tri' },
    { id: 'square', label: 'Square' },
    { id: 'saw', label: 'Saw' },
    { id: 'rsaw', label: 'R-Saw' },
    { id: 'noise', label: 'Noise' },
  ];
  const OSC_COLORS = ['#4fc3ff', '#ffb347', '#c58cff'];
  const LANE_COLORS = ['#ff5fa2', '#ffd84f', '#6be0ff'];

  // ================================================================ state
  const defaultOsc = () => ({
    shape: 'sine', coarse: 0, fine: 0, vol: 0.8, pan: 0, phase: 0,
    invert: false, mute: false, solo: false, fixed: false, hz: 2,
  });
  const newLane = (target) => ({ on: false, target, shape: 'sine', cycles: 1, lo: 0.1, hi: 0.9, pts: new Float32Array(LANE_PTS), base: null, cur: null });

  const state = {
    osc: [
      { ...defaultOsc(), shape: 'saw', vol: 0.8 },
      { ...defaultOsc(), shape: 'square', coarse: -12, vol: 0.5 },
      { ...defaultOsc(), shape: 'sine', coarse: -24, vol: 0.4 },
    ],
    am: false,
    master: 0.6,
    attack: 0.01, decay: 0.3, sustain: 0.8, release: 0.3,
    cutoff: 18000, res: 0, fenv: 0, pitch: 0,
    bpm: 120, gate: 0.5, bars: 1, loop: true, seqRoot: 36,
    seq: new Array(16).fill(-1),
    lanes: [newLane('cutoff'), newLane('pitch'), newLane('master')],
    octave: 4,
    windowMs: 10,
    freeze: false,
    hold: false,
    learn: true,
  };

  let lastNote = 57;          // A3 = 220 Hz; scopes show this note when nothing is playing

  // ================================================================ maths helpers
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const frac = (x) => x - Math.floor(x);
  const midiFreq = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const keyCents = (o) => o.coarse * 100 + o.fine + state.pitch * 100;

  function oscFreq(i, note = lastNote) {
    const o = state.osc[i];
    if (o.fixed) return o.hz * Math.pow(2, o.fine / 1200);
    return midiFreq(note) * Math.pow(2, keyCents(o) / 1200);
  }

  function noteName(n) { return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1); }
  function freqToNote(f) {
    const exact = 69 + 12 * Math.log2(f / 440);
    const n = Math.round(exact);
    return { name: noteName(n), cents: Math.round((exact - n) * 100) };
  }
  function fmtHz(f) {
    if (f >= 1000) return (f / 1000).toFixed(2) + ' kHz';
    if (f < 10) return f.toFixed(2) + ' Hz';
    return f.toFixed(1) + ' Hz';
  }
  const fmtCents = (c) => (c >= 0 ? '+' : '') + Math.round(c) + '¢';
  const fmtTime = (s) => (s < 1 ? (s * 1000).toFixed(0) + ' ms' : s.toFixed(2) + ' s');
  const fmtPct = (v) => Math.round(v * 100) + '%';

  function anySolo() { return state.osc.some((o) => o.solo); }
  function audible(i) {
    const o = state.osc[i];
    if (o.mute) return false;
    if (anySolo() && !o.solo) return false;
    return o.vol > 0;
  }
  // Signed level actually sent to the mix (0 when muted, negative when inverted).
  function effLevel(i) {
    const o = state.osc[i];
    if (o.mute || (anySolo() && !o.solo)) return 0;
    return o.vol * (o.invert ? -1 : 1);
  }

  // Pitch -> colours. Low = dark blue, high = light red.
  function pitchPos(f) { return clamp((Math.log2(f) - Math.log2(30)) / (Math.log2(4000) - Math.log2(30)), 0, 1); }
  function pitchColor(f, alpha = 1) {
    const x = pitchPos(f);
    return `hsla(${220 - 220 * x}, 90%, 62%, ${alpha})`;
  }

  // ================================================================ parameter registry
  const PARAMS = {};
  function defParam(key, o) {
    PARAMS[key] = { key, step: 0, log: false, kind: 'voice', ...o };
    PARAMS[key].def = PARAMS[key].get();
  }
  const toNorm = (p, v) => (p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min));
  function fromNorm(p, n) {
    n = clamp(n, 0, 1);
    let v = p.log ? p.min * Math.pow(p.max / p.min, n) : p.min + n * (p.max - p.min);
    if (p.step) v = Math.round(v / p.step) * p.step;
    return clamp(v, p.min, p.max);
  }

  for (let i = 0; i < 3; i++) {
    const o = () => state.osc[i];
    const n = `Osc ${i + 1}`;
    defParam(`o${i}.coarse`, { label: `${n} coarse`, i, kind: 'osc', min: -48, max: 48, step: 1, get: () => o().coarse, set: (v) => { o().coarse = v; }, fmt: (v) => (v > 0 ? '+' : '') + v + ' st' });
    defParam(`o${i}.fine`, { label: `${n} fine tune`, i, kind: 'osc', min: -100, max: 100, step: 1, get: () => o().fine, set: (v) => { o().fine = v; }, fmt: fmtCents });
    defParam(`o${i}.hz`, { label: `${n} fixed Hz (speed)`, i, kind: 'osc', min: 0.1, max: 8000, log: true, get: () => o().hz, set: (v) => { o().hz = v; }, fmt: fmtHz });
    defParam(`o${i}.vol`, { label: `${n} volume`, i, kind: 'osc', min: 0, max: 1, step: 0.01, get: () => o().vol, set: (v) => { o().vol = v; }, fmt: fmtPct });
    defParam(`o${i}.pan`, { label: `${n} pan`, i, kind: 'osc', min: -1, max: 1, step: 0.01, get: () => o().pan, set: (v) => { o().pan = v; }, fmt: (v) => (Math.abs(v) < 0.005 ? 'C' : (v < 0 ? 'L ' : 'R ') + Math.round(Math.abs(v) * 100)) });
    defParam(`o${i}.phase`, { label: `${n} phase`, i, kind: 'wave', min: 0, max: 360, step: 1, get: () => o().phase, set: (v) => { o().phase = v; }, fmt: (v) => v + '°' });
  }
  defParam('master', { label: 'Master volume', kind: 'master', min: 0, max: 1, step: 0.01, get: () => state.master, set: (v) => { state.master = v; }, fmt: fmtPct });
  defParam('cutoff', { label: 'Filter cutoff', min: 30, max: 18000, log: true, get: () => state.cutoff, set: (v) => { state.cutoff = v; }, fmt: fmtHz });
  defParam('res', { label: 'Filter resonance', min: 0, max: 24, step: 0.1, get: () => state.res, set: (v) => { state.res = v; }, fmt: (v) => v.toFixed(1) + ' dB' });
  defParam('fenv', { label: 'Envelope → filter', kind: 'env', min: 0, max: 6, step: 0.1, get: () => state.fenv, set: (v) => { state.fenv = v; }, fmt: (v) => (v ? '+' + v.toFixed(1) + ' oct' : 'off') });
  defParam('pitch', { label: 'Pitch bend', min: -36, max: 12, step: 0, get: () => state.pitch, set: (v) => { state.pitch = v; }, fmt: (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + ' st' });
  defParam('attack', { label: 'Attack', kind: 'env', min: 0.001, max: 4, log: true, get: () => state.attack, set: (v) => { state.attack = v; }, fmt: fmtTime });
  defParam('decay', { label: 'Decay', kind: 'env', min: 0.01, max: 4, log: true, get: () => state.decay, set: (v) => { state.decay = v; }, fmt: fmtTime });
  defParam('sustain', { label: 'Sustain', kind: 'env', min: 0, max: 1, step: 0.01, get: () => state.sustain, set: (v) => { state.sustain = v; }, fmt: fmtPct });
  defParam('release', { label: 'Release', kind: 'env', min: 0.01, max: 6, log: true, get: () => state.release, set: (v) => { state.release = v; }, fmt: fmtTime });
  defParam('bpm', { label: 'Tempo', kind: 'seq', min: 60, max: 180, step: 1, get: () => state.bpm, set: (v) => { state.bpm = v; }, fmt: (v) => v + ' BPM' });
  defParam('gate', { label: 'Note length', kind: 'seq', min: 0.1, max: 1, step: 0.01, get: () => state.gate, set: (v) => { state.gate = v; }, fmt: fmtPct });

  const AUTO_TARGETS = ['cutoff', 'res', 'pitch', 'master',
    'o0.vol', 'o1.vol', 'o2.vol', 'o0.fine', 'o1.fine', 'o2.fine',
    'o0.pan', 'o1.pan', 'o2.pan', 'o0.hz', 'o1.hz', 'o2.hz'];

  const paramUI = {};   // key -> [{ inp, out, label }]
  let dirty = true;
  const markDirty = () => { dirty = true; };

  function applyParam(p, tau) {
    switch (p.kind) {
      case 'osc': updateVoices(tau); break;
      case 'wave':
        rebuildTable(p.i);
        rebuildPeriodicWave(p.i);
        for (const v of activeVoices) v.refreshSource(p.i);
        break;
      case 'voice': updateVoices(tau); break;
      case 'master': if (masterGain) masterGain.gain.setTargetAtTime(state.master, actx.currentTime, tau); break;
      case 'fx': updateFx(tau); break;
      case 'rev': scheduleIR(); updateFx(tau); break;
      default: break;
    }
    if (p.key === 'bpm') applyDelaySync();
    if (p.key === 'dlyTime' && state.dly.sync !== 'off' && Math.abs(state.dly.time - DLY_SYNC[state.dly.sync] * 60 / state.bpm) > 0.002) { state.dly.sync = 'off'; if (fxUI.sync) fxUI.sync.value = 'off'; }
    if (p.i != null && oscUI[p.i]) oscUI[p.i].root.classList.toggle('silent', !audible(p.i));
    markDirty();
  }

  function setParam(key, v, tau = 0.012) {
    const p = PARAMS[key];
    v = clamp(v, p.min, p.max);
    if (p.step) v = Math.round(v / p.step) * p.step;
    p.set(v);
    applyParam(p, tau);
    syncParam(key);
  }

  function syncParam(key) {
    const p = PARAMS[key];
    const list = paramUI[key];
    if (!list) return;
    const v = p.get();
    for (const u of list) {
      u.inp.value = toNorm(p, v);
      if (u.out) u.out.textContent = p.fmt(v);
    }
  }

  function bindParamInputs(root) {
    root.querySelectorAll('input[data-param]').forEach((inp) => {
      const key = inp.dataset.param;
      const p = PARAMS[key];
      inp.min = 0; inp.max = 1; inp.step = 0.001;
      const label = inp.closest('label');
      const out = label ? label.querySelector('output') : null;
      (paramUI[key] = paramUI[key] || []).push({ inp, out, label });
      inp.addEventListener('input', () => setParam(key, fromNorm(p, Number(inp.value))));
      inp.addEventListener('dblclick', () => setParam(key, p.def));
      syncParam(key);
    });
  }

  // ================================================================ waveforms
  // Sine-series amplitudes b[n] for each shape:  wave(θ) = Σ b[n]·sin(nθ)
  function harmonics(shape) {
    const b = new Float32Array(N_HARM + 1);
    for (let n = 1; n <= N_HARM; n++) {
      const odd = n % 2 === 1;
      switch (shape) {
        case 'sine': b[n] = n === 1 ? 1 : 0; break;
        case 'triangle': b[n] = odd ? (8 / (Math.PI * Math.PI * n * n)) * (((n - 1) / 2) % 2 ? -1 : 1) : 0; break;
        case 'square': b[n] = odd ? 4 / (Math.PI * n) : 0; break;
        case 'saw': b[n] = (2 / (Math.PI * n)) * (odd ? 1 : -1); break;
        case 'rsaw': b[n] = (2 / (Math.PI * n)) * (odd ? 1 : -1) * Math.exp(-(n - 1) / 4); break;
        default: b[n] = 0;
      }
    }
    return b;
  }

  // Lookup table (for drawing) + harmonic list, rebuilt whenever shape or phase changes.
  const tables = [0, 1, 2].map(() => ({ data: new Float32Array(TABLE), b: harmonics('sine'), shape: 'sine' }));
  function rebuildTable(i) {
    const o = state.osc[i];
    const t = tables[i];
    t.shape = o.shape;
    t.b = harmonics(o.shape);
    if (o.shape === 'noise') {
      for (let k = 0; k < TABLE; k++) t.data[k] = Math.random() * 2 - 1;
      return;
    }
    const ph = (o.phase * Math.PI) / 180;
    const last = o.shape === 'sine' ? 1 : N_HARM;
    for (let k = 0; k < TABLE; k++) {
      const th = (2 * Math.PI * k) / TABLE + ph;
      let s = 0;
      for (let n = 1; n <= last; n++) if (t.b[n]) s += t.b[n] * Math.sin(n * th);
      t.data[k] = s;
    }
  }
  // Value of oscillator i's raw wave after `cycles` cycles.
  function waveAt(i, cycles) {
    if (tables[i].shape === 'noise') return Math.random() * 2 - 1;
    return tables[i].data[(frac(cycles) * TABLE) | 0];
  }

  // ================================================================ audio engine
  let actx = null, masterGain, limiter, analyser, noiseBuffer;
  const periodicWaves = [null, null, null];
  const voices = new Map();       // keyboard voices: midi note -> Voice
  const activeVoices = new Set(); // every sounding voice (keyboard, sequencer, drones)
  const pressed = new Set();      // notes physically held down right now

  function ensureAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume(); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { alert('Sorry, this browser does not support the Web Audio API.'); return false; }
    actx = new AC();
    masterGain = actx.createGain();
    masterGain.gain.value = state.master;
    limiter = actx.createDynamicsCompressor();
    limiter.threshold.value = -6; limiter.knee.value = 6; limiter.ratio.value = 12;
    limiter.attack.value = 0.003; limiter.release.value = 0.15;
    analyser = actx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.6;
    masterGain.connect(limiter).connect(analyser).connect(actx.destination);

    noiseBuffer = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let k = 0; k < d.length; k++) d[k] = Math.random() * 2 - 1;

    for (let i = 0; i < 3; i++) rebuildPeriodicWave(i);
    buildFxGraph();
    gateRestart();
    return true;
  }

  // Build the Web Audio waveform from the same harmonics used for drawing,
  // with the phase offset rotated into each harmonic: sin(n(θ+φ)) = sin nθ·cos nφ + cos nθ·sin nφ
  function rebuildPeriodicWave(i) {
    if (!actx) return;
    const o = state.osc[i];
    const b = harmonics(o.shape === 'noise' ? 'sine' : o.shape);
    const ph = (o.phase * Math.PI) / 180;
    const real = new Float32Array(N_HARM + 1);
    const imag = new Float32Array(N_HARM + 1);
    for (let n = 1; n <= N_HARM; n++) {
      real[n] = b[n] * Math.sin(n * ph);
      imag[n] = b[n] * Math.cos(n * ph);
    }
    periodicWaves[i] = actx.createPeriodicWave(real, imag, { disableNormalization: true });
  }

  // Freeze an AudioParam at `when` so a new ramp can start from there.
  function holdAt(param, when, estimate) {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(when);
    else { param.cancelScheduledValues(when); param.setValueAtTime(estimate, when); }
  }

  class Voice {
    constructor(note, velocity = 0.9, when) {
      const t = Math.max(when ?? actx.currentTime, actx.currentTime);
      this.note = note;
      this.velocity = velocity;
      this.t0 = t;
      lastHit = t;
      this.A = state.attack; this.D = state.decay; this.S = state.sustain; this.R = state.release;
      this.fAmt = state.fenv * 1200;
      this.relAt = null;
      this.end = null;

      this.env = actx.createGain();
      this.env.gain.value = 0;
      this.env.connect(fx.bus);
      this.filter = actx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.connect(this.env);
      this.amGain = actx.createGain();
      this.amGain.connect(this.filter);
      this.slots = [0, 1, 2].map(() => {
        const g = actx.createGain();
        const p = actx.createStereoPanner();
        g.connect(p);
        return { src: null, kind: null, g, p };
      });
      this.slots[0].p.connect(this.amGain);
      this.slots[1].p.connect(this.amGain);
      this.slots[2].p.connect(this.filter);
      // All three sources start at exactly the same moment so their phases line up.
      for (let i = 0; i < 3; i++) this.makeSource(i, t);
      this.routeOsc3();
      this.update(0, true);

      const peak = VOICE_LEVEL * velocity;
      const g = this.env.gain;
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(peak, t + this.A);
      g.setTargetAtTime(peak * this.S, t + this.A, this.D / 4 + 0.001);
      const fd = this.filter.detune;
      fd.setValueAtTime(0, t);
      if (this.fAmt > 0) {
        fd.linearRampToValueAtTime(this.fAmt, t + this.A);
        fd.setTargetAtTime(this.fAmt * this.S, t + this.A, this.D / 4 + 0.001);
      }
      activeVoices.add(this);
    }

    // Envelope level 0..1 at audio time t, mirrored in JS so the visuals can follow it.
    shape(t, ignoreRelease = false) {
      if (t < this.t0) return 0;
      const dt = t - this.t0;
      let e = dt < this.A ? dt / this.A : this.S + (1 - this.S) * Math.exp(-(dt - this.A) / (this.D / 4 + 0.001));
      if (!ignoreRelease && this.relAt != null && t >= this.relAt) {
        e = this.relLevel * Math.exp(-(t - this.relAt) / (this.R / 4 + 0.001));
      }
      return e;
    }

    makeSource(i, t) {
      const s = this.slots[i];
      const o = state.osc[i];
      if (s.src) { try { s.src.stop(); } catch (e) { /* already stopped */ } s.src.disconnect(); }
      let src;
      if (o.shape === 'noise') {
        src = actx.createBufferSource();
        src.buffer = noiseBuffer;
        src.loop = true;
        src.connect(s.g);
        src.start(t, Math.random() * noiseBuffer.duration);
        s.kind = 'noise';
      } else {
        src = actx.createOscillator();
        src.setPeriodicWave(periodicWaves[i]);
        if (o.fixed) { src.frequency.value = o.hz; src.detune.value = o.fine; }
        else { src.frequency.value = midiFreq(this.note); src.detune.value = keyCents(o); }
        src.connect(s.g);
        src.start(t);
        s.kind = 'osc';
      }
      if (this.end != null) { try { src.stop(this.end); } catch (e) { /* ignore */ } }
      s.src = src;
    }

    // Changing shape or phase: oscillators swap their waveform in place; noise <-> tone needs a new source.
    refreshSource(i) {
      const s = this.slots[i];
      const wantNoise = state.osc[i].shape === 'noise';
      if (wantNoise !== (s.kind === 'noise')) this.makeSource(i, Math.max(actx.currentTime, this.t0));
      else if (!wantNoise) s.src.setPeriodicWave(periodicWaves[i]);
    }

    routeOsc3() {
      const s = this.slots[2];
      s.g.disconnect();
      if (state.am) s.g.connect(this.amGain.gain);
      else s.g.connect(s.p);
    }

    update(tau = 0.012, immediate = false) {
      const t = actx.currentTime;
      const set = (param, v) => (immediate ? (param.value = v) : param.setTargetAtTime(v, t, tau));
      for (let i = 0; i < 3; i++) {
        const s = this.slots[i];
        const o = state.osc[i];
        const lvl = effLevel(i);
        set(s.g.gain, i === 2 && state.am ? 0.5 * lvl : lvl);
        set(s.p.pan, o.pan);
        if (s.kind === 'osc') {
          if (o.fixed) { set(s.src.frequency, o.hz); set(s.src.detune, o.fine); }
          else { set(s.src.frequency, midiFreq(this.note)); set(s.src.detune, keyCents(o)); }
        }
      }
      // AM: gain swings between 1 - depth and 1, depth = osc 3 volume.
      set(this.amGain.gain, state.am ? 1 - 0.5 * Math.abs(effLevel(2)) : 1);
      set(this.filter.frequency, state.cutoff);
      set(this.filter.Q, state.res);
    }

    release(when) {
      const now = actx.currentTime;
      when = Math.max(when ?? now, now);
      if (this.relAt != null && this.relAt <= when) return;
      const e = this.shape(when, true);
      this.relAt = when;
      this.relLevel = e;
      this.R = state.release;
      const peak = VOICE_LEVEL * this.velocity;
      holdAt(this.env.gain, when, e * peak);
      this.env.gain.setTargetAtTime(0, when, this.R / 4 + 0.001);
      holdAt(this.filter.detune, when, e * this.fAmt);
      this.filter.detune.setTargetAtTime(0, when, this.R / 4 + 0.001);
      this.end = when + this.R * 1.6 + 0.05;
      for (const s of this.slots) { try { s.src.stop(this.end); } catch (err) { /* ignore */ } }
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.dispose(), (this.end - now) * 1000 + 250);
    }

    dispose() {
      this.env.disconnect();
      activeVoices.delete(this);
    }
  }

  const CHORDS = { off: [0], major: [0, 4, 7], minor: [0, 3, 7], sus4: [0, 5, 7], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], power: [0, 7, 12], octaves: [0, 12, -12] };
  let chordName = 'off', inChord = false;
  function noteOn(note, velocity = 0.9) {
    if (!inChord && chordName !== 'off') {
      inChord = true;
      try { CHORDS[chordName].forEach((iv) => noteOn(note + iv, velocity)); } finally { inChord = false; }
      return;
    }
    if (!ensureAudio()) return;
    pressed.add(note);
    lastNote = note;
    const old = voices.get(note);
    if (old) old.release();
    voices.set(note, new Voice(note, velocity));
    setKeyDown(note, true);
    markDirty();
  }

  function noteOff(note) {
    if (!inChord && chordName !== 'off') {
      inChord = true;
      try { CHORDS[chordName].forEach((iv) => noteOff(note + iv)); } finally { inChord = false; }
      return;
    }
    pressed.delete(note);
    if (state.hold) return;
    const v = voices.get(note);
    if (v) { v.release(); voices.delete(note); }
    setKeyDown(note, false);
  }

  function releaseUnpressed() {
    for (const [note, v] of voices) {
      if (!pressed.has(note)) { v.release(); voices.delete(note); setKeyDown(note, false); }
    }
  }

  function stopAll() {
    pressed.clear();
    for (const note of voices.keys()) setKeyDown(note, false);
    voices.clear();
    if (actx) for (const v of activeVoices) v.release();
    transport.drone = null;
  }

  function updateVoices(tau = 0.012) { if (actx) for (const v of activeVoices) v.update(tau); }

  // Loudest envelope right now (0..1) — drives how big and bright the scopes are.
  function liveEnvelope() {
    if (!actx) return 0;
    const t = actx.currentTime;
    let m = 0;
    for (const v of activeVoices) m = Math.max(m, v.shape(t) * v.velocity);
    return clamp(m, 0, 1);
  }

  // ================================================================ explanations
  const INFO = {
    presets: {
      title: 'Presets',
      body: '<p>Ready-made settings for all the knobs. Every preset here is built only from the three oscillators, the filter and the envelope — the same controls you can see below. Load one, then look at how its oscillators, filter and automation are set up.</p><p><b>Basses</b> live low and usually use saws/squares under a low-pass filter. <b>Pads</b> use slow attack and release and slightly detuned oscillators. <b>Leads</b> are bright and cut through. <b>Plucks &amp; keys</b> use a fast decay with zero sustain. <b>FX</b> rely on noise and automation.</p>',
    },
    demo: { title: 'Play demo pattern', body: '<p>When ticked, loading a preset also loads a short sequencer pattern, tempo and automation chosen for that sound, and starts playing it so you hear it straight away.</p>' },
    shape: {
      title: 'Waveform shape',
      body: '<p>The shape of one cycle decides the <b>tone colour</b> (timbre). Any repeating shape is secretly a stack of sine waves at 1×, 2×, 3×… the base frequency — these are called <b>harmonics</b>.</p><p><b>Sine</b>: only the 1st harmonic, pure and soft. <b>Triangle</b>: odd harmonics, very quiet ones — mellow. <b>Square</b>: odd harmonics at 1/n — hollow, woody. <b>Saw</b>: every harmonic at 1/n — bright and buzzy. <b>R-Saw</b> (rounded saw): saw with the high harmonics faded out — softer. <b>Noise</b>: random values, every frequency at once, no pitch.</p>',
      live: (i) => {
        const b = tables[i].b;
        if (state.osc[i].shape === 'noise') return 'noise: no harmonics, energy spread over all frequencies';
        const parts = [];
        for (let n = 1; n <= 6; n++) parts.push(`h${n}=${Math.abs(b[n]).toFixed(3)}`);
        return `wave(θ) = Σ bₙ·sin(n·θ)\n${parts.join('  ')}\nharmonic n sits at n × ${fmtHz(oscFreq(i))}`;
      },
    },
    fixed: {
      title: 'Follow keyboard vs Fixed Hz',
      body: '<p><b>Follow keyboard</b>: the oscillator follows the notes you play (plus Coarse/Fine).</p><p><b>Fixed Hz</b>: you set the speed directly in hertz (vibrations per second), from 0.1 Hz to 8 kHz, and it ignores the keyboard. Below about 20 Hz an oscillator is too slow to hear as a pitch — it becomes an <b>LFO</b> (low-frequency oscillator). Put Osc 3 on Fixed Hz at 2–8 Hz and tick “Use as AM” for a wobble.</p>',
      live: (i) => liveFreq(i),
    },
    hz: {
      title: 'Frequency (speed of the oscillation)',
      body: '<p>How many times per second the wave repeats. Watch the spinning wheel: each turn of the wheel is one cycle of the wave. Faster wheel, higher pitch. The bar shows which zone the speed is in: below 20 Hz you feel a rhythm (LFO), 20–250 Hz is bass, 250 Hz–2 kHz is the middle, above that is treble.</p>',
      live: (i) => liveFreq(i),
    },
    speed: {
      title: 'Speed wheel',
      body: '<p>The arm goes round once for every cycle of the wave — this is how sine waves are born: the height of a point on a spinning wheel, drawn over time. The wheel is slowed down so you can see it (the real speed is written next to it), but faster always means faster.</p><p>The coloured bar is a map of all frequencies; the marker shows where this oscillator sits.</p>',
      live: (i) => liveFreq(i),
    },
    coarse: {
      title: 'Coarse tune (semitones)',
      body: '<p>Shifts the pitch in semitones — piano-key steps. <b>12 semitones = 1 octave = double the frequency.</b> +7 is a perfect fifth (×1.5), +12 an octave up, −12 an octave down.</p><p>Watch the scope: a higher pitch fits more cycles into the same time window, the speed wheel spins faster, and the panel turns from dark blue (low) to light red (high).</p>',
      live: (i) => liveFreq(i),
    },
    fine: {
      title: 'Fine tune (cents)',
      body: '<p>A cent is 1/100 of a semitone. Small amounts of fine tune between two oscillators make them drift in and out of step, which you hear as <b>beating</b> or a thick, chorused sound.</p><p>The Mix panel shows the beat rate: two tones that differ by 2 Hz pulse twice a second.</p>',
      live: (i) => liveFreq(i),
    },
    vol: {
      title: 'Volume',
      body: '<p>How much of this oscillator goes into the mix. It scales the height of the wave (the <b>amplitude</b>). In the scope, louder = a bigger, thicker, brighter line. While a note is playing the wave also swells and shrinks with the envelope.</p><p>Loudness is roughly logarithmic: halving the volume is about −6 dB.</p>',
      live: (i) => {
        const v = state.osc[i].vol;
        const db = v > 0 ? (20 * Math.log10(v)).toFixed(1) + ' dB' : '−∞ dB (silent)';
        return `level = ${v.toFixed(2)}\nin decibels: 20·log10(${v.toFixed(2)}) = ${db}`;
      },
    },
    pan: {
      title: 'Pan',
      body: '<p>Places the oscillator between the left (−1) and right (+1) speaker. Panning two slightly detuned oscillators to opposite sides is a classic trick for a wide stereo sound.</p>',
      live: (i) => {
        const p = state.osc[i].pan;
        const a = ((p + 1) * Math.PI) / 4;
        return `pan = ${p.toFixed(2)}\nleft gain  = cos(${a.toFixed(2)}) = ${Math.cos(a).toFixed(2)}\nright gain = sin(${a.toFixed(2)}) = ${Math.sin(a).toFixed(2)}`;
      },
    },
    phase: {
      title: 'Phase offset',
      body: '<p>Where in its cycle the wave starts. On its own you cannot hear phase — but when two oscillators play the <b>same pitch</b>, phase decides whether they add up (0°) or cancel each other out (180°).</p>',
      live: (i) => `start point = ${state.osc[i].phase}° of 360°\n= ${(state.osc[i].phase / 360).toFixed(3)} of a cycle\n= ${((state.osc[i].phase / 360) * 1000 / oscFreq(i)).toFixed(3)} ms delay at this pitch`,
    },
    invert: {
      title: 'Invert',
      body: '<p>Flips the wave upside down (multiplies it by −1). Alone it sounds identical. Mixed with an identical, non-inverted copy, the two cancel to <b>silence</b>.</p>',
    },
    mute: { title: 'Mute', body: '<p>Silences this oscillator so you can hear what the others are doing.</p>' },
    solo: { title: 'Solo', body: '<p>Plays only the soloed oscillator(s).</p>' },
    am: {
      title: 'Osc 3 as amplitude modulator (AM)',
      body: '<p>Instead of being heard directly, oscillator 3 <b>moves the volume</b> of oscillators 1 and 2 up and down. Osc 3’s volume knob becomes the modulation <b>depth</b>.</p><p>Slow modulation (below ~20 Hz — try Fixed Hz) sounds like <b>tremolo</b> or a wobble. Fast modulation creates new frequencies called <b>sidebands</b> at f ± f₃ — metallic, bell-like tones.</p>',
      live: () => {
        const d = Math.abs(effLevel(2));
        return `out = (osc1 + osc2) × (1 − d/2 + d/2 · osc3)\nd = ${d.toFixed(2)}  → volume swings between ${(1 - d).toFixed(2)} and 1.00\nrate = ${fmtHz(oscFreq(2))}`;
      },
    },
    scope: {
      title: 'Oscilloscope',
      body: '<p>Draws the wave: time runs left to right, the height is the air pressure the speaker makes. More cycles across the screen = higher pitch. Bigger and thicker = louder.</p><p>The background colour follows the pitch: <b>darker and bluer</b> as it goes down, <b>lighter and redder</b> as it goes up. It scrolls in slow motion (400× slower than real time).</p>',
      live: (i) => liveFreq(i),
    },
    harm: {
      title: 'Harmonic fingerprint',
      body: '<p>Each bar is one harmonic: bar 1 is the base frequency, bar 2 is twice it, bar 3 three times, and so on. This is the recipe of sine waves that builds the shape above. More tall bars on the right = brighter sound. Bars above the filter cutoff are drawn faded.</p>',
      live: (i) => INFO.shape.live(i),
    },
    cutoff: {
      title: 'Filter cutoff',
      body: '<p>A <b>low-pass filter</b> lets frequencies below the cutoff through and turns down the ones above it. Lower cutoff = darker, muffled sound (it removes the upper harmonics). Sweeping the cutoff is the classic “wah”/build-up sound.</p><p>The curve shows how much of each frequency gets through; the small marks along the bottom are the harmonics of the current note.</p>',
      live: () => `cutoff = ${fmtHz(state.cutoff)}\nabove it: −12 dB per octave\nharmonics of ${noteName(lastNote)} above cutoff: n > ${Math.max(1, Math.floor(state.cutoff / midiFreq(lastNote)))}`,
    },
    res: {
      title: 'Resonance',
      body: '<p>Boosts frequencies right at the cutoff, making a whistling peak. High resonance + a moving cutoff = the squelchy “acid” sound.</p>',
      live: () => `peak at cutoff = +${state.res.toFixed(1)} dB (×${Math.pow(10, state.res / 20).toFixed(2)})`,
    },
    fenv: {
      title: 'Envelope → filter',
      body: '<p>Uses the same attack/decay/sustain/release shape to open the filter for each note. The cutoff jumps up by this many octaves at the start of the note and falls back as it decays — this is what makes plucks and basses “bite”. The dashed curve shows where the filter is right now.</p>',
      live: () => `cutoff at note start = ${fmtHz(state.cutoff)} × 2^${state.fenv.toFixed(1)} = ${fmtHz(Math.min(20000, state.cutoff * Math.pow(2, state.fenv)))}`,
    },
    pitch: {
      title: 'Pitch bend',
      body: '<p>Shifts every keyboard-following oscillator up or down together, in semitones. Automate it downward and you get a <b>bass drop</b>; upward and you get a riser. Oscillators on Fixed Hz ignore it.</p>',
      live: () => `bend = ${state.pitch.toFixed(2)} st → frequency × 2^(${state.pitch.toFixed(2)}/12) = ×${Math.pow(2, state.pitch / 12).toFixed(3)}`,
    },
    mixScope: {
      title: 'Mix scope',
      body: '<p>The thin coloured lines are the three oscillators; the <b>white line is their sum</b>. Where peaks line up the sum grows (constructive interference); where one is up and another down they cancel (destructive interference).</p><p>Widen the time window to around 1 second to see slow beating appear as the white shape swelling and shrinking.</p>',
    },
    window: {
      title: 'Time window',
      body: '<p>How much time the scopes show across their width. Short windows show single cycles. Long windows show slow changes such as beating and tremolo.</p>',
      live: () => `window = ${state.windowMs.toFixed(1)} ms\ncycles of A4 (440 Hz) visible = ${(440 * state.windowMs / 1000).toFixed(1)}`,
    },
    freeze: { title: 'Freeze', body: '<p>Stops the scopes and speed wheels from moving so you can study the shape. The sound keeps playing.</p>' },
    outScope: { title: 'Real output', body: '<p>Measured from the audio actually being produced (after the filter, envelope and safety limiter). It is lined up on each upward zero crossing so repeating waves stand still.</p>' },
    spectrum: { title: 'Spectrum', body: '<p>Splits the sound into its frequencies (an FFT). Left = low, right = high, height = how strong. A sine is one spike; a saw is a row of spikes; noise is a flat carpet. The coloured dashed lines mark each oscillator’s frequency; the pink line is the filter cutoff.</p>' },
    attack: { title: 'Attack', body: '<p>Time for a note to fade in from silence to full level. Short = plucky, long = swelling pads.</p>', live: () => adsrLive() },
    decay: { title: 'Decay', body: '<p>After the attack peak, the time to fall to the sustain level.</p>', live: () => adsrLive() },
    sustain: { title: 'Sustain', body: '<p>The level the note holds at while the key is down. 0 = the note dies away even while held, like a pluck.</p>', live: () => adsrLive() },
    release: { title: 'Release', body: '<p>Time to fade to silence after the note ends.</p>', live: () => adsrLive() },
    master: { title: 'Master volume', body: '<p>Overall output level. A gentle limiter after it stops loud combinations from clipping.</p>' },
    chord: { title: 'Chord mode', body: '<p>Turns every key you press into a whole chord (for example Major = root + 4 + 7 semitones). One finger, full harmony — and every note is its own three-oscillator voice, so the sound gets thick fast.</p>' },
    hold: { title: 'Hold', body: '<p>Keeps keyboard notes ringing after you let go, so you can use both hands on the controls.</p>' },
    panic: { title: 'Stop all', body: '<p>Stops the sequencer and releases every sounding note.</p>' },
    transport: { title: 'Play / Stop', body: '<p>Starts the step sequencer, the loop and the automation lanes together. Keyboard: <b>Space</b>.</p>' },
    loop: { title: 'Loop', body: '<p>On: the pattern and automation repeat forever — watch the ring spin and the loop counter go up. Off: they play once (one-shot), which is how you would trigger a single riser or bass drop.</p>' },
    bars: { title: 'Loop length', body: '<p>How long one pass of the loop is. The 16-step pattern repeats every bar; automation lanes stretch across the whole loop, so a 4-bar loop gives a slow, long sweep.</p>', live: () => `${state.bars} bar(s) = ${16 * state.bars} steps = ${(16 * state.bars * 15 / state.bpm).toFixed(2)} s at ${state.bpm} BPM` },
    bpm: { title: 'Tempo', body: '<p>Beats per minute. Each step is a sixteenth note: four steps per beat.</p>', live: () => `one step = 60 / ${state.bpm} / 4 = ${(15000 / state.bpm).toFixed(1)} ms` },
    gate: { title: 'Note length', body: '<p>How long each step’s note is held, as a fraction of the step. Short = staccato, 100% = notes join up.</p>' },
    root: { title: 'Root note', body: '<p>The bottom row of the sequencer grid. The grid covers one octave above it.</p>' },
    seqRandom: { title: 'Random pattern', body: '<p>Makes a new random pattern using notes of a minor pentatonic scale.</p>' },
    seqClear: { title: 'Clear', body: '<p>Removes every note from the pattern.</p>' },
    seqGrid: {
      title: 'Step sequencer',
      body: '<p>Sixteen steps left to right = one bar. Rows are notes (higher row = higher pitch). Click a cell to put a note on that step; click it again to remove it. One note per step. Cells are coloured by pitch, and light up as they play.</p>',
    },
    loopRing: {
      title: 'Loop ring',
      body: '<p>The whole loop drawn as a circle. The arm sweeps round once per loop; each segment is one step (lit if it has a note). The inner shapes are the automation lanes wrapped around the circle, so you can see each sweep coming. The ring flashes every time the loop starts again, and the counter shows how many times it has gone round.</p>',
    },
    macros: {
      title: 'Automation macros',
      body: '<p>One-click setups for classic moves. <b>Filter sweeps</b> open or close the filter over 4 bars. <b>Bass drop</b> dives the pitch and closes the filter, once. <b>Riser</b> pushes pitch and filter up, once. <b>Wobble</b> moves the filter up and down in time. If the sequencer is empty, a note is held for you.</p>',
    },
    lane: {
      title: 'Automation lane',
      body: '<p>A drawing of how a knob should move over the loop: left = start of the loop, right = end, high = knob up. While playing, the line shows where the loop is, the dot shows the value being sent, and the knob it controls glows and moves on its own. Draw directly on the lane, or use a shape button.</p>',
    },
    laneTarget: { title: 'Lane target', body: '<p>Which knob this lane moves. Filter cutoff = sweeps and wobbles; pitch bend = drops and risers; volumes = fades and gating; Fixed Hz = changing an LFO’s speed.</p>' },
    laneShape: { title: 'Lane shape', body: '<p>Up/Down = ramps, Tri/Sine = smooth back-and-forth, Square = on/off chops, Rise = slow-then-fast build, Drop = hold then fall, Random = stepped random values.</p>' },
    laneCycles: { title: 'Repeats', body: '<p>How many times the shape repeats inside one loop. With a 1-bar loop, 4 repeats = once per beat, 8 = every eighth note.</p>' },
    laneRange: { title: 'Low / High', body: '<p>The range the shape moves between, as a position of the target knob (0 = knob fully down, 1 = fully up).</p>' },
  };

  function liveFreq(i) {
    const o = state.osc[i];
    if (o.shape === 'noise') return 'noise has no pitch — tuning does not change it';
    const f = oscFreq(i);
    const nn = freqToNote(f);
    const zone = f < 20 ? 'below hearing → LFO / rhythm' : f < 250 ? 'bass' : f < 2000 ? 'middle' : 'treble';
    if (o.fixed) {
      return `fixed: f = ${o.hz.toFixed(2)} × 2^(${o.fine}/1200) = ${fmtHz(f)}\n` +
        `one cycle every ${(1000 / f).toFixed(f < 1 ? 0 : 2)} ms  (${zone})`;
    }
    const f0 = midiFreq(lastNote);
    return `note ${noteName(lastNote)} = 440 × 2^((${lastNote} − 69)/12) = ${fmtHz(f0)}\n` +
      `f = ${f0.toFixed(2)} × 2^((${o.coarse} + ${o.fine}/100 + bend ${state.pitch.toFixed(1)})/12)\n  = ${fmtHz(f)}  (${nn.name} ${fmtCents(nn.cents)}, ${zone})\n` +
      `period = 1/f = ${(1000 / f).toFixed(3)} ms\nwavelength in air = 343/f = ${(343 / f).toFixed(2)} m`;
  }
  function adsrLive() {
    return `attack ${fmtTime(state.attack)} → decay ${fmtTime(state.decay)} → sustain ${fmtPct(state.sustain)} → release ${fmtTime(state.release)}`;
  }

  let explainKey = null, explainOsc = 0;
  const elTitle = document.getElementById('explainTitle');
  const elBody = document.getElementById('explainBody');
  const elLive = document.getElementById('explainLive');

  function showInfo(key, oscIndex) {
    const info = INFO[key];
    if (!info || !state.learn) return;
    explainKey = key;
    explainOsc = oscIndex ?? 0;
    const prefix = oscIndex != null && key !== 'am' ? `Osc ${oscIndex + 1} — ` : '';
    elTitle.textContent = prefix + info.title;
    elBody.innerHTML = info.body;
    refreshExplainLive();
  }
  function refreshExplainLive() {
    const info = explainKey && INFO[explainKey];
    elLive.textContent = info && info.live ? info.live(explainOsc) : '';
  }
  function hookInfo(root) {
    root.querySelectorAll('[data-info]').forEach((el) => {
      const handler = (e) => {
        e.stopPropagation();
        const oscEl = el.closest('.osc');
        showInfo(el.dataset.info, oscEl ? Number(oscEl.dataset.i) : null);
      };
      el.addEventListener('pointerenter', handler);
      el.addEventListener('focusin', handler);
      el.addEventListener('pointerdown', handler);
    });
  }

  // ================================================================ oscillator panel UI
  const oscRow = document.getElementById('oscRow');
  const oscUI = [];
  const OSC_SLIDERS = [
    { key: 'coarse', label: 'Coarse', cls: 'row-coarse' },
    { key: 'hz', label: 'Frequency', cls: 'row-hz' },
    { key: 'fine', label: 'Fine' },
    { key: 'vol', label: 'Volume' },
    { key: 'pan', label: 'Pan' },
    { key: 'phase', label: 'Phase' },
  ];

  function buildOscPanels() {
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('section');
      el.className = 'panel osc';
      el.dataset.i = i;
      el.innerHTML = `
        <div class="panel-head">
          <h2>Osc ${i + 1}</h2>
          <div class="flags">
            <button type="button" class="toggle mute" data-info="mute">M</button>
            <button type="button" class="toggle solo" data-info="solo">S</button>
          </div>
        </div>
        <canvas class="scope wave" data-info="scope"></canvas>
        <canvas class="scope speed" data-info="speed"></canvas>
        <div class="waves" role="group" aria-label="Waveform" data-info="shape">
          ${SHAPES.map((s) => `<button type="button" class="wave-btn" data-shape="${s.id}">${s.label}</button>`).join('')}
        </div>
        <div class="seg keyfix" data-info="fixed">
          <button type="button" data-fixed="0">Follow keyboard</button><button type="button" data-fixed="1">Fixed Hz</button>
        </div>
        <div class="sliders">
          ${OSC_SLIDERS.map((s) => `<label class="${s.cls || ''}" data-info="${s.key}">${s.label}<output></output>
            <input type="range" data-param="o${i}.${s.key}"></label>`).join('')}
        </div>
        <div class="checks">
          <label data-info="invert"><input type="checkbox" class="invert"> Invert</label>
          ${i === 2 ? '<label data-info="am"><input type="checkbox" class="am"> Use as AM for Osc 1 + 2</label>' : ''}
        </div>
        <div class="harm-wrap learn-only" data-info="harm">
          <div class="cap">Harmonic fingerprint</div>
          <canvas class="scope harm"></canvas>
        </div>
        <div class="readout"></div>`;
      oscRow.appendChild(el);

      const ui = {
        root: el,
        scope: el.querySelector('canvas.wave'),
        speed: el.querySelector('canvas.speed'),
        harm: el.querySelector('canvas.harm'),
        readout: el.querySelector('.readout'),
        waveBtns: [...el.querySelectorAll('.wave-btn')],
        fixBtns: [...el.querySelectorAll('[data-fixed]')],
        mute: el.querySelector('.mute'),
        solo: el.querySelector('.solo'),
        invert: el.querySelector('.invert'),
        am: el.querySelector('.am'),
        bg: '',
        angle: 0,
      };
      ui.waveBtns.forEach((b) => b.addEventListener('click', () => setOscProp(i, 'shape', b.dataset.shape)));
      ui.fixBtns.forEach((b) => b.addEventListener('click', () => setOscProp(i, 'fixed', b.dataset.fixed === '1')));
      ui.mute.addEventListener('click', () => setOscProp(i, 'mute', !state.osc[i].mute));
      ui.solo.addEventListener('click', () => setOscProp(i, 'solo', !state.osc[i].solo));
      ui.invert.addEventListener('change', () => setOscProp(i, 'invert', ui.invert.checked));
      if (ui.am) ui.am.addEventListener('change', () => setAM(ui.am.checked));
      oscUI.push(ui);
    }
  }

  function syncOscUI(i) {
    const o = state.osc[i];
    const ui = oscUI[i];
    for (const s of OSC_SLIDERS) syncParam(`o${i}.${s.key}`);
    ui.waveBtns.forEach((b) => b.classList.toggle('on', b.dataset.shape === o.shape));
    ui.fixBtns.forEach((b) => b.classList.toggle('on', (b.dataset.fixed === '1') === o.fixed));
    ui.root.classList.toggle('fixed', o.fixed);
    ui.mute.classList.toggle('on', o.mute);
    ui.solo.classList.toggle('on', o.solo);
    ui.invert.checked = o.invert;
    if (ui.am) ui.am.checked = state.am;
    for (let k = 0; k < 3; k++) oscUI[k].root.classList.toggle('silent', !audible(k));
  }

  function setOscProp(i, key, value) {
    state.osc[i][key] = value;
    if (key === 'shape') {
      rebuildTable(i);
      rebuildPeriodicWave(i);
      for (const v of activeVoices) v.refreshSource(i);
    }
    updateVoices();
    syncOscUI(i);
    markDirty();
  }

  function setAM(on) {
    state.am = on;
    for (const v of activeVoices) { v.routeOsc3(); v.update(); }
    syncOscUI(2);
    showInfo('am', 2);
    markDirty();
  }

  // ================================================================ readouts and analysis
  const analysisEl = document.getElementById('analysis');

  function refreshReadouts() {
    for (let i = 0; i < 3; i++) {
      const o = state.osc[i];
      const ui = oscUI[i];
      if (o.shape === 'noise') {
        ui.readout.innerHTML = `<b>Noise</b> — no pitch · level <b>${fmtPct(o.vol)}</b>`;
        continue;
      }
      const f = oscFreq(i);
      const nn = freqToNote(f);
      const role = i === 2 && state.am ? ' · <b>AM modulator</b>' : '';
      const what = f < 20 ? 'LFO (too slow to hear as pitch)' : `${nn.name} ${fmtCents(nn.cents)}`;
      ui.readout.innerHTML = `<b>${fmtHz(f)}</b> · ${what} · period ${(1000 / f).toFixed(f < 1 ? 0 : 2)} ms${o.fixed ? ' · fixed' : ''}${role}`;
    }
    refreshAnalysis();
    refreshExplainLive();
  }

  function refreshAnalysis() {
    const cards = [];
    const tonal = [0, 1, 2].filter((i) => audible(i) && state.osc[i].shape !== 'noise' && !(i === 2 && state.am) && oscFreq(i) >= 20);
    for (let a = 0; a < tonal.length; a++) {
      for (let b = a + 1; b < tonal.length; b++) {
        const i = tonal[a], j = tonal[b];
        const fi = oscFreq(i), fj = oscFreq(j);
        const diff = Math.abs(fi - fj);
        const semis = 12 * Math.log2(Math.max(fi, fj) / Math.min(fi, fj));
        const head = `Osc ${i + 1} + Osc ${j + 1}`;
        if (diff < 0.005) {
          const oi = state.osc[i], oj = state.osc[j];
          let dPhase = (oj.phase - oi.phase + (oi.invert !== oj.invert ? 180 : 0)) % 360;
          if (dPhase < 0) dPhase += 360;
          let verdict = 'partly reinforce';
          if (dPhase < 5 || dPhase > 355) verdict = 'line up and <b>reinforce</b> (louder)';
          else if (Math.abs(dPhase - 180) < 5) verdict = oi.shape === oj.shape ? '<b>cancel</b> each other out' : 'mostly oppose each other';
          else if (dPhase > 90 && dPhase < 270) verdict = 'partly <b>cancel</b>';
          const hot = Math.abs(dPhase - 180) < 5;
          cards.push(`<div class="card${hot ? ' hot' : ''}"><b>${head}</b><br>Same pitch. Phase difference <b>${dPhase.toFixed(0)}°</b> → they ${verdict}.</div>`);
        } else if (diff < 20) {
          cards.push(`<div class="card hot"><b>${head}</b><br>${fmtHz(fi)} vs ${fmtHz(fj)} → <b>beating at ${diff.toFixed(2)} Hz</b>: the volume pulses ${diff.toFixed(1)}× per second (|f₁ − f₂|).</div>`);
        } else {
          const r = Math.round(semis);
          const oct = Math.floor(r / 12);
          const name = INTERVALS[r % 12] === 'unison' && oct > 0 ? (oct === 1 ? 'octave' : oct + ' octaves') : INTERVALS[r % 12] + (oct ? ` + ${oct} oct` : '');
          const off = Math.round((semis - r) * 100);
          cards.push(`<div class="card"><b>${head}</b><br>${semis.toFixed(2)} semitones apart = <b>${name}</b>${off ? ` (${fmtCents(off)})` : ''}<br>frequency ratio ${(Math.max(fi, fj) / Math.min(fi, fj)).toFixed(3)} : 1</div>`);
        }
      }
    }
    if (state.am && audible(2)) {
      const f3 = oscFreq(2);
      const d = Math.abs(effLevel(2));
      const txt = f3 < 20
        ? `Osc 3 at ${fmtHz(f3)} is a <b>tremolo / wobble</b>: the volume of Osc 1 + 2 dips ${f3.toFixed(1)}× per second (depth ${fmtPct(d)}).`
        : `Osc 3 at ${fmtHz(f3)} is too fast to hear as wobble, so it creates <b>sidebands</b> at f ± ${fmtHz(f3)} — new, often inharmonic tones.`;
      cards.push(`<div class="card hot"><b>Amplitude modulation</b><br>${txt}</div>`);
    }
    for (let i = 0; i < 3; i++) {
      if (audible(i) && state.osc[i].shape !== 'noise' && !(i === 2 && state.am) && oscFreq(i) < 20) {
        cards.push(`<div class="card"><b>Osc ${i + 1}</b><br>At ${fmtHz(oscFreq(i))} it is below hearing (20 Hz) — you hear clicks, not a note. Tick “Use as AM” on Osc 3 to turn a slow oscillator into a wobble.</div>`);
      }
    }
    if ([0, 1, 2].some((i) => audible(i) && state.osc[i].shape === 'noise')) {
      cards.push('<div class="card"><b>Noise</b><br>Random values contain every frequency at once — see the flat carpet in the spectrum.</div>');
    }
    if (state.cutoff < 15000) {
      cards.push(`<div class="card"><b>Filter</b><br>Frequencies above <b>${fmtHz(state.cutoff)}</b> are being turned down${state.res > 6 ? ', with a resonant peak at the cutoff' : ''}.</div>`);
    }
    if (!cards.length) cards.push('<div class="card">Turn up two oscillators to see how they interact: intervals, beating and cancellation appear here.</div>');
    analysisEl.innerHTML = cards.join('');
  }

  // ================================================================ canvases
  const canvases = new Map();   // element -> { g, w, h }
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const c = e.target;
      const r = c.getBoundingClientRect();
      const k = dpr();
      c.width = Math.max(1, Math.round(r.width * k));
      c.height = Math.max(1, Math.round(r.height * k));
      const g = c.getContext('2d');
      g.setTransform(k, 0, 0, k, 0, 0);
      canvases.set(c, { g, w: r.width, h: r.height });
    }
  });
  const cv = (el) => canvases.get(el);

  function drawGrid(g, w, h) {
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 1;
    g.beginPath();
    for (let k = 1; k < 4; k++) { const y = (h * k) / 4; g.moveTo(0, y); g.lineTo(w, y); }
    for (let k = 1; k < 10; k++) { const x = (w * k) / 10; g.moveTo(x, 0); g.lineTo(x, h); }
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
  }

  function label(g, text, x, y, color = '#8a93a8', align = 'left') {
    g.fillStyle = color;
    g.font = '11px system-ui, sans-serif';
    g.textAlign = align;
    g.fillText(text, x, y);
    g.textAlign = 'left';
  }

  // Plot fn(t) for t across the window. If the signal is too dense for the pixels,
  // draw its min/max envelope as a filled band instead of an aliased line.
  function plot(g, w, h, fn, t0, win, maxFreq, scale, stroke, lineWidth) {
    const cycles = maxFreq * win;
    const sub = clamp(Math.ceil((cycles * 8) / w), 1, 24);
    const mid = h / 2;
    const amp = (h / 2 - 4) * scale;
    g.strokeStyle = stroke;
    g.lineWidth = lineWidth;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    if (sub === 1) {
      g.beginPath();
      for (let x = 0; x <= w; x++) {
        const y = mid - fn(t0 + (x / w) * win) * amp;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      return;
    }
    const top = new Float32Array(w + 1), bot = new Float32Array(w + 1);
    for (let x = 0; x <= w; x++) {
      let lo = Infinity, hi = -Infinity;
      for (let s = 0; s < sub; s++) {
        const v = fn(t0 + ((x + s / sub) / w) * win);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      top[x] = mid - hi * amp;
      bot[x] = mid - lo * amp;
    }
    g.beginPath();
    g.moveTo(0, top[0]);
    for (let x = 1; x <= w; x++) g.lineTo(x, top[x]);
    for (let x = w; x >= 0; x--) g.lineTo(x, bot[x]);
    g.closePath();
    g.fillStyle = stroke;
    const a = g.globalAlpha;
    g.globalAlpha = a * 0.55;
    g.fill();
    g.globalAlpha = a;
    g.lineWidth = Math.min(lineWidth, 1.5);
    g.stroke();
  }

  // ---------------------------------------------------------------- oscillator visuals
  function oscColors(i) {
    const o = state.osc[i];
    if (o.shape === 'noise') {
      return { panel: 'hsl(220, 8%, 12%)', scope: 'hsl(220, 8%, 8%)', line: 'rgba(235,235,240,0.95)', glow: 'rgba(255,255,255,0.6)' };
    }
    const x = pitchPos(oscFreq(i));
    const hue = 225 - 225 * x;   // blue -> red
    return {
      panel: `hsl(${hue.toFixed(0)}, ${(38 + 30 * x).toFixed(0)}%, ${(7 + 17 * x).toFixed(0)}%)`,
      scope: `hsl(${hue}, ${45 + 35 * x}%, ${4 + 22 * x}%)`,
      line: `hsl(${hue}, 100%, ${82 + 10 * x}%)`,
      glow: `hsl(${hue}, 100%, 60%)`,
    };
  }

  function drawOscScope(i, t0, env) {
    const ui = oscUI[i];
    const c = cv(ui.scope);
    if (!c) return;
    const { g, w, h } = c;
    const o = state.osc[i];
    const col = oscColors(i);
    if (ui.bg !== col.panel) { ui.bg = col.panel; ui.root.style.setProperty('--obg', col.panel); }
    g.fillStyle = col.scope;
    g.fillRect(0, 0, w, h);
    drawGrid(g, w, h);
    const f = o.shape === 'noise' ? 8000 : oscFreq(i);
    // Louder = bigger, thicker and glowing; a playing note makes it swell further.
    const size = o.vol * (0.6 + 0.4 * env);
    const sign = o.invert ? -1 : 1;
    g.globalAlpha = audible(i) ? 1 : 0.35;
    g.shadowColor = col.glow;
    g.shadowBlur = 2 + 22 * size;
    plot(g, w, h, (t) => waveAt(i, f * t) * sign * size, t0, state.windowMs / 1000, f, 0.9, col.line, 1 + 8 * size);
    g.shadowBlur = 0;
    g.globalAlpha = 1;
    const tag = o.shape === 'noise' ? 'noise' : `${fmtHz(f)} · ${(f * state.windowMs / 1000).toFixed(1)} cycles shown`;
    label(g, tag, 6, 14, 'rgba(255,255,255,0.8)');
    label(g, `vol ${fmtPct(o.vol)}`, w - 6, 14, 'rgba(255,255,255,0.8)', 'right');
    if (i === 2 && state.am) label(g, 'AM modulator (not heard directly)', 6, h - 6, 'rgba(255,255,255,0.8)');
  }

  // Spinning wheel: one turn per cycle of the wave (slowed down), plus a map of the frequency zones.
  function drawSpeed(i, dt) {
    const ui = oscUI[i];
    const c = cv(ui.speed);
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    const o = state.osc[i];
    const noise = o.shape === 'noise';
    const f = noise ? 0 : oscFreq(i);
    const rps = noise ? 0 : 0.12 * Math.pow(f, 0.45);    // visual turns per second
    if (!state.freeze) ui.angle = (ui.angle + 2 * Math.PI * rps * dt) % (2 * Math.PI);
    const R = h / 2 - 7;
    const cx = R + 8, cy = h / 2;
    const color = noise ? '#ddd' : pitchColor(f);

    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 1.5;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    if (noise) {
      for (let k = 0; k < 14; k++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * R;
        g.fillStyle = 'rgba(230,230,240,0.7)';
        g.fillRect(cx + Math.cos(a) * r - 1, cy - Math.sin(a) * r - 1, 2, 2);
      }
    } else {
      // motion trail: longer when faster
      const trail = clamp(rps * 1.1, 0.25, Math.PI * 1.6);
      const seg = 14;
      g.strokeStyle = color;
      g.lineWidth = 4;
      for (let k = 0; k < seg; k++) {
        const a1 = ui.angle - (trail * k) / seg, a2 = ui.angle - (trail * (k + 1)) / seg;
        g.globalAlpha = 0.85 * (1 - k / seg);
        g.beginPath(); g.arc(cx, cy, R, -a1, -a2, false); g.stroke();
      }
      g.globalAlpha = 1;
      const px = cx + Math.cos(ui.angle) * R, py = cy - Math.sin(ui.angle) * R;
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(px, py); g.stroke();
      // projection: the height of the dot is the sine wave
      g.setLineDash([2, 3]);
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.beginPath(); g.moveTo(px, py); g.lineTo(cx + R + 10, py); g.stroke();
      g.setLineDash([]);
      g.fillStyle = color;
      g.beginPath(); g.arc(px, py, 4, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(cx + R + 10, py, 3, 0, Math.PI * 2); g.fill();
    }

    const x0 = cx + R + 22, x1 = w - 8;
    g.fillStyle = '#fff';
    g.font = '600 15px system-ui, sans-serif';
    g.fillText(noise ? 'random' : fmtHz(f), x0, 18);
    g.font = '11px system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.7)';
    const sub = noise ? 'no steady speed — every frequency at once'
      : f < 20 ? `${f < 1 ? f.toFixed(2) : f.toFixed(1)} turns per second — an LFO`
        : `${Math.round(f)} vibrations per second`;
    g.fillText(sub, x0, 32);
    const fMin = 0.1, fMax = 10000;
    const xs = (fr) => x0 + (Math.log(fr / fMin) / Math.log(fMax / fMin)) * (x1 - x0);
    const by = h - 18, bh = 8;
    const zones = [[0.1, 20, 'rgba(120,120,160,0.55)', 'LFO'], [20, 250, 'hsla(220,80%,55%,0.7)', 'bass'], [250, 2000, 'hsla(120,60%,45%,0.7)', 'mid'], [2000, 10000, 'hsla(5,80%,55%,0.7)', 'treble']];
    for (const [a, b, col, name] of zones) {
      g.fillStyle = col;
      g.fillRect(xs(a), by, xs(b) - xs(a) - 1, bh);
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.font = '9px system-ui, sans-serif';
      if (xs(b) - xs(a) > 26) g.fillText(name, xs(a) + 2, by + bh + 9);
    }
    if (!noise) {
      const mx = xs(clamp(f, fMin, fMax));
      g.fillStyle = '#fff';
      g.beginPath(); g.moveTo(mx, by - 1); g.lineTo(mx - 5, by - 8); g.lineTo(mx + 5, by - 8); g.closePath(); g.fill();
      g.fillRect(mx - 1, by - 1, 2, bh + 2);
    }
  }

  function drawHarmonics(i) {
    const c = cv(oscUI[i].harm);
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    const o = state.osc[i];
    const bars = 16;
    const bw = w / bars;
    if (o.shape === 'noise') {
      g.fillStyle = 'rgba(200,200,210,0.5)';
      for (let n = 0; n < bars; n++) g.fillRect(n * bw + 1, h * 0.35 + Math.random() * h * 0.2, bw - 2, h);
      return;
    }
    const b = tables[i].b;
    const f = oscFreq(i);
    for (let n = 1; n <= bars; n++) {
      const a = Math.abs(b[n]) / (4 / Math.PI);
      const bh = Math.max(a > 0 ? 2 : 0, a * (h - 4));
      const fn = f * n;
      g.fillStyle = pitchColor(fn, fn > state.cutoff ? 0.25 : 0.95);
      g.fillRect((n - 1) * bw + 1, h - bh, bw - 2, bh);
    }
  }

  // ---------------------------------------------------------------- mix + output + spectrum
  function drawMix(t0) {
    const c = cv(document.getElementById('mixScope'));
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    drawGrid(g, w, h);
    const win = state.windowMs / 1000;
    const lv = [0, 1, 2].map((i) => effLevel(i));
    const fq = [0, 1, 2].map((i) => oscFreq(i));
    const freqs = [0, 1, 2].map((i) => (state.osc[i].shape === 'noise' ? 8000 : fq[i]));
    // Each oscillator's contribution exactly as the audio engine mixes it (mute/solo/invert applied).
    const raw = (i, t) => waveAt(i, fq[i] * t) * lv[i];
    const sum = (t) => {
      let s = raw(0, t) + raw(1, t);
      if (state.am) s *= 1 - 0.5 * Math.abs(lv[2]) + 0.5 * raw(2, t);
      else s += raw(2, t);
      return s;
    };
    let peak = 0;
    for (let x = 0; x < 200; x++) peak = Math.max(peak, Math.abs(sum(t0 + (x / 200) * win)));
    const scale = 0.9 / Math.max(1, peak);
    const maxF = Math.max(...freqs);
    g.globalAlpha = 0.5;
    for (let i = 0; i < 3; i++) {
      if (!lv[i]) continue;
      plot(g, w, h, (t) => raw(i, t), t0, win, freqs[i], scale, OSC_COLORS[i], 1);
    }
    g.globalAlpha = 1;
    plot(g, w, h, sum, t0, win, maxF, scale, '#ffffff', 2.2);
    const ms = state.windowMs < 100 ? state.windowMs.toFixed(1) : Math.round(state.windowMs);
    label(g, `${ms} ms across · note ${noteName(lastNote)}${scale < 0.89 ? ` · scaled ×${scale.toFixed(2)} to fit` : ''}`, 6, 14);
  }

  const timeBuf = new Float32Array(2048);
  let freqBuf = null;

  function msg(g, w, h, text) { label(g, text, w / 2, h / 2 - 6, '#5b6478', 'center'); }

  function drawOutput() {
    const c = cv(document.getElementById('outScope'));
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    drawGrid(g, w, h);
    if (!analyser) { msg(g, w, h, 'Play a note to start audio'); return; }
    analyser.getFloatTimeDomainData(timeBuf);
    let start = 0;
    for (let k = 1; k < 1024; k++) if (timeBuf[k - 1] < 0 && timeBuf[k] >= 0) { start = k; break; }
    let peak = 0;
    for (let k = 0; k < timeBuf.length; k++) peak = Math.max(peak, Math.abs(timeBuf[k]));
    if (peak < 0.0005) { msg(g, w, h, 'silence'); return; }
    const n = 1024;
    const scale = 0.9 / Math.max(0.3, peak);
    g.strokeStyle = '#4fb6c4';
    g.lineWidth = 1 + 3 * Math.min(1, peak * 2);
    g.beginPath();
    for (let x = 0; x <= w; x++) {
      const v = timeBuf[start + Math.min(n - 1, Math.floor((x / w) * n))];
      const y = h / 2 - v * (h / 2) * scale;
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    label(g, `${(1000 * n / actx.sampleRate).toFixed(1)} ms · peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`, 6, 14);
  }

  const specX = (f, w) => (Math.log(f / 20) / Math.log(1000)) * w;

  function drawSpectrum() {
    const c = cv(document.getElementById('spectrum'));
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#1c2230';
    g.lineWidth = 1;
    [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach((f) => {
      const x = specX(f, w);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      label(g, f >= 1000 ? f / 1000 + 'k' : String(f), x + 2, h - 3, '#5b6478');
    });
    for (let i = 0; i < 3; i++) {
      if (!audible(i) || state.osc[i].shape === 'noise') continue;
      const f = oscFreq(i);
      if (f < 20) continue;
      const x = specX(f, w);
      g.strokeStyle = OSC_COLORS[i];
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      g.setLineDash([]);
    }
    if (state.cutoff < 17000) {
      const x = specX(state.cutoff, w);
      g.strokeStyle = '#ff5fa2';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      g.lineWidth = 1;
    }
    if (!analyser) { msg(g, w, h, 'Play a note to start audio'); return; }
    if (!freqBuf) freqBuf = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freqBuf);
    const binHz = actx.sampleRate / analyser.fftSize;
    const dbMin = -110, dbMax = -10;
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w; x++) {
      const f1 = 20 * Math.pow(1000, x / w);
      const f2 = 20 * Math.pow(1000, (x + 1) / w);
      const b1 = Math.floor(f1 / binHz), b2 = Math.max(b1 + 1, Math.floor(f2 / binHz));
      let m = -Infinity;
      for (let b = b1; b < b2 && b < freqBuf.length; b++) m = Math.max(m, freqBuf[b]);
      g.lineTo(x, h - clamp((m - dbMin) / (dbMax - dbMin), 0, 1) * (h - 14));
    }
    g.lineTo(w, h);
    g.closePath();
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(79,140,255,0.75)');
    grad.addColorStop(0.5, 'rgba(79,182,196,0.75)');
    grad.addColorStop(1, 'rgba(255,90,80,0.75)');
    g.fillStyle = grad;
    g.fill();
  }

  // ---------------------------------------------------------------- filter + envelope pictures
  // 2-pole low-pass magnitude (close to Web Audio's BiquadFilter), in dB.
  function lpDb(f, fc, resDb) {
    const q = Math.max(0.5, Math.pow(10, resDb / 20));
    const r = f / fc;
    return 20 * Math.log10(1 / Math.sqrt((1 - r * r) ** 2 + (r / q) ** 2));
  }

  function drawFilter(env) {
    const c = cv(document.getElementById('filterCanvas'));
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    const yOf = (db) => clamp(h * 0.35 - (db / 36) * h * 0.6, 2, h - 2);
    [100, 1000, 10000].forEach((f) => {
      const x = specX(f, w);
      g.strokeStyle = '#1c2230';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      label(g, f >= 1000 ? f / 1000 + 'k' : String(f), x + 2, h - 3, '#5b6478');
    });
    const curve = (fc, style, width, dash) => {
      g.strokeStyle = style; g.lineWidth = width; g.setLineDash(dash || []);
      g.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const y = yOf(lpDb(20 * Math.pow(1000, x / w), fc, state.res));
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      g.setLineDash([]);
    };
    g.fillStyle = 'rgba(255,95,162,0.10)';
    g.fillRect(0, 0, specX(state.cutoff, w), h);
    curve(state.cutoff, '#ff5fa2', 2);
    if (state.fenv > 0 && env > 0.01) {
      curve(Math.min(20000, state.cutoff * Math.pow(2, state.fenv * env)), 'rgba(255,255,255,0.75)', 1.5, [4, 3]);
    }
    const f0 = midiFreq(lastNote) * Math.pow(2, state.pitch / 12);
    for (let n = 1; n <= 24; n++) {
      const f = f0 * n;
      if (f > 20000) break;
      g.fillStyle = pitchColor(f, f > state.cutoff ? 0.3 : 0.9);
      g.fillRect(specX(f, w) - 1, h - 10, 2, 6);
    }
    label(g, `cutoff ${fmtHz(state.cutoff)}`, 6, 13, '#ff9cc6');
  }

  function drawEnvelope(env) {
    const c = cv(document.getElementById('envCanvas'));
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    const hold = 0.5;
    const total = state.attack + state.decay + hold + state.release;
    const X = (t) => 6 + (t / total) * (w - 30);
    const Y = (v) => h - 8 - v * (h - 22);
    const pts = [[0, 0], [state.attack, 1], [state.attack + state.decay, state.sustain],
      [state.attack + state.decay + hold, state.sustain], [total, 0]];
    g.beginPath();
    pts.forEach(([t, v], k) => (k ? g.lineTo(X(t), Y(v)) : g.moveTo(X(t), Y(v))));
    g.strokeStyle = '#4fb6c4';
    g.lineWidth = 2;
    g.stroke();
    g.lineTo(X(0), Y(0));
    g.fillStyle = 'rgba(79,182,196,0.12)';
    g.fill();
    [['A', state.attack / 2], ['D', state.attack + state.decay / 2], ['S', state.attack + state.decay + hold / 2], ['R', total - state.release / 2]]
      .forEach(([s, t]) => label(g, s, X(t) - 3, 12));
    // live level meter
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(w - 16, 6, 10, h - 14);
    g.fillStyle = '#4fb6c4';
    const lh = env * (h - 14);
    g.fillRect(w - 16, h - 8 - lh, 10, lh);
  }

  // ================================================================ sequencer + loop
  const transport = { playing: false, step: 0, nextTime: 0, loop: 1, timer: null, log: [], endTime: null, visStep: -1, visLoop: 0, pulse: 0, drone: null };
  const flash = new Float64Array(16);
  const stepDur = () => 60 / state.bpm / 4;
  const totalSteps = () => 16 * state.bars;

  function scheduleStep(s, t) {
    const n = state.seq[s % 16];
    if (n < 0) return;
    const v = new Voice(state.seqRoot + n, 0.9, t);
    v.release(t + state.gate * stepDur());
  }

  function tick() {
    const now = actx.currentTime;
    while (transport.nextTime < now + 0.12 && transport.endTime == null) {
      if (transport.step >= totalSteps()) {
        if (state.loop) { transport.step = 0; transport.loop++; }
        else { transport.endTime = transport.nextTime; break; }
      }
      const s = transport.step, t = transport.nextTime;
      scheduleStep(s, t);
      transport.log.push({ s, t, loop: transport.loop });
      transport.step++;
      transport.nextTime += stepDur();
    }
    applyAutomation();
    if (transport.endTime != null && now >= transport.endTime) stopTransport();
  }

  // Where the playhead is right now (in steps), based on what was scheduled.
  function posNow() {
    if (!transport.playing || !actx) return null;
    const now = actx.currentTime;
    const log = transport.log;
    let k = log.length - 1;
    while (k >= 0 && log[k].t > now) k--;
    if (k < 0) return null;
    const e = log[k];
    if (k > 0) log.splice(0, k);
    const f = clamp((now - e.t) / stepDur(), 0, 1);
    return { s: e.s, pos: e.s + f, loop: e.loop };
  }

  function startTransport() {
    if (!ensureAudio() || transport.playing) return;
    Object.assign(transport, { playing: true, step: 0, loop: 1, log: [], endTime: null, visStep: -1, visLoop: 0 });
    transport.nextTime = actx.currentTime + 0.05;
    if (state.gator.on) gateRestart(transport.nextTime);
    state.lanes.forEach(laneEngage);
    transport.timer = setInterval(tick, 25);
    tick();
    syncTransportUI();
  }

  function stopTransport() {
    if (!transport.playing) return;
    clearInterval(transport.timer);
    transport.playing = false;
    // release sequencer notes and drones (keyboard notes keep ringing)
    const kbVoices = new Set(voices.values());
    for (const v of activeVoices) if (!kbVoices.has(v)) v.release();
    transport.drone = null;
    state.lanes.forEach(laneDisengage);
    syncTransportUI();
  }

  function startDrone(note) {
    if (!ensureAudio()) return;
    if (transport.drone) transport.drone.release();
    transport.drone = new Voice(note, 0.9);
    lastNote = note;
    markDirty();
  }

  const transportBtns = [document.getElementById('transport'), document.getElementById('transportTop')];
  const loopBtn = document.getElementById('loopBtn');
  const barsBtns = [...document.querySelectorAll('#barsSeg button')];
  const rootOut = document.getElementById('rootOut');

  function syncTransportUI() {
    transportBtns.forEach((b) => { b.classList.toggle('on', transport.playing); b.textContent = transport.playing ? '■ Stop' : '▶ Play'; });
    loopBtn.classList.toggle('on', state.loop);
    barsBtns.forEach((b) => b.classList.toggle('on', Number(b.dataset.bars) === state.bars));
    rootOut.textContent = noteName(state.seqRoot);
    refreshAutoGlow();
  }

  transportBtns.forEach((b) => b.addEventListener('click', () => (transport.playing ? stopTransport() : startTransport())));
  loopBtn.addEventListener('click', () => { state.loop = !state.loop; syncTransportUI(); });
  barsBtns.forEach((b) => b.addEventListener('click', () => { state.bars = Number(b.dataset.bars); syncTransportUI(); }));
  document.getElementById('rootDown').addEventListener('click', () => { state.seqRoot = clamp(state.seqRoot - 1, 24, 72); syncTransportUI(); });
  document.getElementById('rootUp').addEventListener('click', () => { state.seqRoot = clamp(state.seqRoot + 1, 24, 72); syncTransportUI(); });
  document.getElementById('seqClear').addEventListener('click', () => { state.seq.fill(-1); });
  document.getElementById('seqRandom').addEventListener('click', () => {
    const scale = [0, 3, 5, 7, 10, 12];
    for (let s = 0; s < 16; s++) state.seq[s] = Math.random() < 0.55 ? scale[Math.floor(Math.random() * scale.length)] : -1;
    state.seq[0] = 0;
  });

  // Sequencer grid: 16 steps x 13 notes.
  const seqCanvas = document.getElementById('seqCanvas');
  const SEQ_ROWS = 13, SEQ_LEFT = 38;
  function seqCell(e) {
    const r = seqCanvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < SEQ_LEFT) return null;
    const col = Math.floor(((x - SEQ_LEFT) / (r.width - SEQ_LEFT)) * 16);
    const row = SEQ_ROWS - 1 - Math.floor((y / r.height) * SEQ_ROWS);
    if (col < 0 || col > 15 || row < 0 || row >= SEQ_ROWS) return null;
    return { col, row };
  }
  seqCanvas.addEventListener('click', (e) => {
    const c = seqCell(e);
    if (!c) return;
    state.seq[c.col] = state.seq[c.col] === c.row ? -1 : c.row;
    if (state.seq[c.col] >= 0 && !transport.playing && ensureAudio()) {
      const v = new Voice(state.seqRoot + c.row, 0.8);
      v.release(actx.currentTime + 0.18);
      lastNote = state.seqRoot + c.row;
      flash[c.col] = performance.now();
      markDirty();
    }
  });

  function drawSeq(pos) {
    const c = cv(seqCanvas);
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    const cw = (w - SEQ_LEFT) / 16, ch = h / SEQ_ROWS;
    const nowMs = performance.now();
    for (let r = 0; r < SEQ_ROWS; r++) {
      const note = state.seqRoot + r;
      const y = h - (r + 1) * ch;
      g.fillStyle = [1, 3, 6, 8, 10].includes(note % 12) ? '#0c0e14' : '#141823';
      g.fillRect(SEQ_LEFT, y, w - SEQ_LEFT, ch);
      label(g, noteName(note), 4, y + ch / 2 + 4, note % 12 === 0 ? '#e6e9f0' : '#6b7488');
    }
    for (let s = 0; s <= 16; s++) {
      g.strokeStyle = s % 4 === 0 ? '#3a4358' : '#1f2533';
      g.lineWidth = s % 4 === 0 ? 1.5 : 1;
      const x = SEQ_LEFT + s * cw;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
    if (pos) {
      const s = pos.s % 16;
      g.fillStyle = 'rgba(79,182,196,0.13)';
      g.fillRect(SEQ_LEFT + s * cw, 0, cw, h);
      g.fillStyle = 'rgba(79,182,196,0.9)';
      g.fillRect(SEQ_LEFT + (pos.pos % 16) * cw - 1, 0, 2, h);
    }
    for (let s = 0; s < 16; s++) {
      const r = state.seq[s];
      if (r < 0) continue;
      const f = midiFreq(state.seqRoot + r);
      const fl = Math.max(0, 1 - (nowMs - flash[s]) / 350);
      const x = SEQ_LEFT + s * cw + 2, y = h - (r + 1) * ch + 2;
      g.shadowColor = pitchColor(f);
      g.shadowBlur = 4 + 18 * fl;
      g.fillStyle = pitchColor(f, 0.75 + 0.25 * fl);
      g.fillRect(x, y, cw - 4, ch - 4);
      g.shadowBlur = 0;
      if (fl > 0) { g.fillStyle = `rgba(255,255,255,${0.6 * fl})`; g.fillRect(x, y, cw - 4, ch - 4); }
    }
    if (state.seq.every((n) => n < 0)) label(g, 'Empty pattern — click the grid to add notes, or press 🎲 Random', SEQ_LEFT + 10, 18, '#8a93a8');
  }

  // Loop ring: the loop drawn as a circle with a sweeping arm and the automation wrapped inside.
  function drawRing(pos) {
    const c = cv(document.getElementById('loopRing'));
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) / 2 - 12;
    const total = totalSteps();
    const ang = (x) => -Math.PI / 2 + x * Math.PI * 2;   // x in loops (0..1)
    const sincePulse = (performance.now() - transport.pulse) / 1000;
    const pulse = transport.playing ? Math.exp(-sincePulse * 3) : 0;

    if (pulse > 0.01) {
      g.strokeStyle = `rgba(79,182,196,${0.7 * pulse})`;
      g.lineWidth = 10 * pulse + 2;
      g.beginPath(); g.arc(cx, cy, R + 4, 0, Math.PI * 2); g.stroke();
    }
    const cur = pos ? pos.s : -1;
    for (let s = 0; s < total; s++) {
      const a1 = ang(s / total) + 0.02, a2 = ang((s + 1) / total) - 0.02;
      const n = state.seq[s % 16];
      let style = s % 4 === 0 ? '#2b3346' : '#1d2230';
      if (n >= 0) style = pitchColor(midiFreq(state.seqRoot + n), 0.55);
      if (s === cur) style = n >= 0 ? pitchColor(midiFreq(state.seqRoot + n), 1) : '#4fb6c4';
      g.strokeStyle = style;
      g.lineWidth = s === cur ? 16 : 11;
      g.beginPath(); g.arc(cx, cy, R - 6, a1, a2); g.stroke();
    }
    for (let b = 0; b < state.bars; b++) {
      const a = ang(b / state.bars);
      g.strokeStyle = '#8a93a8';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * (R + 2), cy + Math.sin(a) * (R + 2)); g.lineTo(cx + Math.cos(a) * (R - 16), cy + Math.sin(a) * (R - 16)); g.stroke();
    }
    const rIn = R - 20;
    state.lanes.forEach((l, k) => {
      if (!l.on) return;
      g.strokeStyle = LANE_COLORS[k];
      g.fillStyle = LANE_COLORS[k] + '22';
      g.lineWidth = 2;
      g.beginPath();
      for (let p = 0; p <= LANE_PTS; p++) {
        const v = l.pts[p % LANE_PTS];
        const r = rIn * (0.3 + 0.68 * v);
        const a = ang(p / LANE_PTS);
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        if (p === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
      g.stroke();
    });
    const x = pos ? pos.pos / total : 0;
    const a = ang(x);
    if (transport.playing) {
      for (let k = 0; k < 12; k++) {
        g.fillStyle = `rgba(79,182,196,${0.16 * (1 - k / 12)})`;
        g.beginPath();
        g.moveTo(cx, cy);
        g.arc(cx, cy, R - 12, a - (k + 1) * 0.045, a - k * 0.045);
        g.closePath();
        g.fill();
      }
    }
    g.strokeStyle = transport.playing ? '#ffffff' : '#5b6478';
    g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (R - 4), cy + Math.sin(a) * (R - 4)); g.stroke();
    g.fillStyle = transport.playing ? '#4fb6c4' : '#5b6478';
    g.beginPath(); g.arc(cx + Math.cos(a) * (R - 4), cy + Math.sin(a) * (R - 4), 5, 0, Math.PI * 2); g.fill();
    state.lanes.forEach((l, k) => {
      if (!l.on || l.cur == null || !transport.playing) return;
      const r = rIn * (0.3 + 0.68 * l.cur);
      g.fillStyle = LANE_COLORS[k];
      g.shadowColor = LANE_COLORS[k];
      g.shadowBlur = 12;
      g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 5, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0;
    });
    g.fillStyle = 'rgba(13,15,20,0.85)';
    g.beginPath(); g.arc(cx, cy, 42, 0, Math.PI * 2); g.fill();
    g.textAlign = 'center';
    g.fillStyle = '#fff';
    g.font = '600 15px system-ui, sans-serif';
    const big = !transport.playing ? 'STOPPED' : state.loop ? `LOOP ${pos ? pos.loop : 1}` : 'ONE-SHOT';
    g.fillText(big, cx, cy - 2);
    g.font = '11px system-ui, sans-serif';
    g.fillStyle = '#8a93a8';
    const bar = pos ? Math.floor(pos.s / 16) + 1 : 1;
    const beat = pos ? Math.floor((pos.s % 16) / 4) + 1 : 1;
    g.fillText(`bar ${bar}.${beat} · ${state.bpm} BPM`, cx, cy + 15);
    g.textAlign = 'left';
  }

  // ================================================================ automation
  const LANE_SHAPES = [
    { id: 'up', label: '↗ Up' }, { id: 'down', label: '↘ Down' }, { id: 'tri', label: '△ Tri' },
    { id: 'sine', label: '∿ Sine' }, { id: 'square', label: '⊓ Square' }, { id: 'rise', label: '⤒ Rise' },
    { id: 'drop', label: '⤓ Drop' }, { id: 'random', label: '⁂ Random' },
  ];
  function shapeFn(id, p) {
    switch (id) {
      case 'up': return p;
      case 'down': return 1 - p;
      case 'tri': return 1 - Math.abs(2 * p - 1);
      case 'sine': return 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
      case 'square': return p < 0.5 ? 1 : 0;
      case 'rise': return Math.pow(p, 2.5);
      case 'drop': return p < 0.35 ? 1 : Math.exp((-6 * (p - 0.35)) / 0.65);
      default: return p;
    }
  }
  function genLane(l) {
    if (l.shape === 'draw') return;
    const rnd = Array.from({ length: l.cycles }, () => Math.random());
    for (let k = 0; k < LANE_PTS; k++) {
      const x = (k / LANE_PTS) * l.cycles;
      const y = l.shape === 'random' ? rnd[Math.floor(x) % l.cycles] : shapeFn(l.shape, frac(x));
      l.pts[k] = l.lo + (l.hi - l.lo) * y;
    }
  }
  function sampleLane(l, x) {
    const idx = clamp(x, 0, 1) * (LANE_PTS - 1);
    const i0 = Math.floor(idx), i1 = Math.min(i0 + 1, LANE_PTS - 1);
    return l.pts[i0] + (l.pts[i1] - l.pts[i0]) * (idx - i0);
  }

  // While playing, an enabled lane remembers the knob's own value and puts it back when it stops.
  function laneEngage(l) {
    if (transport.playing && l.on && l.base == null) l.base = PARAMS[l.target].get();
  }
  function laneDisengage(l) {
    if (l.base != null) { setParam(l.target, l.base); l.base = null; }
    l.cur = null;
  }

  function applyAutomation() {
    const p = posNow();
    if (!p) return;
    const x = p.pos / totalSteps();
    for (const l of state.lanes) {
      if (!l.on) continue;
      l.cur = sampleLane(l, x);
      setParam(l.target, fromNorm(PARAMS[l.target], l.cur), 0.03);
    }
  }

  let glowed = [];
  function refreshAutoGlow() {
    glowed.forEach((el) => el.classList.remove('auto-a', 'auto-b', 'auto-c', 'auto-m'));
    glowed = [];
    const mark = (target, cls) => (paramUI[target] || []).forEach((u) => {
      const el = u.label || u.inp;
      el.classList.add(cls);
      glowed.push(el);
    });
    (state.mods || []).forEach((m) => { if (m.on) mark(m.target, 'auto-m'); });
    if (!transport.playing) return;
    state.lanes.forEach((l, k) => { if (l.on) mark(l.target, ['auto-a', 'auto-b', 'auto-c'][k]); });
  }

  const lanesEl = document.getElementById('lanes');
  const laneUI = [];
  function buildLanes() {
    lanesEl.innerHTML = state.lanes.map((l, k) => `
      <div class="lane" data-l="${k}">
        <div class="lane-head">
          <button type="button" class="toggle lane-on" data-info="lane">Lane ${'ABC'[k]}</button>
          <label data-info="laneTarget">Controls <select class="lane-target">${AUTO_TARGETS.map((t) => `<option value="${t}">${PARAMS[t].label}</option>`).join('')}</select></label>
          <span class="shapes" data-info="laneShape">${LANE_SHAPES.map((s) => `<button type="button" class="toggle" data-shape="${s.id}">${s.label}</button>`).join('')}</span>
          <label data-info="laneCycles">Repeats <select class="lane-cycles">${[1, 2, 4, 8, 16].map((c) => `<option value="${c}">${c}</option>`).join('')}</select></label>
          <label data-info="laneRange">Low <input type="range" class="lane-lo" min="0" max="1" step="0.01"></label>
          <label data-info="laneRange">High <input type="range" class="lane-hi" min="0" max="1" step="0.01"></label>
        </div>
        <canvas class="scope lane" data-info="lane"></canvas>
      </div>`).join('');
    state.lanes.forEach((l, k) => {
      const root = lanesEl.querySelector(`.lane[data-l="${k}"]`);
      const ui = {
        root,
        on: root.querySelector('.lane-on'),
        target: root.querySelector('.lane-target'),
        shapes: [...root.querySelectorAll('[data-shape]')],
        cycles: root.querySelector('.lane-cycles'),
        lo: root.querySelector('.lane-lo'),
        hi: root.querySelector('.lane-hi'),
        canvas: root.querySelector('canvas'),
      };
      laneUI.push(ui);
      const lane = () => state.lanes[k];
      ui.on.addEventListener('click', () => setLane(k, { on: !lane().on }));
      ui.target.addEventListener('change', () => setLane(k, { target: ui.target.value }));
      ui.shapes.forEach((b) => b.addEventListener('click', () => setLane(k, { shape: b.dataset.shape, on: true })));
      ui.cycles.addEventListener('change', () => setLane(k, { cycles: Number(ui.cycles.value), shape: lane().shape === 'draw' ? 'sine' : lane().shape }));
      ui.lo.addEventListener('input', () => setLane(k, { lo: Number(ui.lo.value), shape: lane().shape === 'draw' ? 'up' : lane().shape }));
      ui.hi.addEventListener('input', () => setLane(k, { hi: Number(ui.hi.value), shape: lane().shape === 'draw' ? 'up' : lane().shape }));

      // freehand drawing
      let lastIdx = null, lastVal = null;
      const paint = (e) => {
        const r = ui.canvas.getBoundingClientRect();
        const idx = clamp(Math.round(((e.clientX - r.left) / r.width) * (LANE_PTS - 1)), 0, LANE_PTS - 1);
        const val = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
        const l = lane();
        if (lastIdx == null || lastIdx === idx) { l.pts[idx] = val; }
        else {
          const a = Math.min(lastIdx, idx), b = Math.max(lastIdx, idx);
          for (let i = a; i <= b; i++) {
            const t = (i - lastIdx) / (idx - lastIdx);
            l.pts[i] = lastVal + (val - lastVal) * t;
          }
        }
        lastIdx = idx; lastVal = val;
      };
      ui.canvas.addEventListener('pointerdown', (e) => {
        ui.canvas.setPointerCapture(e.pointerId);
        lastIdx = null;
        if (lane().shape !== 'draw' || !lane().on) setLane(k, { shape: 'draw', on: true });
        paint(e);
      });
      ui.canvas.addEventListener('pointermove', (e) => { if (lastIdx != null) paint(e); });
      const end = () => { lastIdx = null; };
      ui.canvas.addEventListener('pointerup', end);
      ui.canvas.addEventListener('pointercancel', end);
    });
  }

  function setLane(k, changes) {
    const l = state.lanes[k];
    const retarget = changes.target && changes.target !== l.target;
    if (retarget || changes.on === false) laneDisengage(l);
    Object.assign(l, changes);
    if (changes.shape || changes.cycles || changes.lo != null || changes.hi != null) genLane(l);
    laneEngage(l);
    syncLaneUI(k);
    refreshAutoGlow();
  }

  function syncLaneUI(k) {
    const l = state.lanes[k];
    const ui = laneUI[k];
    ui.on.classList.toggle('on', l.on);
    ui.target.value = l.target;
    ui.shapes.forEach((b) => b.classList.toggle('on', b.dataset.shape === l.shape));
    ui.cycles.value = String(l.cycles);
    ui.lo.value = l.lo;
    ui.hi.value = l.hi;
  }

  function drawLane(k, pos) {
    const l = state.lanes[k];
    const c = cv(laneUI[k].canvas);
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    const total = totalSteps();
    for (let s = 0; s <= total; s += 4) {
      const x = (s / total) * w;
      g.strokeStyle = s % 16 === 0 ? '#3a4358' : '#1c2230';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
    const col = LANE_COLORS[k];
    const yOf = (v) => h - 4 - v * (h - 8);
    g.globalAlpha = l.on ? 1 : 0.35;
    g.beginPath();
    g.moveTo(0, h);
    for (let p = 0; p < LANE_PTS; p++) g.lineTo((p / (LANE_PTS - 1)) * w, yOf(l.pts[p]));
    g.lineTo(w, h);
    g.closePath();
    g.fillStyle = col + '30';
    g.fill();
    g.beginPath();
    for (let p = 0; p < LANE_PTS; p++) {
      const x = (p / (LANE_PTS - 1)) * w, y = yOf(l.pts[p]);
      if (p === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokeStyle = col;
    g.lineWidth = 2;
    g.stroke();
    g.globalAlpha = 1;
    const p = PARAMS[l.target];
    label(g, p.fmt(fromNorm(p, 1)), 6, 13, '#8a93a8');
    label(g, p.fmt(fromNorm(p, 0)), 6, h - 6, '#8a93a8');
    if (pos && l.on) {
      const x = (pos.pos / total) * w;
      g.strokeStyle = '#fff';
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      if (l.cur != null) {
        const y = yOf(l.cur);
        g.fillStyle = col;
        g.shadowColor = col;
        g.shadowBlur = 14;
        g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0;
        label(g, `${p.label} → ${p.fmt(p.get())}`, w - 8, 13, '#fff', 'right');
      }
    } else if (!l.on) {
      label(g, `off — click “Lane ${'ABC'[k]}”, a shape, or draw here`, w - 8, 13, '#8a93a8', 'right');
    } else {
      label(g, `${p.label} — press Play to run`, w - 8, 13, '#8a93a8', 'right');
    }
  }

  // ---------------------------------------------------------------- macros
  const seqEmpty = () => state.seq.every((n) => n < 0);
  const MACROS = {
    sweepUp: { bars: 4, loop: true, lanes: [{ target: 'cutoff', shape: 'rise', cycles: 1, lo: 0.12, hi: 0.95 }, null] },
    sweepDown: { bars: 4, loop: true, lanes: [{ target: 'cutoff', shape: 'down', cycles: 1, lo: 0.12, hi: 0.95 }, null] },
    drop: { bars: 2, loop: false, lanes: [{ target: 'pitch', shape: 'drop', cycles: 1, lo: 0, hi: 0.75 }, { target: 'cutoff', shape: 'drop', cycles: 1, lo: 0.2, hi: 0.9 }] },
    riser: { bars: 4, loop: false, lanes: [{ target: 'pitch', shape: 'rise', cycles: 1, lo: 0.75, hi: 1 }, { target: 'cutoff', shape: 'rise', cycles: 1, lo: 0.2, hi: 1 }] },
    wobble: { bars: 2, loop: true, lanes: [{ target: 'cutoff', shape: 'sine', cycles: 8, lo: 0.15, hi: 0.65 }, null] },
  };
  function runMacro(id) {
    stopTransport();
    if (id === 'clear') {
      state.lanes.forEach((l, k) => setLane(k, { on: false }));
      return;
    }
    const setup = MACROS[id];
    state.bars = setup.bars;
    state.loop = setup.loop;
    setup.lanes.forEach((cfg, k) => setLane(k, cfg ? { ...cfg, on: true } : { on: false }));
    startTransport();
    if (seqEmpty()) startDrone(state.seqRoot + (id === 'riser' ? 12 : 0));
    syncTransportUI();
    showInfo('macros');
  }
  document.querySelectorAll('[data-macro]').forEach((b) => b.addEventListener('click', () => runMacro(b.dataset.macro)));

  // ================================================================ presets
  const off = { vol: 0 };
  const PRESETS = [
    // ---------------- basses
    { cat: 'Bass', name: 'Sub Bass', desc: 'A pure sine with a little triangle: felt more than heard. The foundation of hip-hop and dance tracks.',
      osc: [{ shape: 'sine', vol: 0.9 }, { shape: 'triangle', vol: 0.25 }, off], env: [0.005, 0.3, 0.9, 0.15],
      demo: { bpm: 95, root: 33, gate: 0.85, seq: '0 . . 0 . . 0 . 3 . . 5 . 7 5 .' } },
    { cat: 'Bass', name: 'Reese Bass', desc: 'Two saws detuned against each other create a slow, growling movement (beating), filtered dark. Drum & bass classic.',
      osc: [{ shape: 'saw', fine: -15, vol: 0.7 }, { shape: 'saw', fine: 15, vol: 0.7 }, { shape: 'sine', coarse: -12, vol: 0.5 }], cutoff: 900, res: 2, env: [0.01, 0.5, 0.9, 0.2],
      demo: { bpm: 87, root: 33, gate: 0.98, seq: '0 . . . . . . . 3 . . . 5 . . .', lanes: [{ target: 'cutoff', shape: 'sine', cycles: 2, lo: 0.45, hi: 0.7 }] } },
    { cat: 'Bass', name: 'Acid Bass', desc: 'Saw through a resonant filter that the envelope snaps open on every note — the squelchy 303 sound.',
      osc: [{ shape: 'saw', vol: 0.8 }, { shape: 'square', coarse: -12, vol: 0.3 }, off], cutoff: 350, res: 16, fenv: 3.5, env: [0.003, 0.18, 0.1, 0.1],
      demo: { bpm: 128, root: 36, gate: 0.5, seq: '0 0 12 0 . 0 3 0 12 . 0 10 0 7 12 0', lanes: [{ target: 'cutoff', shape: 'tri', cycles: 1, lo: 0.2, hi: 0.55 }] } },
    { cat: 'Bass', name: 'Square Bass', desc: 'A hollow square with a sine an octave below for weight. Punchy and simple.',
      osc: [{ shape: 'square', vol: 0.6 }, { shape: 'sine', coarse: -12, vol: 0.6 }, off], cutoff: 1200, res: 3, fenv: 1.5, env: [0.005, 0.25, 0.6, 0.1],
      demo: { bpm: 110, root: 36, gate: 0.6, seq: '0 . 0 . 7 . 0 . 10 . 0 . 7 . 12 .' } },
    { cat: 'Bass', name: 'Wobble Bass', desc: 'Detuned saws with the filter cutoff automated in a fast sine — the dubstep “wub”. Watch Lane A move the cutoff knob.',
      osc: [{ shape: 'saw', vol: 0.7 }, { shape: 'saw', fine: 8, vol: 0.6 }, { shape: 'sine', coarse: -12, vol: 0.5 }], cutoff: 300, res: 10, env: [0.01, 0.3, 1, 0.2],
      demo: { bpm: 140, root: 33, bars: 2, gate: 1, seq: '0 . . . . . . . 0 . . . 3 . . .', lanes: [{ target: 'cutoff', shape: 'sine', cycles: 8, lo: 0.15, hi: 0.65 }] } },
    { cat: 'Bass', name: 'LFO Wobble (AM)', desc: 'Osc 3 is set to Fixed Hz (about 3–8 Hz, speeding up) and used as AM, so it chops the volume. Watch its slow speed wheel speed up.',
      osc: [{ shape: 'saw', vol: 0.7 }, { shape: 'square', coarse: -12, vol: 0.5 }, { shape: 'sine', fixed: true, hz: 4, vol: 1 }], am: true, cutoff: 1500, res: 4, env: [0.01, 0.3, 1, 0.2],
      demo: { bpm: 120, root: 33, bars: 2, gate: 1, seq: '0 . . . . . . . 3 . . . 5 . . .', lanes: [{ target: 'o2.hz', shape: 'up', cycles: 1, lo: 0.3, hi: 0.39 }] } },
    { cat: 'Bass', name: 'Drop Bass', desc: 'A big detuned bass whose pitch dives and filter closes over two bars: the bass drop. Lane A = pitch, Lane B = cutoff.',
      osc: [{ shape: 'saw', fine: -10, vol: 0.7 }, { shape: 'square', fine: 10, vol: 0.5 }, { shape: 'sine', coarse: -12, vol: 0.6 }], cutoff: 2500, res: 4, env: [0.005, 0.5, 1, 0.3],
      demo: { bpm: 140, root: 36, bars: 2, gate: 1, seq: '. . . . . . . . . . . . . . . .', drone: 36,
        lanes: [{ target: 'pitch', shape: 'drop', cycles: 1, lo: 0, hi: 0.75 }, { target: 'cutoff', shape: 'drop', cycles: 1, lo: 0.2, hi: 0.85 }] } },
    { cat: 'Bass', name: 'Pluck Bass', desc: 'Zero sustain plus a filter envelope = a short, plucked bass note.',
      osc: [{ shape: 'saw', vol: 0.7 }, { shape: 'saw', coarse: -12, vol: 0.5 }, off], cutoff: 260, res: 5, fenv: 4, env: [0.002, 0.15, 0, 0.1],
      demo: { bpm: 120, root: 36, gate: 0.5, seq: '0 . 0 12 . 0 . 0 3 . 3 . 5 . 7 .' } },

    // ---------------- pads
    { cat: 'Pad', name: 'Warm Pad', desc: 'Detuned saws spread left/right, slow attack and long release, filter breathing slowly. Use headphones.',
      osc: [{ shape: 'saw', fine: -10, pan: -0.6, vol: 0.5 }, { shape: 'saw', fine: 10, pan: 0.6, vol: 0.5 }, { shape: 'triangle', coarse: -12, vol: 0.4 }], cutoff: 1400, res: 2, fenv: 0.5, env: [1.2, 1, 0.8, 2],
      demo: { bpm: 70, root: 48, bars: 2, gate: 1, seq: '0 . . . . . . . 5 . . . . . . .', lanes: [{ target: 'cutoff', shape: 'sine', cycles: 1, lo: 0.4, hi: 0.68 }] } },
    { cat: 'Pad', name: 'Glass Pad', desc: 'Sine + triangle an octave up + sine a 12th up: clean, bell-like harmonics with a slow swell.',
      osc: [{ shape: 'sine', vol: 0.6 }, { shape: 'triangle', coarse: 12, fine: 5, vol: 0.35 }, { shape: 'sine', coarse: 19, vol: 0.2 }], env: [0.8, 1.5, 0.7, 2.5],
      demo: { bpm: 70, root: 60, gate: 1, seq: '0 . . . . . . . 7 . . . . . . .' } },
    { cat: 'Pad', name: 'Dark Pad', desc: 'Squares in two octaves with a hint of noise, filtered low and slowly opening over four bars.',
      osc: [{ shape: 'square', fine: -8, pan: -0.4, vol: 0.5 }, { shape: 'square', coarse: -12, fine: 8, pan: 0.4, vol: 0.5 }, { shape: 'noise', vol: 0.05 }], cutoff: 600, res: 4, env: [1.5, 1, 0.9, 3],
      demo: { bpm: 70, root: 48, bars: 4, gate: 1, seq: '0 . . . . . . . . . . . . . . .', lanes: [{ target: 'cutoff', shape: 'tri', cycles: 1, lo: 0.3, hi: 0.6 }] } },
    { cat: 'Pad', name: 'String Pad', desc: 'Three saws (two detuned, one an octave up) with a medium attack — a classic synth-strings ensemble.',
      osc: [{ shape: 'saw', fine: -7, pan: -0.3, vol: 0.5 }, { shape: 'saw', fine: 7, pan: 0.3, vol: 0.5 }, { shape: 'saw', coarse: 12, vol: 0.25 }], cutoff: 2500, res: 1, env: [0.6, 0.5, 0.85, 1.5],
      demo: { bpm: 80, root: 48, gate: 1, seq: '0 . . . 3 . . . 7 . . . 5 . . .' } },

    // ---------------- leads
    { cat: 'Lead', name: 'Supersaw Lead', desc: 'Three saws, two detuned hard and panned wide: the trance/EDM lead.',
      osc: [{ shape: 'saw', fine: -18, pan: -0.7, vol: 0.6 }, { shape: 'saw', fine: 18, pan: 0.7, vol: 0.6 }, { shape: 'saw', coarse: 12, fine: 5, vol: 0.4 }], cutoff: 6000, res: 2, env: [0.01, 0.3, 0.8, 0.3],
      demo: { bpm: 128, root: 60, gate: 0.8, seq: '0 . 0 . 7 . 5 . 3 . 5 . 7 . 10 .' } },
    { cat: 'Lead', name: 'Square Lead', desc: 'Two squares an octave apart, a little filter bite. Retro and cutting.',
      osc: [{ shape: 'square', vol: 0.7 }, { shape: 'square', coarse: 12, fine: 4, vol: 0.3 }, off], cutoff: 3000, res: 3, fenv: 1, env: [0.005, 0.2, 0.7, 0.15],
      demo: { bpm: 120, root: 60, gate: 0.7, seq: '0 . 3 . 5 . 7 . 10 . 7 . 5 . 3 .' } },
    { cat: 'Lead', name: 'Fifths Lead', desc: 'A saw plus another a perfect fifth (+7 semitones) up: instant power-chord lead.',
      osc: [{ shape: 'saw', vol: 0.6 }, { shape: 'saw', coarse: 7, vol: 0.5 }, { shape: 'sine', coarse: -12, vol: 0.4 }], cutoff: 4000, res: 2, env: [0.01, 0.3, 0.8, 0.25],
      demo: { bpm: 110, root: 57, gate: 0.85, seq: '0 . . 0 . . 3 . . 5 . . 3 . 0 .' } },
    { cat: 'Lead', name: 'Chiptune Arp', desc: 'One square wave, short notes, fast arpeggio — 8-bit video game style.',
      osc: [{ shape: 'square', vol: 0.7 }, off, off], env: [0.002, 0.1, 0.5, 0.05],
      demo: { bpm: 140, root: 60, gate: 0.45, seq: '0 4 7 12 0 4 7 12 0 3 7 12 0 3 7 12' } },

    // ---------------- keys & plucks
    { cat: 'Keys & plucks', name: 'Pluck', desc: 'A bright note that dies away quickly: no sustain, filter envelope snapping open.',
      osc: [{ shape: 'saw', vol: 0.7 }, { shape: 'square', coarse: 12, vol: 0.2 }, off], cutoff: 500, res: 4, fenv: 4.5, env: [0.002, 0.25, 0, 0.3],
      demo: { bpm: 120, root: 60, gate: 0.3, seq: '0 7 12 7 0 7 12 7 3 7 10 7 3 7 10 7' } },
    { cat: 'Keys & plucks', name: 'Bell', desc: 'Sines at non-whole-number ratios (inharmonic) with a long decay — metallic, like a bell.',
      osc: [{ shape: 'sine', vol: 0.7 }, { shape: 'sine', coarse: 19, fine: 2, vol: 0.35 }, { shape: 'sine', coarse: 34, fine: -14, vol: 0.15 }], env: [0.002, 1.8, 0, 1.5],
      demo: { bpm: 90, root: 72, gate: 0.5, seq: '0 . . . 7 . . . 4 . . . 12 . . .' } },
    { cat: 'Keys & plucks', name: 'Organ', desc: 'Sines at the octave and a 12th, like organ drawbars. On/off envelope.',
      osc: [{ shape: 'sine', vol: 0.6 }, { shape: 'sine', coarse: 12, vol: 0.4 }, { shape: 'sine', coarse: 19, vol: 0.3 }], env: [0.005, 0.1, 1, 0.05],
      demo: { bpm: 110, root: 60, gate: 0.9, seq: '0 . 4 . 7 . 4 . 5 . 9 . 12 . 9 .' } },
    { cat: 'Keys & plucks', name: 'Tremolo Keys', desc: 'Triangle keys with Osc 3 as a 5 Hz AM wobble — like an electric piano’s tremolo.',
      osc: [{ shape: 'triangle', vol: 0.7 }, { shape: 'sine', coarse: 12, vol: 0.2 }, { shape: 'sine', fixed: true, hz: 5, vol: 0.4 }], am: true, env: [0.003, 1.2, 0.3, 0.6],
      demo: { bpm: 90, root: 60, gate: 0.9, seq: '0 . . 4 . . 7 . . . 5 . . 9 . .' } },

    // ---------------- fx
    { cat: 'FX', name: 'Riser', desc: 'Detuned saws and noise climbing in pitch while the filter opens over four bars — the build-up before a drop.',
      osc: [{ shape: 'saw', fine: -12, vol: 0.5 }, { shape: 'saw', fine: 12, vol: 0.5 }, { shape: 'noise', vol: 0.25 }], cutoff: 300, res: 6, env: [0.5, 0.5, 1, 1],
      demo: { bpm: 128, root: 48, bars: 4, gate: 1, seq: '. . . . . . . . . . . . . . . .', drone: 48,
        lanes: [{ target: 'pitch', shape: 'rise', cycles: 1, lo: 0.75, hi: 1 }, { target: 'cutoff', shape: 'rise', cycles: 1, lo: 0.2, hi: 1 }] } },
    { cat: 'FX', name: 'Laser Zap', desc: 'Each note’s pitch falls fast, repeated every two steps by the automation lane.',
      osc: [{ shape: 'square', vol: 0.6 }, { shape: 'saw', coarse: 12, vol: 0.3 }, off], env: [0.001, 0.25, 0, 0.1],
      demo: { bpm: 120, root: 60, gate: 0.6, seq: '0 . 0 . 0 . 0 . 0 . 0 . 0 . 0 .', lanes: [{ target: 'pitch', shape: 'down', cycles: 8, lo: 0.45, hi: 1 }] } },
    { cat: 'FX', name: 'Wind', desc: 'Pure noise through a resonant filter whose cutoff and resonance drift — no oscillator pitch at all.',
      osc: [{ shape: 'noise', vol: 0.7 }, off, off], cutoff: 800, res: 12, env: [1, 0.5, 1, 2],
      demo: { bpm: 80, root: 48, bars: 4, gate: 1, seq: '. . . . . . . . . . . . . . . .', drone: 48,
        lanes: [{ target: 'cutoff', shape: 'sine', cycles: 1, lo: 0.35, hi: 0.72 }, { target: 'res', shape: 'tri', cycles: 2, lo: 0.3, hi: 0.7 }] } },
    { cat: 'FX', name: 'Gated Chop', desc: 'A pad chopped on and off by a square-shaped automation of the master volume: trance gate.',
      osc: [{ shape: 'saw', fine: -10, vol: 0.6 }, { shape: 'saw', fine: 10, vol: 0.6 }, { shape: 'saw', coarse: -12, vol: 0.4 }], cutoff: 3000, res: 2, env: [0.05, 0.5, 1, 0.5],
      demo: { bpm: 128, root: 48, gate: 1, seq: '0 . . . . . . . 3 . . . . . . .', lanes: [{ target: 'master', shape: 'square', cycles: 16, lo: 0.05, hi: 0.65 }] } },
  ];

  const parseSeq = (str) => str.trim().split(/\s+/).map((t) => (t === '.' ? -1 : Number(t)));

  function applyPatch(P) {
    for (let i = 0; i < 3; i++) state.osc[i] = { ...defaultOsc(), ...(P.osc[i] || off) };
    state.am = !!P.am;
    state.cutoff = P.cutoff ?? 18000;
    state.res = P.res ?? 0;
    state.fenv = P.fenv ?? 0;
    state.pitch = 0;
    if (P.master != null) state.master = P.master;
    [state.attack, state.decay, state.sustain, state.release] = P.env || [0.01, 0.3, 0.8, 0.3];
    // effects: presets give short forms (present = on), saved/shared sounds give the full state
    if (P.gatorFull) state.gator = { ...P.gatorFull, steps: [...P.gatorFull.steps] };
    else if (P.gator) {
      const { pattern, ...rest } = P.gator;
      state.gator = { ...defaultGator(), ...rest, on: true, steps: pattern ? parseGate(pattern) : defaultGator().steps };
    } else state.gator = defaultGator();
    state.dly = P.dlyFull ? { ...P.dlyFull } : P.dly ? { ...defaultDly(), ...P.dly, on: true } : defaultDly();
    state.rev = P.revFull ? { ...P.revFull } : P.rev ? { ...defaultRev(), ...P.rev, on: true } : defaultRev();
    state.mods.forEach((m, k) => {
      modDisengage(m, false);
      Object.assign(m, newMod(k ? 'revMix' : 'dlyTime'), (P.mods && P.mods[k]) || {});
    });
    for (let i = 0; i < 3; i++) { rebuildTable(i); rebuildPeriodicWave(i); }
    if (actx) {
      for (const v of activeVoices) { for (let i = 0; i < 3; i++) v.refreshSource(i); v.routeOsc3(); v.update(); }
      buildIR();
      updateFx(0.01);
      gateRestart();
    }
    syncAll();
  }

  const presetCats = document.getElementById('presetCats');
  const presetDesc = document.getElementById('presetDesc');
  const demoToggle = document.getElementById('demoToggle');
  const presetBtns = [];
  function buildPresets() {
    const cats = [...new Set(PRESETS.map((p) => p.cat))];
    for (const cat of cats) {
      const row = document.createElement('div');
      row.className = 'preset-cat';
      row.innerHTML = `<span class="cat-name">${cat}</span>`;
      PRESETS.forEach((p, k) => {
        if (p.cat !== cat) return;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'preset-btn';
        b.textContent = p.name;
        b.addEventListener('click', () => loadPreset(k));
        row.appendChild(b);
        presetBtns[k] = b;
      });
      presetCats.appendChild(row);
    }
  }

  // k: index into PRESETS, or a patch object (surprise, saved or shared sound). play=false loads silently.
  function loadPreset(k, play = true) {
    const isIndex = typeof k === 'number';
    const P = isIndex ? PRESETS[k] : k;
    if (play && !ensureAudio()) return;
    stopTransport();
    stopAll();
    setHold(false);
    clearLesson();
    applyPatch(P);
    presetBtns.forEach((b, j) => b && b.classList.toggle('on', isIndex && j === k));
    presetDesc.innerHTML = `<b>${P.name}</b> — ${P.desc}`;
    if (P.demo && (demoToggle.checked || !isIndex)) {
      const d = P.demo;
      state.bpm = d.bpm ?? 120;
      state.bars = d.bars ?? 1;
      state.gate = d.gate ?? 0.5;
      state.seqRoot = d.root ?? 48;
      state.loop = d.loop ?? true;
      if (d.seq) state.seq = parseSeq(d.seq);
      const lanes = d.lanes || [];
      state.lanes.forEach((l, j) => {
        setLane(j, lanes[j] ? { ...lanes[j], pts: l.pts, on: true } : { on: false });
        if (lanes[j] && lanes[j].pts) l.pts.set(lanes[j].pts);
      });
      applyDelaySync();
      syncAll();
      if (play) {
        startTransport();
        if (d.drone != null) startDrone(d.drone);
      }
    } else if (play) {
      applyDelaySync();
      const v = new Voice(state.seqRoot + 12, 0.9);
      v.release(actx.currentTime + 0.8);
      lastNote = state.seqRoot + 12;
    }
    refreshAutoGlow();
    markDirty();
  }

  // ================================================================ effects: gator, echo/chorus/delay, reverb
  // Chain after the voices:  voices -> bus -> GATOR -> (dry + ECHO) -> (dry + REVERB) -> master
  const fx = {};
  const GATE_SHAPES = [
    { id: 'square', label: '⊓ Square' }, { id: 'down', label: '◺ Pluck' }, { id: 'up', label: '◿ Swell' },
    { id: 'tri', label: '△ Tri' }, { id: 'sine', label: '◠ Smooth' },
  ];
  const GATE_PATTERNS = {
    Trance: 'X.XX.XX.X.XX.XX.',
    '16ths': 'XXXXXXXXXXXXXXXX',
    Offbeat: '..X...X...X...X.',
    Half: 'XXXX....XXXX....',
    Stutter: 'XxXx..XX.xXxX...',
    Build: 'x.x.x.x.XxXxXXXX',
    Heartbeat: 'X.x.............',
  };
  const parseGate = (str) => [...str].slice(0, 16).map((c) => (c === 'X' ? 1 : c === 'x' ? 0.55 : 0));
  const DLY_SYNC = { off: 0, '1/32': 0.125, '1/16': 0.25, '1/8': 0.5, '1/8d': 0.75, '1/4': 1, '1/4d': 1.5, '1/2': 2 };
  const DLY_MODES = {
    Chorus: { time: 0.018, fb: 0.1, depth: 0.004, rate: 0.8, spread: 1, mix: 0.5, tone: 12000, sync: 'off' },
    Flanger: { time: 0.003, fb: 0.7, depth: 0.0025, rate: 0.2, spread: 0.3, mix: 0.6, tone: 14000, sync: 'off' },
    Slapback: { time: 0.09, fb: 0.1, depth: 0, rate: 0.5, spread: 0, mix: 0.4, tone: 6000, sync: 'off' },
    Echo: { fb: 0.45, depth: 0, rate: 0.5, spread: 0, mix: 0.35, tone: 3500, sync: '1/4' },
    'Ping-pong': { fb: 0.5, depth: 0, rate: 0.5, spread: 1, mix: 0.4, tone: 5000, sync: '1/8d' },
    Dub: { fb: 0.72, depth: 0.0008, rate: 0.3, spread: 0.7, mix: 0.5, tone: 1200, sync: '1/8d' },
  };
  const REV_MODES = {
    Room: { size: 0.8, pre: 0.005, damp: 6000, mix: 0.25 },
    Plate: { size: 1.8, pre: 0, damp: 12000, mix: 0.3 },
    Hall: { size: 2.8, pre: 0.02, damp: 7000, mix: 0.35 },
    Cathedral: { size: 7, pre: 0.04, damp: 4000, mix: 0.45 },
    Infinite: { size: 10, pre: 0.03, damp: 9000, mix: 0.6 },
  };

  const defaultGator = () => ({ on: false, depth: 1, len: 0.7, smooth: 0.08, rate: 16, shape: 'square', steps: parseGate(GATE_PATTERNS.Trance) });
  const defaultDly = () => ({ on: false, mix: 0.35, time: 0.375, fb: 0.4, tone: 4000, spread: 0.6, rate: 0.5, depth: 0, sync: '1/8d' });
  const defaultRev = () => ({ on: false, mix: 0.3, size: 2.5, pre: 0.02, damp: 7000 });
  state.gator = defaultGator();
  state.dly = defaultDly();
  state.rev = defaultRev();

  const fmtMs = (s) => (s < 1 ? (s * 1000).toFixed(s < 0.01 ? 1 : 0) + ' ms' : s.toFixed(2) + ' s');
  defParam('gateDepth', { label: 'Gator depth', kind: 'fx', min: 0, max: 1, step: 0.01, get: () => state.gator.depth, set: (v) => { state.gator.depth = v; }, fmt: fmtPct });
  defParam('gateLen', { label: 'Gator gate length', kind: 'fx', min: 0.05, max: 1, step: 0.01, get: () => state.gator.len, set: (v) => { state.gator.len = v; }, fmt: fmtPct });
  defParam('gateSmooth', { label: 'Gator smoothing', kind: 'fx', min: 0, max: 0.5, step: 0.01, get: () => state.gator.smooth, set: (v) => { state.gator.smooth = v; }, fmt: fmtPct });
  defParam('dlyMix', { label: 'Echo mix', kind: 'fx', min: 0, max: 1, step: 0.01, get: () => state.dly.mix, set: (v) => { state.dly.mix = v; }, fmt: fmtPct });
  defParam('dlyTime', { label: 'Echo time', kind: 'fx', min: 0.001, max: 1.5, log: true, get: () => state.dly.time, set: (v) => { state.dly.time = v; }, fmt: fmtMs });
  defParam('dlyFb', { label: 'Echo feedback', kind: 'fx', min: 0, max: 0.95, step: 0.01, get: () => state.dly.fb, set: (v) => { state.dly.fb = v; }, fmt: fmtPct });
  defParam('dlyTone', { label: 'Echo tone', kind: 'fx', min: 300, max: 18000, log: true, get: () => state.dly.tone, set: (v) => { state.dly.tone = v; }, fmt: fmtHz });
  defParam('dlySpread', { label: 'Echo stereo spread', kind: 'fx', min: 0, max: 1, step: 0.01, get: () => state.dly.spread, set: (v) => { state.dly.spread = v; }, fmt: fmtPct });
  defParam('dlyRate', { label: 'Echo wobble rate', kind: 'fx', min: 0.05, max: 8, log: true, get: () => state.dly.rate, set: (v) => { state.dly.rate = v; }, fmt: fmtHz });
  defParam('dlyDepth', { label: 'Echo wobble depth', kind: 'fx', min: 0, max: 0.012, step: 0.0001, get: () => state.dly.depth, set: (v) => { state.dly.depth = v; }, fmt: (v) => (v * 1000).toFixed(1) + ' ms' });
  defParam('revMix', { label: 'Reverb mix', kind: 'fx', min: 0, max: 1, step: 0.01, get: () => state.rev.mix, set: (v) => { state.rev.mix = v; }, fmt: fmtPct });
  defParam('revSize', { label: 'Reverb decay', kind: 'rev', min: 0.2, max: 10, log: true, get: () => state.rev.size, set: (v) => { state.rev.size = v; }, fmt: (v) => v.toFixed(2) + ' s' });
  defParam('revPre', { label: 'Reverb pre-delay', kind: 'fx', min: 0, max: 0.25, step: 0.001, get: () => state.rev.pre, set: (v) => { state.rev.pre = v; }, fmt: (v) => Math.round(v * 1000) + ' ms' });
  defParam('revDamp', { label: 'Reverb damping', kind: 'fx', min: 500, max: 18000, log: true, get: () => state.rev.damp, set: (v) => { state.rev.damp = v; }, fmt: fmtHz });
  AUTO_TARGETS.push('gateDepth', 'gateLen', 'gateSmooth', 'dlyMix', 'dlyTime', 'dlyFb', 'dlyTone', 'dlySpread', 'dlyRate', 'dlyDepth', 'revMix', 'revPre', 'revDamp');

  function buildFxGraph() {
    fx.bus = actx.createGain();
    fx.gate = actx.createGain();
    fx.bus.connect(fx.gate);
    // echo / chorus / delay: two cross-fed delay lines (ping-pong) with a tone filter and an LFO on the time
    fx.dIn = actx.createGain();
    fx.dRin = actx.createGain();
    fx.dL = actx.createDelay(2);
    fx.dR = actx.createDelay(2);
    fx.toneL = actx.createBiquadFilter(); fx.toneL.type = 'lowpass';
    fx.toneR = actx.createBiquadFilter(); fx.toneR.type = 'lowpass';
    fx.fbL = actx.createGain(); fx.fbR = actx.createGain();
    fx.panL = actx.createStereoPanner(); fx.panR = actx.createStereoPanner();
    fx.dWet = actx.createGain(); fx.dWet.gain.value = 0;
    fx.gate.connect(fx.dIn);
    fx.dIn.connect(fx.dL);
    fx.dIn.connect(fx.dRin).connect(fx.dR);
    fx.dL.connect(fx.toneL).connect(fx.fbL).connect(fx.dR);
    fx.dR.connect(fx.toneR).connect(fx.fbR).connect(fx.dL);
    fx.dL.connect(fx.panL).connect(fx.dWet);
    fx.dR.connect(fx.panR).connect(fx.dWet);
    fx.lfo = actx.createOscillator();
    fx.lfoL = actx.createGain(); fx.lfoR = actx.createGain();
    fx.lfo.connect(fx.lfoL).connect(fx.dL.delayTime);
    fx.lfo.connect(fx.lfoR).connect(fx.dR.delayTime);
    fx.lfo.start();
    fx.post = actx.createGain();
    fx.gate.connect(fx.post);
    fx.dWet.connect(fx.post);
    // reverb: pre-delay -> convolution with a generated room -> damping filter
    fx.rDry = actx.createGain();
    fx.rPre = actx.createDelay(1);
    fx.conv = actx.createConvolver();
    fx.rDamp = actx.createBiquadFilter(); fx.rDamp.type = 'lowpass';
    fx.rWet = actx.createGain(); fx.rWet.gain.value = 0;
    fx.post.connect(fx.rDry).connect(masterGain);
    fx.post.connect(fx.rPre).connect(fx.conv).connect(fx.rDamp).connect(fx.rWet).connect(masterGain);
    buildIR();
    updateFx(0);
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      fxTick((now - last) / 1000);
      last = now;
    }, 25);
  }

  function updateFx(tau = 0.02) {
    if (!actx || !fx.bus) return;
    const t = actx.currentTime;
    const set = (param, v) => (tau ? param.setTargetAtTime(v, t, tau) : (param.value = v));
    const d = state.dly;
    const dep = Math.min(d.depth, d.time * 0.9);
    set(fx.dL.delayTime, d.time);
    set(fx.dR.delayTime, d.time);
    set(fx.fbL.gain, d.fb); set(fx.fbR.gain, d.fb);
    set(fx.toneL.frequency, d.tone); set(fx.toneR.frequency, d.tone);
    set(fx.panL.pan, -d.spread); set(fx.panR.pan, d.spread);
    set(fx.lfo.frequency, d.rate);
    set(fx.lfoL.gain, dep); set(fx.lfoR.gain, -dep);
    set(fx.dRin.gain, d.time < 0.04 ? 1 : 0);   // short (chorus/flanger) times feed both sides
    set(fx.dWet.gain, d.on ? d.mix : 0);
    const r = state.rev;
    set(fx.rWet.gain, r.on ? r.mix * 1.2 : 0);
    set(fx.rDry.gain, r.on ? 1 - r.mix * 0.5 : 1);
    set(fx.rPre.delayTime, r.pre);
    set(fx.rDamp.frequency, r.damp);
  }

  // A reverb "room" is just a burst of noise that dies away: -60 dB after `size` seconds.
  function buildIR() {
    if (!actx) return;
    const sr = actx.sampleRate;
    const size = state.rev.size;
    const n = Math.floor(sr * Math.min(10, size * 1.2 + 0.1));
    const buf = actx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const fadeIn = Math.min(1, t / 0.004);
        data[i] = (Math.random() * 2 - 1) * Math.exp((-6.9 * t) / size) * fadeIn;
      }
      // a few early reflections
      for (let k = 0; k < 8; k++) {
        const i = Math.floor(sr * (0.007 + Math.random() * 0.06 * Math.min(1, size)));
        if (i < n) data[i] += (Math.random() < 0.5 ? -1 : 1) * (0.9 - k * 0.08);
      }
    }
    fx.conv.buffer = buf;
  }
  let irTimer = null;
  const scheduleIR = () => { clearTimeout(irTimer); irTimer = setTimeout(buildIR, 150); };

  function applyDelaySync() {
    const beats = DLY_SYNC[state.dly.sync];
    if (!beats) return;
    state.dly.time = clamp((beats * 60) / state.bpm, 0.001, 1.5);
    syncParam('dlyTime');
    updateFx();
  }

  // ---------------------------------------------------------------- gator scheduling
  const gateClock = { next: 0, step: 0, log: [] };
  const gateStepDur = () => 60 / state.bpm / (state.gator.rate / 4);
  function gateShapeVal(id, q) {
    switch (id) {
      case 'down': return 1 - q;
      case 'up': return q;
      case 'tri': return 1 - Math.abs(2 * q - 1);
      case 'sine': return Math.sin(Math.PI * q);
      default: return 1;
    }
  }
  // Level of one gate step at position p (0..1 through the step), before depth.
  function gateLevelAt(level, p) {
    const g = state.gator;
    if (p > g.len || level <= 0) return 0;
    const q = p / g.len;
    let s = gateShapeVal(g.shape, q);
    if (g.smooth > 0) s *= Math.min(1, q / g.smooth, (1 - q) / g.smooth);
    return level * s;
  }
  function gateCurve(level) {
    const N = 48, c = new Float32Array(N);
    for (let k = 0; k < N; k++) c[k] = 1 - state.gator.depth * (1 - gateLevelAt(level, k / (N - 1)));
    return c;
  }
  function gateTick() {
    if (!actx || !fx.gate || !state.gator.on) return;
    const now = actx.currentTime;
    if (gateClock.next < now) gateClock.next = now + 0.02;
    while (gateClock.next < now + 0.12) {
      const d = gateStepDur();
      const s = gateClock.step % 16;
      try { fx.gate.gain.setValueCurveAtTime(gateCurve(state.gator.steps[s]), gateClock.next, d * 0.995); } catch (e) { /* overlapping curve: skip */ }
      gateClock.log.push({ s, t: gateClock.next, d });
      if (gateClock.log.length > 64) gateClock.log.shift();
      gateClock.step++;
      gateClock.next += d;
    }
  }
  function gateRestart(at) {
    if (!actx || !fx.gate) return;
    const now = actx.currentTime;
    holdAt(fx.gate.gain, now, 1);
    gateClock.log = [];
    if (state.gator.on) {
      gateClock.next = at ?? now + 0.03;
      gateClock.step = 0;
      gateTick();
    } else {
      fx.gate.gain.setTargetAtTime(1, now, 0.01);
    }
  }
  function gatePos() {
    if (!actx || !state.gator.on) return null;
    const now = actx.currentTime;
    const log = gateClock.log;
    for (let k = log.length - 1; k >= 0; k--) {
      if (log[k].t <= now) return { s: log[k].s, f: clamp((now - log[k].t) / log[k].d, 0, 1) };
    }
    return null;
  }

  // ---------------------------------------------------------------- modulators (free-running LFOs on any knob)
  const MOD_SHAPES = [{ id: 'sine', label: '∿' }, { id: 'tri', label: '△' }, { id: 'saw', label: '⟋' }, { id: 'square', label: '⊓' }, { id: 'random', label: '⁂' }];
  const newMod = (target) => ({ on: false, target, shape: 'sine', rate: 0.5, depth: 0.4, phase: 0, base: null, cur: null, rnd: 0, lastCycle: -1 });
  state.mods = [newMod('dlyTime'), newMod('revMix')];
  function modValue(m) {
    const p = m.phase;
    switch (m.shape) {
      case 'tri': return 1 - 4 * Math.abs(p - 0.5);
      case 'saw': return 2 * p - 1;
      case 'square': return p < 0.5 ? 1 : -1;
      case 'random': return m.rnd;
      default: return Math.sin(2 * Math.PI * p);
    }
  }
  function modTick(dt) {
    for (const m of state.mods) {
      if (!m.on) continue;
      const next = m.phase + m.rate * dt;
      if (Math.floor(next) !== Math.floor(m.phase)) m.rnd = Math.random() * 2 - 1;
      m.phase = frac(next);
      const p = PARAMS[m.target];
      if (m.base == null) m.base = p.get();
      m.cur = clamp(toNorm(p, m.base) + modValue(m) * m.depth * 0.5, 0, 1);
      setParam(m.target, fromNorm(p, m.cur), 0.03);
    }
  }
  function modDisengage(m, restore = true) {
    if (m.base != null && restore) setParam(m.target, m.base);
    m.base = null; m.cur = null;
  }
  function setMod(k, changes) {
    const m = state.mods[k];
    if ((changes.target && changes.target !== m.target) || changes.on === false) modDisengage(m);
    Object.assign(m, changes);
    syncModUI(k);
    refreshAutoGlow();
  }
  function fxTick(dt) {
    gateTick();
    modTick(dt);
  }

  // ---------------------------------------------------------------- effects UI
  const gatorEl = document.getElementById('gator');
  const echoEl = document.getElementById('echo');
  const reverbEl = document.getElementById('reverb');
  const modsEl = document.getElementById('mods');
  const fxUI = {};

  function setFxOn(which, on) {
    state[which].on = on;
    if (which === 'gator') gateRestart(transport.playing ? undefined : undefined);
    updateFx();
    syncFxUI();
    markDirty();
  }

  function buildFxUI() {
    gatorEl.innerHTML = `
      <div class="panel-head"><h2>Gator — chop the sound in rhythm</h2>
        <button type="button" class="toggle fx-on" data-info="gator">Off</button></div>
      <canvas class="scope fxcanvas gate-canvas" data-info="gateGrid"></canvas>
      <div class="chip-row" data-info="gateShape">${GATE_SHAPES.map((s) => `<button type="button" class="toggle" data-gshape="${s.id}">${s.label}</button>`).join('')}</div>
      <div class="chip-row" data-info="gatePattern"><span class="dim small">Pattern</span>${Object.keys(GATE_PATTERNS).map((n) => `<button type="button" class="toggle" data-gpat="${n}">${n}</button>`).join('')}<button type="button" class="toggle" data-gpat="__random">🎲</button></div>
      <div class="chip-row" data-info="gateRate"><span class="dim small">Speed</span><span class="seg">${[4, 8, 16, 32].map((r) => `<button type="button" data-grate="${r}">1/${r}</button>`).join('')}</span></div>
      <div class="sliders">
        <label data-info="gateDepth">Depth<output></output><input type="range" data-param="gateDepth"></label>
        <label data-info="gateLen">Gate length<output></output><input type="range" data-param="gateLen"></label>
        <label data-info="gateSmooth">Smoothing<output></output><input type="range" data-param="gateSmooth"></label>
      </div>`;
    echoEl.innerHTML = `
      <div class="panel-head"><h2>Echo · Chorus · Delay</h2>
        <button type="button" class="toggle fx-on" data-info="echo">Off</button></div>
      <canvas class="scope fxcanvas" data-info="echoView"></canvas>
      <div class="chip-row" data-info="echoModes">${Object.keys(DLY_MODES).map((n) => `<button type="button" class="toggle" data-dmode="${n}">${n}</button>`).join('')}</div>
      <div class="chip-row" data-info="dlySync"><span class="dim small">Sync to tempo</span>
        <select class="dly-sync">${Object.keys(DLY_SYNC).map((k) => `<option value="${k}">${k === 'off' ? 'free (ms)' : k}</option>`).join('')}</select></div>
      <div class="sliders">
        <label data-info="dlyMix">Mix<output></output><input type="range" data-param="dlyMix"></label>
        <label data-info="dlyTime">Time<output></output><input type="range" data-param="dlyTime"></label>
        <label data-info="dlyFb">Feedback<output></output><input type="range" data-param="dlyFb"></label>
        <label data-info="dlyTone">Tone<output></output><input type="range" data-param="dlyTone"></label>
        <label data-info="dlySpread">Stereo spread<output></output><input type="range" data-param="dlySpread"></label>
        <label data-info="dlyRate">Wobble rate<output></output><input type="range" data-param="dlyRate"></label>
        <label data-info="dlyDepth">Wobble depth<output></output><input type="range" data-param="dlyDepth"></label>
      </div>`;
    reverbEl.innerHTML = `
      <div class="panel-head"><h2>Reverb — the room around the sound</h2>
        <button type="button" class="toggle fx-on" data-info="reverb">Off</button></div>
      <canvas class="scope fxcanvas" data-info="revView"></canvas>
      <div class="chip-row" data-info="revModes">${Object.keys(REV_MODES).map((n) => `<button type="button" class="toggle" data-rmode="${n}">${n}</button>`).join('')}</div>
      <div class="sliders">
        <label data-info="revMix">Mix<output></output><input type="range" data-param="revMix"></label>
        <label data-info="revSize">Decay (size)<output></output><input type="range" data-param="revSize"></label>
        <label data-info="revPre">Pre-delay<output></output><input type="range" data-param="revPre"></label>
        <label data-info="revDamp">Damping<output></output><input type="range" data-param="revDamp"></label>
      </div>`;
    modsEl.innerHTML = state.mods.map((m, k) => `
      <div class="modrow" data-m="${k}">
        <div class="lane-head">
          <button type="button" class="toggle mod-on" data-info="mods">Mod ${k + 1}</button>
          <label data-info="modTarget">Wobbles <select class="mod-target">${AUTO_TARGETS.map((t) => `<option value="${t}">${PARAMS[t].label}</option>`).join('')}</select></label>
          <span class="shapes" data-info="modShape">${MOD_SHAPES.map((s) => `<button type="button" class="toggle" data-mshape="${s.id}">${s.label}</button>`).join('')}</span>
          <label data-info="modRate">Rate <input type="range" class="mod-rate" min="0" max="1" step="0.001"><output class="mod-rate-out"></output></label>
          <label data-info="modDepth">Depth <input type="range" class="mod-depth" min="0" max="1" step="0.01"><output class="mod-depth-out"></output></label>
        </div>
        <canvas class="scope modcanvas" data-info="mods"></canvas>
      </div>`).join('');

    fxUI.gateOn = gatorEl.querySelector('.fx-on');
    fxUI.echoOn = echoEl.querySelector('.fx-on');
    fxUI.revOn = reverbEl.querySelector('.fx-on');
    fxUI.gateCanvas = gatorEl.querySelector('canvas');
    fxUI.echoCanvas = echoEl.querySelector('canvas');
    fxUI.revCanvas = reverbEl.querySelector('canvas');
    fxUI.sync = echoEl.querySelector('.dly-sync');
    fxUI.gateOn.addEventListener('click', () => { if (!ensureAudio()) return; setFxOn('gator', !state.gator.on); });
    fxUI.echoOn.addEventListener('click', () => { if (!ensureAudio()) return; setFxOn('dly', !state.dly.on); });
    fxUI.revOn.addEventListener('click', () => { if (!ensureAudio()) return; setFxOn('rev', !state.rev.on); });
    gatorEl.querySelectorAll('[data-gshape]').forEach((b) => b.addEventListener('click', () => { state.gator.shape = b.dataset.gshape; if (!state.gator.on && ensureAudio()) setFxOn('gator', true); syncFxUI(); }));
    gatorEl.querySelectorAll('[data-gpat]').forEach((b) => b.addEventListener('click', () => {
      const n = b.dataset.gpat;
      state.gator.steps = n === '__random'
        ? Array.from({ length: 16 }, (_, i) => (i === 0 || Math.random() < 0.6 ? (Math.random() < 0.7 ? 1 : 0.55) : 0))
        : parseGate(GATE_PATTERNS[n]);
      if (!state.gator.on && ensureAudio()) setFxOn('gator', true);
    }));
    gatorEl.querySelectorAll('[data-grate]').forEach((b) => b.addEventListener('click', () => { state.gator.rate = Number(b.dataset.grate); syncFxUI(); }));
    echoEl.querySelectorAll('[data-dmode]').forEach((b) => b.addEventListener('click', () => {
      if (!ensureAudio()) return;
      Object.assign(state.dly, DLY_MODES[b.dataset.dmode], { on: true });
      applyDelaySync();
      ['dlyMix', 'dlyTime', 'dlyFb', 'dlyTone', 'dlySpread', 'dlyRate', 'dlyDepth'].forEach(syncParam);
      updateFx(); syncFxUI();
      showInfo('echoModes');
    }));
    fxUI.sync.addEventListener('change', () => { state.dly.sync = fxUI.sync.value; applyDelaySync(); });
    reverbEl.querySelectorAll('[data-rmode]').forEach((b) => b.addEventListener('click', () => {
      if (!ensureAudio()) return;
      Object.assign(state.rev, REV_MODES[b.dataset.rmode], { on: true });
      ['revMix', 'revSize', 'revPre', 'revDamp'].forEach(syncParam);
      buildIR(); updateFx(); syncFxUI();
      showInfo('revModes');
    }));

    // drawing on the gator grid sets each step's level
    let painting = false;
    const paintGate = (e) => {
      const r = fxUI.gateCanvas.getBoundingClientRect();
      const s = clamp(Math.floor(((e.clientX - r.left) / r.width) * 16), 0, 15);
      let v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      if (v < 0.1) v = 0;
      state.gator.steps[s] = Math.round(v * 20) / 20;
    };
    fxUI.gateCanvas.addEventListener('pointerdown', (e) => {
      fxUI.gateCanvas.setPointerCapture(e.pointerId);
      painting = true;
      if (!state.gator.on && ensureAudio()) setFxOn('gator', true);
      paintGate(e);
    });
    fxUI.gateCanvas.addEventListener('pointermove', (e) => { if (painting) paintGate(e); });
    fxUI.gateCanvas.addEventListener('pointerup', () => { painting = false; });
    fxUI.gateCanvas.addEventListener('pointercancel', () => { painting = false; });

    fxUI.mods = state.mods.map((m, k) => {
      const root = modsEl.querySelector(`.modrow[data-m="${k}"]`);
      const ui = {
        on: root.querySelector('.mod-on'),
        target: root.querySelector('.mod-target'),
        shapes: [...root.querySelectorAll('[data-mshape]')],
        rate: root.querySelector('.mod-rate'),
        rateOut: root.querySelector('.mod-rate-out'),
        depth: root.querySelector('.mod-depth'),
        depthOut: root.querySelector('.mod-depth-out'),
        canvas: root.querySelector('canvas'),
      };
      ui.on.addEventListener('click', () => { ensureAudio(); setMod(k, { on: !state.mods[k].on }); });
      ui.target.addEventListener('change', () => setMod(k, { target: ui.target.value }));
      ui.shapes.forEach((b) => b.addEventListener('click', () => setMod(k, { shape: b.dataset.mshape })));
      ui.rate.addEventListener('input', () => setMod(k, { rate: 0.05 * Math.pow(200, Number(ui.rate.value)) }));
      ui.depth.addEventListener('input', () => setMod(k, { depth: Number(ui.depth.value) }));
      return ui;
    });
  }

  function syncModUI(k) {
    const m = state.mods[k];
    const ui = fxUI.mods && fxUI.mods[k];
    if (!ui) return;
    ui.on.classList.toggle('on', m.on);
    ui.target.value = m.target;
    ui.shapes.forEach((b) => b.classList.toggle('on', b.dataset.mshape === m.shape));
    ui.rate.value = Math.log(m.rate / 0.05) / Math.log(200);
    ui.rateOut.textContent = fmtHz(m.rate);
    ui.depth.value = m.depth;
    ui.depthOut.textContent = fmtPct(m.depth);
  }

  function syncFxUI() {
    const g = state.gator;
    fxUI.gateOn.classList.toggle('on', g.on); fxUI.gateOn.textContent = g.on ? 'On' : 'Off';
    fxUI.echoOn.classList.toggle('on', state.dly.on); fxUI.echoOn.textContent = state.dly.on ? 'On' : 'Off';
    fxUI.revOn.classList.toggle('on', state.rev.on); fxUI.revOn.textContent = state.rev.on ? 'On' : 'Off';
    gatorEl.querySelectorAll('[data-gshape]').forEach((b) => b.classList.toggle('on', b.dataset.gshape === g.shape));
    gatorEl.querySelectorAll('[data-grate]').forEach((b) => b.classList.toggle('on', Number(b.dataset.grate) === g.rate));
    fxUI.sync.value = state.dly.sync;
    gatorEl.classList.toggle('fx-off', !g.on);
    echoEl.classList.toggle('fx-off', !state.dly.on);
    reverbEl.classList.toggle('fx-off', !state.rev.on);
    state.mods.forEach((m, k) => syncModUI(k));
    syncChain();
  }

  // ---------------------------------------------------------------- effects pictures
  let lastHit = -10;   // audio time of the most recent note start (echo taps and reverb rings follow it)

  function drawGator() {
    const c = cv(fxUI.gateCanvas);
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    const gp = gatePos();
    const cw = w / 16;
    for (let s = 0; s < 16; s++) {
      const x0 = s * cw;
      g.fillStyle = s % 4 === 0 ? '#161b27' : '#11151e';
      g.fillRect(x0, 0, cw, h);
      const lvl = state.gator.steps[s];
      const active = gp && gp.s === s;
      // the shape of this gate, drawn as the volume over the step
      g.beginPath();
      g.moveTo(x0 + 1, h - 2);
      for (let k = 0; k <= 24; k++) {
        const p = k / 24;
        const v = 1 - state.gator.depth * (1 - gateLevelAt(lvl, p));
        g.lineTo(x0 + 1 + p * (cw - 2), h - 2 - v * (h - 6));
      }
      g.lineTo(x0 + cw - 1, h - 2);
      g.closePath();
      const hue = 150 + 60 * lvl;
      g.fillStyle = `hsla(${hue}, 80%, ${active ? 65 : 45}%, ${state.gator.on ? (active ? 0.95 : 0.6) : 0.25})`;
      g.fill();
      if (active) {
        g.fillStyle = '#fff';
        g.fillRect(x0 + gp.f * cw - 1, 0, 2, h);
      }
      g.strokeStyle = '#2a3142';
      g.strokeRect(x0 + 0.5, 0.5, cw - 1, h - 1);
    }
    if (gp) {
      const lvl = state.gator.steps[gp.s];
      const vol = 1 - state.gator.depth * (1 - gateLevelAt(lvl, gp.f));
      label(g, `volume now ${fmtPct(vol)}`, w - 6, 13, '#fff', 'right');
    } else {
      label(g, state.gator.on ? 'starting…' : 'off — click a step or a pattern to start', w - 6, 13, '#8a93a8', 'right');
    }
  }

  function drawEcho() {
    const c = cv(fxUI.echoCanvas);
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    const d = state.dly;
    const span = clamp(d.time * 9, 0.08, 4);
    const X = (t) => 8 + (t / span) * (w - 16);
    const base = h - 14;
    g.strokeStyle = '#1c2230';
    g.beginPath(); g.moveTo(0, base); g.lineTo(w, base); g.stroke();
    const now = actx ? actx.currentTime : 0;
    const age = now - lastHit;
    const wob = d.depth * Math.sin(2 * Math.PI * d.rate * (actx ? now : performance.now() / 1000));
    // dry hit
    const flash0 = Math.max(0, 1 - age / 0.15);
    g.fillStyle = `rgba(255,255,255,${0.6 + 0.4 * flash0})`;
    g.fillRect(X(0) - 2, base - (h - 30), 4, h - 30);
    label(g, 'dry', X(0) + 4, 13, '#8a93a8');
    for (let n = 1; n < 40; n++) {
      const t = n * d.time + (n % 2 ? wob : -wob);
      if (t > span) break;
      const amp = (d.on ? d.mix : 0.15) * Math.pow(d.fb, n - 1) * (d.time < 0.04 && n === 1 ? 1 : 1);
      if (amp < 0.004) break;
      const right = n % 2 === 0;
      const tapPan = right ? d.spread : -d.spread;
      const bright = clamp(Math.log(d.tone / 300) / Math.log(60), 0.15, 1) * Math.pow(0.85, n - 1);
      const hit = Math.max(0, 1 - Math.abs(age - n * d.time) / 0.08);
      const hgt = amp * (h - 30) * (1 + 0.3 * hit);
      g.fillStyle = tapPan < -0.05 ? `hsla(330, 90%, ${45 + 25 * bright + 20 * hit}%, 0.9)` : tapPan > 0.05 ? `hsla(190, 90%, ${45 + 25 * bright + 20 * hit}%, 0.9)` : `hsla(50, 90%, ${45 + 25 * bright + 20 * hit}%, 0.9)`;
      g.shadowColor = g.fillStyle;
      g.shadowBlur = 14 * hit;
      g.fillRect(X(t) - 2, base - hgt, 4, hgt);
      g.shadowBlur = 0;
    }
    // travelling pulse since the last note
    if (age >= 0 && age < span) {
      g.fillStyle = 'rgba(79,182,196,0.8)';
      g.beginPath(); g.arc(X(age), base + 6, 3, 0, Math.PI * 2); g.fill();
    }
    const kind = d.time < 0.006 ? 'flanger' : d.time < 0.04 ? 'chorus' : d.time < 0.12 ? 'slapback' : 'echo';
    label(g, `${kind} · ${fmtMs(d.time)} · ${d.sync !== 'off' ? d.sync + ' note' : 'free'} · ${d.on ? 'on' : 'off'}`, w - 6, 13, d.on ? '#fff' : '#8a93a8', 'right');
    label(g, 'L', 4, h - 2, 'hsl(330,90%,65%)');
    label(g, 'R', 16, h - 2, 'hsl(190,90%,65%)');
    label(g, `${fmtMs(span)} →`, w - 6, h - 2, '#5b6478', 'right');
  }

  // fixed noise texture for the reverb picture
  const revNoise = Float32Array.from({ length: 400 }, () => Math.random());
  function drawReverb() {
    const c = cv(fxUI.revCanvas);
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    const r = state.rev;
    const span = Math.max(1, r.size * 1.25);
    const split = w * 0.62;
    const X = (t) => 6 + (t / span) * (split - 12);
    const base = h - 12;
    const bright = clamp(Math.log(r.damp / 500) / Math.log(36), 0, 1);
    // decay picture: noise inside an exponential envelope, after the pre-delay
    g.beginPath();
    g.moveTo(X(0), base);
    for (let k = 0; k < revNoise.length; k++) {
      const t = r.pre + (k / revNoise.length) * (span - r.pre);
      const env = Math.exp((-6.9 * (t - r.pre)) / r.size);
      g.lineTo(X(t), base - env * (0.35 + 0.65 * revNoise[k]) * (h - 26) * (r.on ? 1 : 0.5));
    }
    g.lineTo(X(span), base);
    g.closePath();
    g.fillStyle = `hsla(${210 - 170 * bright}, 70%, ${35 + 20 * bright}%, ${r.on ? 0.8 : 0.3})`;
    g.fill();
    g.fillStyle = '#fff';
    g.fillRect(X(0) - 1, 18, 2, base - 18);
    if (r.pre > 0.002) label(g, `pre ${Math.round(r.pre * 1000)} ms`, X(r.pre) + 3, 26, '#8a93a8');
    g.strokeStyle = 'rgba(255,255,255,0.3)';
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(X(r.size), 18); g.lineTo(X(r.size), base); g.stroke();
    g.setLineDash([]);
    label(g, `−60 dB at ${r.size.toFixed(1)} s`, Math.min(X(r.size) + 3, split - 70), 40, '#8a93a8');
    // the room: rings spreading from the last note, fading as the reverb dies
    const cx = split + (w - split) / 2, cy = h / 2;
    const roomR = Math.min((w - split) / 2, h / 2) - 6;
    const roomScale = clamp(Math.log(r.size / 0.2) / Math.log(50), 0.25, 1);
    g.strokeStyle = '#2a3142';
    g.strokeRect(cx - roomR * roomScale, cy - roomR * roomScale, 2 * roomR * roomScale, 2 * roomR * roomScale);
    const age = actx ? actx.currentTime - lastHit : 99;
    if (r.on && age >= 0) {
      for (let k = 0; k < 5; k++) {
        const a = age - k * 0.12;
        if (a < 0) continue;
        const rad = (a * 160) % (roomR * roomScale * 1.4);
        const alpha = Math.exp((-6.9 * a) / r.size) * 0.8;
        if (alpha < 0.02) continue;
        g.strokeStyle = `hsla(${210 - 170 * bright}, 80%, 65%, ${alpha})`;
        g.lineWidth = 2;
        g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.stroke();
      }
      g.lineWidth = 1;
    }
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(cx, cy, 3, 0, Math.PI * 2); g.fill();
    label(g, r.on ? `mix ${fmtPct(r.mix)}` : 'off', w - 6, 13, r.on ? '#fff' : '#8a93a8', 'right');
  }

  function drawMods() {
    state.mods.forEach((m, k) => {
      const ui = fxUI.mods[k];
      const c = cv(ui.canvas);
      if (!c) return;
      const { g, w, h } = c;
      g.clearRect(0, 0, w, h);
      const saved = { phase: m.phase, rnd: m.rnd };
      g.strokeStyle = m.on ? '#7cf3c9' : '#3a4358';
      g.lineWidth = 2;
      g.beginPath();
      for (let x = 0; x <= w; x++) {
        m.phase = frac(saved.phase + (x / w) * 2 - 1);
        if (m.shape === 'random') m.rnd = Math.sin(Math.floor(saved.phase + (x / w) * 2 - 1) * 12.9898) % 1;
        const y = h / 2 - modValue(m) * (h / 2 - 6) * Math.max(0.15, m.depth);
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      m.phase = saved.phase; m.rnd = saved.rnd;
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(w / 2, h / 2 - modValue(m) * (h / 2 - 6) * Math.max(0.15, m.depth), 5, 0, Math.PI * 2); g.fill();
      const p = PARAMS[m.target];
      label(g, m.on ? `${p.label} → ${p.fmt(p.get())}` : 'off — click “Mod ' + (k + 1) + '” to start wobbling a knob', w - 6, 13, m.on ? '#fff' : '#8a93a8', 'right');
    });
  }

  // ---------------------------------------------------------------- signal chain strip
  const chainEl = document.getElementById('chain');
  function syncChain() {
    if (!chainEl) return;
    const on = { gator: state.gator.on, echo: state.dly.on, reverb: state.rev.on, filter: state.cutoff < 17000 || state.res > 0.5 };
    chainEl.querySelectorAll('[data-stage]').forEach((el) => {
      const s = el.dataset.stage;
      if (s in on) el.classList.toggle('bypass', !on[s]);
    });
  }
  if (chainEl) {
    chainEl.querySelectorAll('[data-stage]').forEach((el) => el.addEventListener('click', () => {
      const target = document.getElementById(el.dataset.scroll);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  }
  function drawChain(env) {
    if (!chainEl) return;
    chainEl.style.setProperty('--lvl', env.toFixed(2));
  }

  // ================================================================ inspire: surprise me & mutate
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const inspireMsg = (html) => { presetDesc.innerHTML = html; };

  function surprise() {
    const kind = pick(['Bass', 'Pad', 'Lead', 'Pluck', 'Keys', 'FX']);
    const shapes = ['sine', 'triangle', 'square', 'saw', 'rsaw'];
    const intervals = [0, 0, 7, 12, -12, 5, 19, 24, 3, 4];
    const osc = [0, 1, 2].map((i) => ({
      shape: kind === 'FX' && i === 2 && Math.random() < 0.5 ? 'noise' : pick(shapes),
      coarse: i === 0 ? 0 : pick(intervals) + (kind === 'Bass' && i === 2 ? -12 : 0),
      fine: Math.round(rnd(-14, 14) * (kind === 'Pad' || kind === 'Lead' ? 1.4 : 0.6)),
      vol: i === 0 ? rnd(0.55, 0.8) : Math.random() < 0.2 ? 0 : rnd(0.2, 0.6),
      pan: kind === 'Pad' ? rnd(-0.7, 0.7) : rnd(-0.25, 0.25),
    }));
    const env = {
      Bass: [0.005, rnd(0.15, 0.5), rnd(0.3, 1), 0.15], Pad: [rnd(0.4, 1.8), 1, rnd(0.6, 0.9), rnd(1.2, 3)],
      Lead: [0.01, 0.3, rnd(0.6, 0.9), 0.3], Pluck: [0.002, rnd(0.15, 0.4), 0, 0.3], Keys: [0.003, rnd(0.5, 1.5), rnd(0.2, 0.5), 0.6],
      FX: [rnd(0.01, 1), 0.5, rnd(0.5, 1), rnd(0.5, 2)],
    }[kind];
    const cutoff = { Bass: rnd(200, 1500), Pad: rnd(600, 4000), Lead: rnd(1500, 8000), Pluck: rnd(300, 1500), Keys: rnd(1500, 9000), FX: rnd(300, 6000) }[kind];
    const P = {
      osc, env, cutoff, res: rnd(0, kind === 'Bass' || kind === 'FX' ? 16 : 8), fenv: kind === 'Pluck' || kind === 'Bass' ? rnd(1.5, 4.5) : rnd(0, 1.5),
      am: Math.random() < 0.15,
      dly: Math.random() < 0.6 ? { ...pick(Object.values(DLY_MODES)) } : null,
      rev: Math.random() < 0.7 ? { ...pick(Object.values(REV_MODES)) } : null,
      gator: (kind === 'Pad' || kind === 'FX') && Math.random() < 0.45 ? { pattern: pick(Object.values(GATE_PATTERNS)), shape: pick(GATE_SHAPES).id, rate: pick([8, 16, 16, 32]) } : null,
    };
    if (P.am) P.osc[2] = { shape: 'sine', fixed: true, hz: rnd(2, 9), vol: rnd(0.4, 1) };
    const scale = pick([[0, 3, 5, 7, 10, 12], [0, 2, 4, 7, 9, 12], [0, 2, 3, 5, 7, 8, 10, 12]]);
    const density = { Bass: 0.55, Pad: 0.15, Lead: 0.5, Pluck: 0.7, Keys: 0.4, FX: 0.15 }[kind];
    const seq = Array.from({ length: 16 }, (_, s) => (s === 0 || Math.random() < density ? pick(scale) : -1));
    const demo = {
      bpm: Math.round(rnd(kind === 'Pad' ? 70 : 100, kind === 'Pad' ? 100 : 140)),
      root: { Bass: 33 + Math.floor(rnd(0, 6)), Pad: 48, Lead: 60, Pluck: 60, Keys: 60, FX: 48 }[kind],
      gate: kind === 'Pad' || kind === 'FX' ? 1 : rnd(0.35, 0.85),
      bars: kind === 'Pad' ? 2 : 1,
      seq: seq.map((n) => (n < 0 ? '.' : n)).join(' '),
      lanes: Math.random() < 0.5 ? [{ target: pick(['cutoff', 'cutoff', 'dlyMix', 'res', 'pitch']), shape: pick(['sine', 'tri', 'up', 'rise']), cycles: pick([1, 2, 4]), lo: rnd(0.2, 0.5), hi: rnd(0.55, 0.85) }] : [],
    };
    if (demo.lanes[0] && demo.lanes[0].target === 'pitch') Object.assign(demo.lanes[0], { lo: 0.72, hi: 0.78 });
    loadPreset({ name: `Surprise ${kind}`, desc: describePatch(P, kind), ...P, demo }, true);
  }

  function describePatch(P, kind) {
    const on = P.osc.filter((o) => o.vol > 0);
    const shapesTxt = on.map((o) => (o.fixed ? `a ${o.hz.toFixed(1)} Hz LFO` : `${o.shape === 'rsaw' ? 'rounded saw' : o.shape}${o.coarse ? ` at ${o.coarse > 0 ? '+' : ''}${o.coarse} st` : ''}`)).join(', ');
    const fxTxt = [P.gator && 'a rhythmic gator', P.dly && `${P.dly.time && P.dly.time < 0.04 ? 'chorus' : 'echo'}`, P.rev && `${P.rev.size > 5 ? 'huge' : P.rev.size > 2 ? 'hall' : 'room'} reverb`].filter(Boolean).join(', ');
    return `A random <b>${kind.toLowerCase()}</b>: ${shapesTxt}, through a ${fmtHz(P.cutoff)} filter${fxTxt ? `, with ${fxTxt}` : ''}. Like it? Save it in <b>My sounds</b>. Not quite? Press <b>Mutate</b>.`;
  }

  function mutate() {
    if (!ensureAudio()) return;
    const amt = 0.25;
    const changes = [];
    for (let i = 0; i < 3; i++) {
      const o = state.osc[i];
      if (Math.random() < 0.18) {
        const s = pick(['sine', 'triangle', 'square', 'saw', 'rsaw']);
        if (s !== o.shape && o.shape !== 'noise') { setOscProp(i, 'shape', s); changes.push(`Osc ${i + 1} → ${s}`); }
      }
      setParam(`o${i}.fine`, o.fine + Math.round(rnd(-12, 12) * amt * 2));
      if (o.vol > 0) setParam(`o${i}.vol`, clamp(o.vol + rnd(-0.15, 0.15), 0.1, 1));
      if (Math.random() < 0.12 && !o.fixed) { const c = pick([-12, 12, 7, -5]); setParam(`o${i}.coarse`, clamp(o.coarse + c, -36, 36)); changes.push(`Osc ${i + 1} ${c > 0 ? '+' : ''}${c} st`); }
    }
    setParam('cutoff', state.cutoff * Math.pow(2, rnd(-1, 1) * amt * 3));
    setParam('res', clamp(state.res + rnd(-3, 3), 0, 20));
    if (state.dly.on) { setParam('dlyFb', clamp(state.dly.fb + rnd(-0.15, 0.15), 0, 0.85)); setParam('dlyMix', clamp(state.dly.mix + rnd(-0.1, 0.1), 0.05, 0.8)); }
    if (state.rev.on) setParam('revMix', clamp(state.rev.mix + rnd(-0.1, 0.1), 0.05, 0.8));
    if (Math.random() < 0.3) { const s = Math.floor(rnd(0, 16)); state.seq[s] = state.seq[s] < 0 ? pick([0, 3, 5, 7, 12]) : -1; changes.push(`step ${s + 1} changed`); }
    inspireMsg(`<b>Mutated</b>: small random nudges to tuning, levels, filter${state.dly.on || state.rev.on ? ' and effects' : ''}${changes.length ? ' — ' + changes.join(', ') : ''}. Keep pressing to evolve the sound.`);
    if (!transport.playing && !activeVoices.size) { const v = new Voice(state.seqRoot + 12, 0.9); v.release(actx.currentTime + 0.6); }
  }

  document.getElementById('surpriseBtn').addEventListener('click', surprise);
  document.getElementById('mutateBtn').addEventListener('click', mutate);

  // ================================================================ my sounds: save, share link, record
  const STORE_KEY = '3xoso.sounds.v1';
  function getPatch() {
    const r2 = (v) => Math.round(v * 1000) / 1000;
    return {
      v: 1,
      osc: state.osc.map((o) => ({ ...o })), am: state.am, cutoff: r2(state.cutoff), res: state.res, fenv: state.fenv,
      env: [state.attack, state.decay, state.sustain, state.release], master: state.master,
      gator: { ...state.gator, steps: [...state.gator.steps] }, dly: { ...state.dly }, rev: { ...state.rev },
      demo: {
        bpm: state.bpm, bars: state.bars, gate: state.gate, root: state.seqRoot, loop: state.loop,
        seq: state.seq.map((n) => (n < 0 ? '.' : n)).join(' '),
        lanes: state.lanes.map((l) => (l.on ? { target: l.target, shape: l.shape, cycles: l.cycles, lo: r2(l.lo), hi: r2(l.hi), pts: l.shape === 'draw' ? Array.from(l.pts, r2) : undefined } : null)),
      },
      mods: state.mods.map((m) => ({ on: m.on, target: m.target, shape: m.shape, rate: r2(m.rate), depth: m.depth })),
    };
  }
  // Patches from links or storage are untrusted: keep only known keys with sane values.
  function sanitizePatch(P) {
    if (!P || typeof P !== 'object' || !Array.isArray(P.osc)) return null;
    const num = (v, a, b, d) => (Number.isFinite(Number(v)) ? clamp(Number(v), a, b) : d);
    const one = (v, list, d) => (list.includes(v) ? v : d);
    const shapes = SHAPES.map((s) => s.id);
    const osc = [0, 1, 2].map((i) => {
      const o = P.osc[i] || {};
      return {
        shape: one(o.shape, shapes, 'sine'), coarse: Math.round(num(o.coarse, -48, 48, 0)), fine: Math.round(num(o.fine, -100, 100, 0)),
        vol: num(o.vol, 0, 1, 0), pan: num(o.pan, -1, 1, 0), phase: Math.round(num(o.phase, 0, 360, 0)),
        invert: !!o.invert, mute: !!o.mute, solo: !!o.solo, fixed: !!o.fixed, hz: num(o.hz, 0.1, 8000, 2),
      };
    });
    const env = Array.isArray(P.env) ? [num(P.env[0], 0.001, 4, 0.01), num(P.env[1], 0.01, 4, 0.3), num(P.env[2], 0, 1, 0.8), num(P.env[3], 0.01, 6, 0.3)] : undefined;
    const g = P.gator && typeof P.gator === 'object' ? {
      on: !!P.gator.on, depth: num(P.gator.depth, 0, 1, 1), len: num(P.gator.len, 0.05, 1, 0.7), smooth: num(P.gator.smooth, 0, 0.5, 0.08),
      rate: one(Number(P.gator.rate), [4, 8, 16, 32], 16), shape: one(P.gator.shape, GATE_SHAPES.map((x) => x.id), 'square'),
      steps: Array.from({ length: 16 }, (_, k) => num(Array.isArray(P.gator.steps) ? P.gator.steps[k] : 0, 0, 1, 0)),
    } : null;
    const d = P.dly && typeof P.dly === 'object' ? {
      on: !!P.dly.on, mix: num(P.dly.mix, 0, 1, 0.35), time: num(P.dly.time, 0.001, 1.5, 0.375), fb: num(P.dly.fb, 0, 0.95, 0.4), tone: num(P.dly.tone, 300, 18000, 4000),
      spread: num(P.dly.spread, 0, 1, 0.6), rate: num(P.dly.rate, 0.05, 8, 0.5), depth: num(P.dly.depth, 0, 0.012, 0), sync: one(P.dly.sync, Object.keys(DLY_SYNC), 'off'),
    } : null;
    const r = P.rev && typeof P.rev === 'object' ? { on: !!P.rev.on, mix: num(P.rev.mix, 0, 1, 0.3), size: num(P.rev.size, 0.2, 10, 2.5), pre: num(P.rev.pre, 0, 0.25, 0.02), damp: num(P.rev.damp, 500, 18000, 7000) } : null;
    const laneShapes = [...LANE_SHAPES.map((x) => x.id), 'draw'];
    const dm = P.demo && typeof P.demo === 'object' ? P.demo : null;
    const demo = dm ? {
      bpm: Math.round(num(dm.bpm, 60, 180, 120)), bars: one(Number(dm.bars), [1, 2, 4], 1), gate: num(dm.gate, 0.1, 1, 0.5), root: Math.round(num(dm.root, 24, 72, 48)), loop: dm.loop !== false,
      seq: typeof dm.seq === 'string' ? dm.seq.split(/\s+/).slice(0, 16).map((t) => (t === '.' ? '.' : String(Math.round(num(t, 0, 12, 0))))).join(' ') : undefined,
      lanes: Array.isArray(dm.lanes) ? dm.lanes.slice(0, 3).map((l) => (l && AUTO_TARGETS.includes(l.target) ? {
        target: l.target, shape: one(l.shape, laneShapes, 'sine'), cycles: one(Number(l.cycles), [1, 2, 4, 8, 16], 1), lo: num(l.lo, 0, 1, 0.1), hi: num(l.hi, 0, 1, 0.9),
        pts: Array.isArray(l.pts) ? Array.from({ length: LANE_PTS }, (_, k) => num(l.pts[k], 0, 1, 0)) : undefined,
      } : null)) : [],
    } : undefined;
    const mods = Array.isArray(P.mods) ? P.mods.slice(0, 2).map((m) => (m && AUTO_TARGETS.includes(m.target) ? {
      on: !!m.on, target: m.target, shape: one(m.shape, MOD_SHAPES.map((x) => x.id), 'sine'), rate: num(m.rate, 0.05, 10, 0.5), depth: num(m.depth, 0, 1, 0.4),
    } : null)) : undefined;
    return {
      osc, env, am: !!P.am, cutoff: num(P.cutoff, 30, 18000, 18000), res: num(P.res, 0, 24, 0), fenv: num(P.fenv, 0, 6, 0), master: num(P.master, 0, 1, 0.6),
      gatorFull: g, dlyFull: d, revFull: r, mods, demo,
    };
  }

  function loadStore() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (e) { return []; } }
  function saveStore(list) { try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return true; } catch (e) { return false; } }

  const soundsList = document.getElementById('soundsList');
  const soundName = document.getElementById('soundName');
  const soundsMsg = document.getElementById('soundsMsg');
  function renderSounds() {
    const list = loadStore();
    soundsList.innerHTML = '';
    if (!list.length) { soundsList.innerHTML = '<li class="dim small">Nothing saved yet.</li>'; return; }
    list.forEach((s, k) => {
      const li = document.createElement('li');
      const load = document.createElement('button');
      load.type = 'button'; load.className = 'toggle'; load.textContent = s.name;
      load.addEventListener('click', () => { loadPreset({ ...sanitizePatch(s.patch), name: s.name, desc: 'One of your saved sounds.' }, true); });
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'toggle del'; del.textContent = '×'; del.title = 'Delete';
      del.addEventListener('click', () => { const l = loadStore(); l.splice(k, 1); saveStore(l); renderSounds(); });
      li.append(load, del);
      soundsList.appendChild(li);
    });
  }
  document.getElementById('saveSound').addEventListener('click', () => {
    const name = (soundName.value || '').trim() || `My sound ${loadStore().length + 1}`;
    const list = loadStore();
    list.unshift({ name: name.slice(0, 40), patch: getPatch(), date: Date.now() });
    soundsMsg.textContent = saveStore(list.slice(0, 50)) ? `Saved “${name}” in this browser.` : 'Could not save (browser storage is blocked).';
    soundName.value = '';
    renderSounds();
  });
  document.getElementById('shareSound').addEventListener('click', async () => {
    const json = JSON.stringify(getPatch());
    const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = `${location.origin}${location.pathname}#p=${b64}`;
    try { await navigator.clipboard.writeText(url); soundsMsg.textContent = 'Share link copied — paste it anywhere. Opening it loads this exact sound.'; }
    catch (e) { soundsMsg.textContent = 'Your browser blocked copying — copy the address from the address bar instead; it now contains this sound.'; }
    history.replaceState(null, '', '#p=' + b64);
  });
  function loadFromHash() {
    const m = location.hash.match(/^#p=([A-Za-z0-9_-]+)/);
    if (!m) return false;
    try {
      let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const P = sanitizePatch(JSON.parse(decodeURIComponent(escape(atob(b64)))));
      if (!P) return false;
      loadPreset({ ...P, name: 'Shared sound', desc: 'Loaded from a share link. Press <b>▶ Play</b> to hear it.' }, false);
      return true;
    } catch (e) { return false; }
  }


  // ================================================================ chord mode, undo/redo, banks, MIDI export
  const $ = (id) => document.getElementById(id);
  $('chordSel').addEventListener('change', (e) => { chordName = CHORDS[e.target.value] ? e.target.value : 'off'; });

  // Undo / redo: snapshot the sound after each edit settles (sliders, buttons, drawing).
  const hist = { stack: [], at: -1, timer: 0, busy: false };
  const histSnap = () => JSON.stringify(getPatch());
  function histSync() { $('undoBtn').disabled = hist.at <= 0; $('redoBtn').disabled = hist.at >= hist.stack.length - 1; }
  function histPush() {
    if (hist.busy) return;
    const snap = histSnap();
    if (snap === hist.stack[hist.at]) return;
    hist.stack.length = hist.at + 1;
    hist.stack.push(snap);
    if (hist.stack.length > 60) hist.stack.shift();
    hist.at = hist.stack.length - 1;
    histSync();
  }
  function histGo(d) {
    const k = hist.at + d;
    if (k < 0 || k >= hist.stack.length) return;
    const P = sanitizePatch(JSON.parse(hist.stack[k]));
    if (!P) return;
    hist.busy = true;
    hist.at = k;
    applyPatch(P);
    hist.busy = false;
    histSync();
  }
  ['input', 'change', 'pointerup'].forEach((ev) => document.addEventListener(ev, () => {
    if (hist.busy) return;
    clearTimeout(hist.timer);
    hist.timer = setTimeout(histPush, 350);
  }, true));
  $('undoBtn').addEventListener('click', () => histGo(-1));
  $('redoBtn').addEventListener('click', () => histGo(1));
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.target.closest('input[type=text], select')) return;
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); histGo(e.shiftKey ? 1 : -1); }
    else if (k === 'y') { e.preventDefault(); histGo(1); }
  });
  histPush();

  // Sound banks: a whole library as one .json file (share, sell or back up preset packs).
  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  $('bankExport').addEventListener('click', () => {
    const list = loadStore();
    if (!list.length) { soundsMsg.textContent = 'Save a sound first, then export your bank.'; return; }
    const bank = { format: '3xoso-bank', version: 1, maker: 'Circuit Drift Labs', created: new Date().toISOString(), sounds: list };
    download('3xoso-bank.json', new Blob([JSON.stringify(bank, null, 1)], { type: 'application/json' }));
    soundsMsg.textContent = `Exported ${list.length} sound${list.length === 1 ? '' : 's'} to 3xoso-bank.json.`;
  });
  $('bankImport').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const bank = JSON.parse(await f.text());
      if (bank.format !== '3xoso-bank' || !Array.isArray(bank.sounds)) throw new Error('not a bank');
      const ok = bank.sounds.slice(0, 200).map((s) => ({ name: String(s.name || 'Imported').slice(0, 40), patch: s.patch, date: Date.now() }))
        .filter((s) => sanitizePatch(s.patch));
      saveStore([...ok, ...loadStore()].slice(0, 200));
      soundsMsg.textContent = `Imported ${ok.length} sound${ok.length === 1 ? '' : 's'}.`;
      renderSounds();
    } catch (err) { soundsMsg.textContent = 'That file is not a 3xOSO sound bank.'; }
  });

  // MIDI export: the step sequencer as a Standard MIDI File to drop into any DAW.
  function midiFile() {
    const PPQ = 480, step = PPQ / 4, len = Math.max(step, Math.round(state.gate * step));
    const vl = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
    const ev = [];
    const steps = totalSteps();
    for (let s = 0; s < steps; s++) {
      const n = state.seq[s % 16];
      if (n < 0) continue;
      const note = clamp(state.seqRoot + n, 0, 127);
      ev.push([s * step, [0x90, note, 100]], [s * step + len, [0x80, note, 0]]);
    }
    ev.sort((a, b) => a[0] - b[0] || a[1][0] - b[1][0]);
    const mpq = Math.round(60000000 / state.bpm);
    const trk = [0, 0xff, 0x51, 3, mpq >> 16 & 255, mpq >> 8 & 255, mpq & 255];
    let t = 0;
    for (const [at, d] of ev) { trk.push(...vl(at - t), ...d); t = at; }
    trk.push(...vl(Math.max(0, steps * step - t)), 0xff, 0x2f, 0);
    const u32 = (n) => [n >>> 24, n >> 16 & 255, n >> 8 & 255, n & 255];
    return new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, PPQ >> 8, PPQ & 255, 0x4d, 0x54, 0x72, 0x6b, ...u32(trk.length), ...trk]);
  }
  $('midiExport').addEventListener('click', () => {
    if (state.seq.every((n) => n < 0)) { soundsMsg.textContent = 'The sequencer is empty — add some steps first.'; return; }
    download('3xoso-pattern.mid', new Blob([midiFile()], { type: 'audio/midi' }));
    soundsMsg.textContent = `Exported ${state.bars} bar${state.bars > 1 ? 's' : ''} at ${state.bpm} BPM to 3xoso-pattern.mid.`;
  });

  // Recorder: taps the final output and writes a 16-bit stereo WAV.
  const rec = { node: null, chunks: [], on: false, start: 0, frames: 0 };
  const recBtn = document.getElementById('recBtn');
  const recOut = document.getElementById('recOut');
  async function startRecording() {
    if (!ensureAudio()) return;
    if (!rec.node) {
      try { await makeWorkletRecorder(); } catch (e) { makeScriptRecorder(); }
    }
    rec.chunks = []; rec.frames = 0; rec.on = true; rec.start = performance.now();
    if (rec.node.port) rec.node.port.postMessage(true);
    recBtn.classList.add('rec-on');
    recBtn.textContent = '■ Stop recording';
    recOut.innerHTML = '';
  }
  const onRecChunk = (pair) => {
    if (!rec.on) return;
    rec.chunks.push(pair);
    rec.frames += pair[0].length;
    if (rec.frames > actx.sampleRate * 300) stopRecording();
  };
  // Fallback for browsers/pages where AudioWorklet modules cannot load (e.g. opened from a file).
  function makeScriptRecorder() {
    const node = actx.createScriptProcessor(4096, 2, 2);
    node.onaudioprocess = (e) => onRecChunk([e.inputBuffer.getChannelData(0).slice(0), e.inputBuffer.getChannelData(1).slice(0)]);
    const sink = actx.createGain(); sink.gain.value = 0;
    analyser.connect(node).connect(sink).connect(actx.destination);
    rec.node = node;
  }
  async function makeWorkletRecorder() {
    {
      if (!actx.audioWorklet) throw new Error('no AudioWorklet');
      const src = 'class R extends AudioWorkletProcessor{constructor(){super();this.on=false;this.port.onmessage=(e)=>{this.on=e.data;};}process(i){const c=i[0];if(this.on&&c&&c.length){this.port.postMessage([c[0].slice(0),(c[1]||c[0]).slice(0)]);}return true;}}registerProcessor("rec-3xoso",R);';
      const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      await actx.audioWorklet.addModule(url);
      rec.node = new AudioWorkletNode(actx, 'rec-3xoso', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      const sink = actx.createGain(); sink.gain.value = 0;
      analyser.connect(rec.node).connect(sink).connect(actx.destination);
      rec.node.port.onmessage = (e) => onRecChunk(e.data);
    }
  }
  function stopRecording() {
    if (!rec.on) return;
    rec.on = false;
    if (rec.node.port) rec.node.port.postMessage(false);
    recBtn.classList.remove('rec-on');
    recBtn.textContent = '⏺ Record';
    const blob = encodeWav(rec.chunks, rec.frames, actx.sampleRate);
    const url = URL.createObjectURL(blob);
    const secs = (rec.frames / actx.sampleRate).toFixed(1);
    recOut.innerHTML = `<a class="toggle dl" href="${url}" download="3xoso-${Date.now()}.wav">⬇ Download WAV (${secs} s)</a>`;
  }
  function encodeWav(chunks, frames, sr) {
    const buf = new ArrayBuffer(44 + frames * 4);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + frames * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, frames * 4, true);
    let o = 44;
    for (const [L, R] of chunks) {
      for (let i = 0; i < L.length; i++) {
        v.setInt16(o, clamp(L[i], -1, 1) * 0x7fff, true);
        v.setInt16(o + 2, clamp(R[i], -1, 1) * 0x7fff, true);
        o += 4;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }
  recBtn.addEventListener('click', () => (rec.on ? stopRecording() : startRecording().catch((e) => { soundsMsg.textContent = 'Recording failed: ' + e.message; })));
  function drawRecTimer() {
    if (rec.on) recBtn.textContent = `■ Stop recording (${((performance.now() - rec.start) / 1000).toFixed(1)} s)`;
  }

  // ================================================================ ear trainer
  const quiz = { mode: 'wave', answer: null, choices: [], score: 0, total: 0, streak: 0, best: 0, revealed: false, q: null };
  try { quiz.best = Number(localStorage.getItem('3xoso.quizBest') || 0); } catch (e) { /* storage blocked */ }
  const QUIZ = {
    wave: {
      prompt: 'Which waveform is this?',
      choices: [['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square'], ['saw', 'Saw']],
      explain: {
        sine: 'A sine is pure: one frequency only, soft and flute-like.',
        triangle: 'A triangle has only odd harmonics and they fade fast: mellow, slightly hollow.',
        square: 'A square has strong odd harmonics: hollow, woody, like a clarinet or 8-bit game.',
        saw: 'A saw has every harmonic: bright, buzzy, brassy — the classic synth sound.',
      },
    },
    interval: {
      prompt: 'Two notes play one after the other, then together. How far apart are they?',
      choices: [[0, 'Unison (0)'], [3, 'Minor 3rd (3)'], [4, 'Major 3rd (4)'], [5, 'Perfect 4th (5)'], [7, 'Perfect 5th (7)'], [12, 'Octave (12)']],
      explain: {
        0: 'Unison: the same note, ratio 1:1.', 3: 'Minor 3rd: 3 semitones, ratio ≈ 6:5 — sad, dark.', 4: 'Major 3rd: 4 semitones, ratio ≈ 5:4 — happy, bright.',
        5: 'Perfect 4th: 5 semitones, ratio ≈ 4:3 — open, “Here comes the bride”.', 7: 'Perfect 5th: 7 semitones, ratio ≈ 3:2 — strong and stable, the “power chord”.', 12: 'Octave: 12 semitones, ratio 2:1 — the same note, higher.',
      },
    },
    filter: {
      prompt: 'A saw wave plays through a low-pass filter. Where is the cutoff?',
      choices: [[300, 'Dark (300 Hz)'], [1200, 'Medium (1.2 kHz)'], [6000, 'Bright (6 kHz)']],
      explain: {
        300: 'Dark: only the first couple of harmonics get through — muffled, like through a wall.',
        1200: 'Medium: the lower harmonics pass, the fizz is gone — warm.',
        6000: 'Bright: most harmonics pass — buzzy and open.',
      },
    },
  };
  const quizEl = document.getElementById('quiz');
  const quizPrompt = document.getElementById('quizPrompt');
  const quizChoices = document.getElementById('quizChoices');
  const quizFeedback = document.getElementById('quizFeedback');
  const quizScore = document.getElementById('quizScore');
  const quizCanvas = document.getElementById('quizCanvas');

  function quizNew() {
    const Q = QUIZ[quiz.mode];
    const [val] = pick(Q.choices);
    quiz.answer = val;
    quiz.revealed = false;
    quiz.q = { root: 48 + Math.floor(Math.random() * 12) };
    quizPrompt.textContent = Q.prompt;
    quizFeedback.innerHTML = '';
    quizChoices.innerHTML = '';
    Q.choices.forEach(([v, labelTxt]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'toggle'; b.textContent = labelTxt;
      b.addEventListener('click', () => quizAnswer(v, b));
      quizChoices.appendChild(b);
    });
    quizPlay();
  }

  function quizPlay() {
    if (quiz.answer == null || !ensureAudio()) return;
    const t = actx.currentTime + 0.05;
    const out = actx.createGain();
    out.gain.value = 0.9;
    out.connect(masterGain);
    const tone = (shape, freq, t0, dur, level, filterHz) => {
      const o = actx.createOscillator();
      const b = harmonics(shape);
      const real = new Float32Array(N_HARM + 1), imag = new Float32Array(N_HARM + 1);
      for (let n = 1; n <= N_HARM; n++) imag[n] = b[n];
      o.setPeriodicWave(actx.createPeriodicWave(real, imag, { disableNormalization: true }));
      o.frequency.value = freq;
      const g = actx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(level, t0 + 0.02);
      g.gain.setValueAtTime(level, t0 + dur - 0.08);
      g.gain.linearRampToValueAtTime(0, t0 + dur);
      let node = o;
      if (filterHz) { const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterHz; node.connect(f); node = f; }
      node.connect(g).connect(out);
      o.start(t0); o.stop(t0 + dur + 0.05);
    };
    const f0 = midiFreq(quiz.q.root);
    if (quiz.mode === 'wave') tone(quiz.answer, 220, t, 1.4, quiz.answer === 'square' ? 0.14 : quiz.answer === 'saw' ? 0.18 : 0.26);
    else if (quiz.mode === 'interval') {
      const f1 = f0 * Math.pow(2, quiz.answer / 12);
      tone('triangle', f0, t, 0.7, 0.25); tone('triangle', f1, t + 0.75, 0.7, 0.25);
      tone('triangle', f0, t + 1.55, 1.3, 0.18); tone('triangle', f1, t + 1.55, 1.3, 0.18);
    } else tone('saw', 110, t, 1.6, 0.3, quiz.answer);
    setTimeout(() => out.disconnect(), 3500);
  }

  function quizAnswer(v, btn) {
    if (quiz.revealed || quiz.answer == null) return;
    quiz.revealed = true;
    quiz.total++;
    const right = v === quiz.answer;
    if (right) { quiz.score++; quiz.streak++; } else quiz.streak = 0;
    if (quiz.streak > quiz.best) { quiz.best = quiz.streak; try { localStorage.setItem('3xoso.quizBest', String(quiz.best)); } catch (e) { /* ignore */ } }
    [...quizChoices.children].forEach((b, k) => {
      const val = QUIZ[quiz.mode].choices[k][0];
      b.classList.toggle('right', val === quiz.answer);
      if (b === btn && !right) b.classList.add('wrong');
    });
    quizFeedback.innerHTML = `${right ? '✅ <b>Correct!</b>' : '❌ <b>Not quite.</b>'} ${QUIZ[quiz.mode].explain[quiz.answer]} <button type="button" class="toggle" id="quizNext">Next →</button>`;
    document.getElementById('quizNext').addEventListener('click', quizNew);
    quizScore.textContent = `Score ${quiz.score}/${quiz.total} · streak ${quiz.streak} · best ${quiz.best}`;
  }

  document.querySelectorAll('[data-quiz]').forEach((b) => b.addEventListener('click', () => {
    quiz.mode = b.dataset.quiz;
    document.querySelectorAll('[data-quiz]').forEach((x) => x.classList.toggle('on', x === b));
    quizNew();
  }));
  document.getElementById('quizReplay').addEventListener('click', () => (quiz.answer == null ? quizNew() : quizPlay()));

  function drawQuiz() {
    const c = cv(quizCanvas);
    if (!c) return;
    const { g, w, h } = c;
    g.clearRect(0, 0, w, h);
    if (quiz.answer == null) { label(g, 'Pick a game above, then listen', w / 2, h / 2 + 4, '#8a93a8', 'center'); return; }
    if (!quiz.revealed) {
      // a pulsing question mark while you listen
      const a = 0.5 + 0.5 * Math.sin(performance.now() / 300);
      g.fillStyle = `rgba(79,182,196,${0.4 + 0.5 * a})`;
      g.font = '600 34px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('?', w / 2, h / 2 + 12);
      g.textAlign = 'left';
      return;
    }
    g.strokeStyle = '#4fb6c4';
    g.lineWidth = 2;
    g.beginPath();
    if (quiz.mode === 'wave') {
      const b = harmonics(quiz.answer);
      for (let x = 0; x <= w; x++) {
        const th = (x / w) * Math.PI * 4;
        let s = 0;
        for (let n = 1; n <= 40; n++) if (b[n]) s += b[n] * Math.sin(n * th);
        const y = h / 2 - s * (h / 2 - 8) * 0.8;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
    } else if (quiz.mode === 'interval') {
      const r = Math.pow(2, quiz.answer / 12);
      for (let x = 0; x <= w; x++) {
        const th = (x / w) * Math.PI * 6;
        const y = h / 2 - ((Math.sin(th) + Math.sin(th * r)) / 2) * (h / 2 - 8);
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      label(g, `ratio ${r.toFixed(3)} : 1`, 6, 13, '#8a93a8');
    } else {
      for (let x = 0; x <= w; x += 2) {
        const f = 20 * Math.pow(1000, x / w);
        const y = clamp(h * 0.35 - (lpDb(f, quiz.answer, 0) / 36) * h * 0.6, 2, h - 2);
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      for (let n = 1; n <= 60; n++) {
        const f = 110 * n;
        g.fillStyle = pitchColor(f, f > quiz.answer ? 0.25 : 0.9);
        g.fillRect(specX(f, w) - 1, h - 10, 2, 8);
      }
    }
    g.stroke();
  }


  Object.assign(INFO, {
    chain: { title: 'Signal chain', body: '<p>The path your sound takes, left to right: the <b>oscillators</b> make the raw wave, the <b>filter</b> shapes its tone, the <b>envelope</b> shapes each note’s volume over time, then the effects: <b>Gator</b> (rhythmic volume), <b>Echo</b> (copies of the sound later in time) and <b>Reverb</b> (the room). Greyed-out stages are bypassed. Click a stage to jump to it.</p>' },
    gator: { title: 'Gator (trance gate)', body: '<p>A gate turns the volume on and off in rhythm, synced to the tempo. Each of the 16 steps has its own level, and the <b>shape</b> decides how each gate opens and closes. It is how trance pads stutter, how “sidechain pumping” is faked, and how a long note becomes a rhythmic part.</p>' },
    gateGrid: { title: 'Gate steps', body: '<p>Each column is one step. The coloured shape is the volume during that step. Click or drag up and down to set a step’s level; drag to the bottom to silence it. The white line shows where the gate is right now.</p>' },
    gateShape: { title: 'Gate shape', body: '<p><b>Square</b>: hard on/off chops. <b>Pluck</b>: starts loud and fades — percussive. <b>Swell</b>: fades in — reverse/“sidechain pump” feel. <b>Tri</b> and <b>Smooth</b>: soft pulsing.</p>' },
    gatePattern: { title: 'Gate patterns', body: '<p>Ready-made rhythms for the 16 steps. 🎲 makes a random one. You can edit any of them by drawing on the steps.</p>' },
    gateRate: { title: 'Gate speed', body: '<p>How long each step lasts: 1/16 = four steps per beat, 1/8 = two, 1/4 = one, 1/32 = eight. It follows the sequencer tempo.</p>', live: () => `one step = ${(gateStepDur() * 1000).toFixed(0)} ms at ${state.bpm} BPM` },
    gateDepth: { title: 'Gate depth', body: '<p>How far the volume drops between gates. 100% = silence, 50% = half volume, 0% = no effect.</p>' },
    gateLen: { title: 'Gate length', body: '<p>How much of each step the gate stays open. Short = staccato chops, 100% = the gates touch.</p>' },
    gateSmooth: { title: 'Gate smoothing', body: '<p>Rounds off the start and end of every gate to remove clicks. 0 = hard edges.</p>' },
    echo: { title: 'Echo / Chorus / Delay', body: '<p>All three are the same machine: a <b>delay line</b> that plays the sound again a moment later, with <b>feedback</b> sending the echo back in to repeat. Long times (100 ms+) = separate echoes. 10–40 ms with a wobbling time = <b>chorus</b> (a thicker, shimmering copy). 1–6 ms with feedback = <b>flanger</b> (a jet whoosh).</p>' },
    echoView: { title: 'Echo picture', body: '<p>Time runs left to right. The white bar is your note; each coloured bar is an echo, getting smaller by the feedback amount each time. Pink = left speaker, blue = right, yellow = centre. Bars flash as each echo is heard.</p>', live: () => `echo n arrives at n × ${fmtMs(state.dly.time)}\nlevel of echo n = mix × feedback^(n−1) = ${state.dly.mix.toFixed(2)} × ${state.dly.fb.toFixed(2)}^(n−1)\n→ 5th echo at ${(state.dly.mix * Math.pow(state.dly.fb, 4) * 100).toFixed(1)}%` },
    echoModes: { title: 'Echo modes', body: '<p>Starting points that set every echo knob at once: <b>Chorus</b>, <b>Flanger</b>, <b>Slapback</b> (one quick repeat), <b>Echo</b> (tempo-synced repeats), <b>Ping-pong</b> (bouncing left/right) and <b>Dub</b> (dark, long, wobbly repeats).</p>' },
    dlySync: { title: 'Sync to tempo', body: '<p>Locks the echo time to a note length at the current tempo, so echoes land in rhythm. 1/8d = dotted eighth (¾ of a beat) — the famous U2/“The Edge” echo.</p>' },
    dlyMix: { title: 'Echo mix', body: '<p>How loud the echoes are compared with the original sound.</p>' },
    dlyTime: { title: 'Echo time', body: '<p>The gap between the sound and its echo. Below ~40 ms our ears hear it as one thicker sound (chorus/flanger); above that, as separate repeats.</p>', live: () => `time = ${fmtMs(state.dly.time)} = ${(state.dly.time * state.bpm / 60).toFixed(2)} beats at ${state.bpm} BPM` },
    dlyFb: { title: 'Feedback', body: '<p>How much of each echo is fed back in to make the next one. 0 = one echo; 50% = each echo half as loud as the last; near 95% = echoes that almost never die.</p>' },
    dlyTone: { title: 'Echo tone', body: '<p>A low-pass filter inside the feedback loop: each repeat gets darker, like old tape echo units.</p>' },
    dlySpread: { title: 'Stereo spread', body: '<p>Pans alternate echoes left and right (ping-pong). 0 = all echoes in the middle.</p>' },
    dlyRate: { title: 'Wobble rate', body: '<p>Speed of the built-in LFO that moves the delay time. Moving the time slightly bends the pitch of the echo up and down — that is what makes chorus shimmer.</p>' },
    dlyDepth: { title: 'Wobble depth', body: '<p>How far the LFO moves the delay time. Small = gentle chorus, larger = seasick vibrato.</p>' },
    reverb: { title: 'Reverb', body: '<p>Reverb is thousands of echoes blurred together as sound bounces around a room. Here it is made by <b>convolution</b>: your sound is multiplied with a recording-like “fingerprint” of a room (a burst of noise that dies away).</p>' },
    revView: { title: 'Reverb picture', body: '<p>Left: the room’s fingerprint — how the reverb dies away after the pre-delay gap. The dashed line marks the decay time (−60 dB). Right: rings spreading from your last note, fading as the reverb dies. The box size shows the room size.</p>' },
    revModes: { title: 'Reverb rooms', body: '<p>Room (small, short), Plate (bright, dense), Hall (concert hall), Cathedral (long and dark), Infinite (a huge wash for ambient music).</p>' },
    revMix: { title: 'Reverb mix', body: '<p>Balance between the dry sound and the room. More mix = further away.</p>' },
    revSize: { title: 'Reverb decay', body: '<p>How long the reverb takes to fade to silence (−60 dB, called RT60). Small rooms ≈ 0.5 s, halls ≈ 2–3 s, cathedrals 5 s or more.</p>' },
    revPre: { title: 'Pre-delay', body: '<p>A gap before the reverb starts. It keeps the original sound clear and makes the room seem bigger.</p>' },
    revDamp: { title: 'Damping', body: '<p>Turns down the high frequencies of the reverb. Real rooms with soft surfaces (curtains, people) absorb highs, so a low setting sounds warmer and darker.</p>' },
    mods: { title: 'Modulators', body: '<p>Two free-running LFOs (slow oscillators) that can wobble <b>any</b> knob — any effect setting, the filter, volumes, pans or an oscillator’s Fixed Hz. Unlike automation lanes they run all the time, even with the sequencer stopped. The knob being wobbled glows green.</p>' },
    modTarget: { title: 'Modulator target', body: '<p>Which knob this modulator moves. Try Echo time (pitch-bending repeats), Reverb mix (breathing space), Filter cutoff (slow sweeps) or Osc pan (auto-pan).</p>' },
    modShape: { title: 'Modulator shape', body: '<p>Sine and triangle swing smoothly, saw ramps up and jumps back, square flips between two values, ⁂ picks a new random value each cycle.</p>' },
    modRate: { title: 'Modulator rate', body: '<p>Cycles per second, from 0.05 Hz (once every 20 seconds) to 10 Hz.</p>' },
    modDepth: { title: 'Modulator depth', body: '<p>How far the knob moves either side of where you left it.</p>' },
    inspire: { title: 'Surprise me & Mutate', body: '<p><b>Surprise me</b> builds a brand-new random sound (bass, pad, lead, pluck, keys or FX) with musical settings, a pattern and effects. <b>Mutate</b> nudges the current sound a little — tuning, levels, filter, effects, the pattern — so it slowly evolves. Great for breaking writer’s block.</p>' },
    mysounds: { title: 'My sounds', body: '<p>Save the whole setup (oscillators, filter, envelope, effects, pattern, automation and modulators) in this browser. <b>Share link</b> copies a web address containing the sound — anyone who opens it gets exactly the same setup. <b>Record</b> captures what you hear to a WAV file you can drop into any DAW.</p>' },
    quiz: { title: 'Ear trainer', body: '<p>Short listening games: identify a waveform, an interval between two notes, or how bright a filter is. Answers show a picture of what you heard, so you connect the sound to the shape. Your best streak is remembered.</p>' },
  });

  // ================================================================ more presets (with effects)
  const G = (pattern, shape = 'square', rate = 16, more = {}) => ({ pattern, shape, rate, ...more });
  PRESETS.push(
    { cat: 'Pad', name: 'Trance Gate Pad', desc: 'Detuned saws chopped by the Gator in a classic trance rhythm, with ping-pong echo and a hall. Watch the gate steps light up.',
      osc: [{ shape: 'saw', fine: -12, pan: -0.5, vol: 0.55 }, { shape: 'saw', fine: 12, pan: 0.5, vol: 0.55 }, { shape: 'saw', coarse: -12, vol: 0.4 }], cutoff: 3500, res: 2, env: [0.3, 0.5, 0.9, 1],
      gator: G(GATE_PATTERNS.Trance, 'square', 16, { len: 0.7, smooth: 0.06 }), dly: { ...DLY_MODES['Ping-pong'], mix: 0.3 }, rev: { ...REV_MODES.Hall },
      demo: { bpm: 138, root: 48, bars: 2, gate: 1, seq: '0 . . . . . . . 5 . . . . . . .' } },
    { cat: 'Pad', name: 'Ambient Shimmer', desc: 'Soft sines and a triangle with a long cathedral reverb and an echo whose tone slowly wobbles (Mod 1).',
      osc: [{ shape: 'sine', vol: 0.6 }, { shape: 'triangle', coarse: 12, fine: 4, vol: 0.3 }, { shape: 'sine', coarse: 19, vol: 0.18 }], env: [1.5, 2, 0.8, 4],
      dly: { ...DLY_MODES.Echo, sync: '1/4', fb: 0.55, mix: 0.3, tone: 3000 }, rev: { ...REV_MODES.Cathedral, mix: 0.55 },
      mods: [{ on: true, target: 'dlyTone', shape: 'sine', rate: 0.1, depth: 0.5 }],
      demo: { bpm: 70, root: 60, bars: 2, gate: 1, seq: '0 . . . . . . . 7 . . . . . . .' } },
    { cat: 'Pad', name: 'Chorus Strings', desc: 'Saws thickened by a stereo chorus — a short delay whose time wobbles, so copies drift slightly out of tune.',
      osc: [{ shape: 'saw', fine: -5, vol: 0.5 }, { shape: 'saw', fine: 5, vol: 0.5 }, { shape: 'saw', coarse: 12, vol: 0.2 }], cutoff: 3000, res: 1, env: [0.5, 0.6, 0.85, 1.4],
      dly: { ...DLY_MODES.Chorus, mix: 0.6 }, rev: { ...REV_MODES.Hall, mix: 0.25 },
      demo: { bpm: 80, root: 48, gate: 1, seq: '0 . . . 3 . . . 7 . . . 5 . . .' } },
    { cat: 'Pad', name: 'Pumping Pad', desc: 'The Gator in Swell shape at quarter notes ducks the pad on every beat — the “sidechain pump” of dance music.',
      osc: [{ shape: 'saw', fine: -9, vol: 0.55 }, { shape: 'saw', fine: 9, vol: 0.55 }, { shape: 'square', coarse: -12, vol: 0.3 }], cutoff: 2600, res: 2, env: [0.2, 0.5, 0.9, 1],
      gator: G('XXXXXXXXXXXXXXXX', 'up', 4, { len: 1, smooth: 0 }), rev: { ...REV_MODES.Plate, mix: 0.25 },
      demo: { bpm: 124, root: 48, bars: 2, gate: 1, seq: '0 . . . . . . . . . . . . . . .' } },
    { cat: 'Pad', name: 'Flanger Sweep', desc: 'A jet-plane whoosh: a very short delay with high feedback whose time slowly sweeps.',
      osc: [{ shape: 'saw', vol: 0.6 }, { shape: 'saw', coarse: -12, fine: 6, vol: 0.45 }, off], cutoff: 6000, env: [0.4, 0.5, 0.9, 1.2],
      dly: { ...DLY_MODES.Flanger }, rev: { ...REV_MODES.Room },
      demo: { bpm: 90, root: 45, bars: 2, gate: 1, seq: '0 . . . . . . . . . . . . . . .' } },
    { cat: 'Keys & plucks', name: 'Dub Chord', desc: 'Three oscillators tuned 0, +3, +7 make a minor chord. A dark dub echo keeps repeating it.',
      osc: [{ shape: 'square', vol: 0.45 }, { shape: 'saw', coarse: 3, vol: 0.4 }, { shape: 'saw', coarse: 7, vol: 0.4 }], cutoff: 1400, res: 4, fenv: 1.2, env: [0.003, 0.25, 0, 0.2],
      dly: { ...DLY_MODES.Dub }, rev: { ...REV_MODES.Plate, mix: 0.2 },
      demo: { bpm: 74, root: 48, gate: 0.4, seq: '. . . . 0 . . . . . . . 0 . . .' } },
    { cat: 'Keys & plucks', name: 'Detroit Stab', desc: 'A minor-7th chord stab (0, +3, +10) with a snappy filter envelope and 1/16 echo.',
      osc: [{ shape: 'saw', vol: 0.45 }, { shape: 'saw', coarse: 3, vol: 0.4 }, { shape: 'saw', coarse: 10, vol: 0.4 }], cutoff: 900, res: 7, fenv: 2.8, env: [0.002, 0.2, 0, 0.15],
      dly: { ...DLY_MODES.Echo, sync: '1/16', fb: 0.35, mix: 0.3 }, rev: { ...REV_MODES.Room },
      demo: { bpm: 128, root: 48, gate: 0.3, seq: '0 . . 0 . . 0 . . . 0 . . 0 . .' } },
    { cat: 'Keys & plucks', name: 'Lo-fi Keys', desc: 'Mellow triangle keys with a slow, wonky chorus (like worn tape) and a small room.',
      osc: [{ shape: 'triangle', vol: 0.7 }, { shape: 'sine', coarse: 12, vol: 0.2 }, off], cutoff: 2400, env: [0.004, 1, 0.3, 0.6],
      dly: { time: 0.022, fb: 0.15, depth: 0.007, rate: 0.35, spread: 0.4, mix: 0.55, tone: 5000, sync: 'off' }, rev: { ...REV_MODES.Room, mix: 0.3 },
      demo: { bpm: 82, root: 60, gate: 0.8, seq: '0 . . 4 . . 7 . 11 . . 7 . 4 . .' } },
    { cat: 'Keys & plucks', name: 'Ping-Pong Pluck', desc: 'A short pluck whose echoes bounce left and right. Use headphones and watch the pink (left) and blue (right) taps.',
      osc: [{ shape: 'saw', vol: 0.7 }, { shape: 'square', coarse: 12, vol: 0.2 }, off], cutoff: 600, res: 4, fenv: 4, env: [0.002, 0.2, 0, 0.25],
      dly: { ...DLY_MODES['Ping-pong'], mix: 0.45 }, rev: { ...REV_MODES.Room },
      demo: { bpm: 110, root: 60, gate: 0.3, seq: '0 . . 7 . . 12 . . . 10 . 7 . . .' } },
    { cat: 'Keys & plucks', name: 'Dream Bell', desc: 'Inharmonic bell tones into a quarter-note echo and a huge reverb.',
      osc: [{ shape: 'sine', vol: 0.7 }, { shape: 'sine', coarse: 19, fine: 2, vol: 0.3 }, { shape: 'sine', coarse: 34, fine: -14, vol: 0.12 }], env: [0.002, 2, 0, 2],
      dly: { ...DLY_MODES.Echo, sync: '1/4d', fb: 0.4, mix: 0.3 }, rev: { ...REV_MODES.Cathedral },
      demo: { bpm: 80, root: 72, gate: 0.5, seq: '0 . . . . . 7 . . . . . 4 . . .' } },
    { cat: 'Lead', name: 'Slapback Lead', desc: 'A square lead with a single quick echo (about 90 ms) — the rockabilly “slapback”.',
      osc: [{ shape: 'square', vol: 0.65 }, { shape: 'square', coarse: 12, fine: 6, vol: 0.2 }, off], cutoff: 3500, res: 2, env: [0.005, 0.2, 0.7, 0.15],
      dly: { ...DLY_MODES.Slapback },
      demo: { bpm: 120, root: 60, gate: 0.6, seq: '0 . 3 . 5 . 3 . 7 . 5 . 3 . 0 .' } },
    { cat: 'Lead', name: 'Hoover', desc: 'Massively detuned saws plus a chorus, with a pitch dip at the start of each bar — the rave “hoover”.',
      osc: [{ shape: 'saw', fine: -30, pan: -0.6, vol: 0.55 }, { shape: 'saw', fine: 30, pan: 0.6, vol: 0.55 }, { shape: 'saw', coarse: -12, vol: 0.45 }], cutoff: 5000, res: 3, env: [0.05, 0.4, 0.9, 0.4],
      dly: { ...DLY_MODES.Chorus, mix: 0.5 }, rev: { ...REV_MODES.Hall, mix: 0.2 },
      demo: { bpm: 135, root: 48, gate: 0.95, seq: '0 . . . . . . 3 . . . . 7 . 5 .', lanes: [{ target: 'pitch', shape: 'rise', cycles: 1, lo: 0.68, hi: 0.75 }] } },
    { cat: 'Lead', name: 'Synth Brass', desc: 'Saws with a slower attack and a filter envelope that opens as the note starts — 80s brass.',
      osc: [{ shape: 'saw', vol: 0.6 }, { shape: 'saw', fine: 8, vol: 0.55 }, { shape: 'square', coarse: -12, vol: 0.2 }], cutoff: 700, res: 2, fenv: 2.6, env: [0.07, 0.4, 0.75, 0.3],
      rev: { ...REV_MODES.Plate, mix: 0.25 },
      demo: { bpm: 112, root: 55, gate: 0.85, seq: '0 . . . 0 . 3 . . . 5 . 3 . . .' } },
    { cat: 'Lead', name: '80s Poly Arp', desc: 'Square + saw arpeggio through chorus and a dotted-eighth echo.',
      osc: [{ shape: 'square', vol: 0.5 }, { shape: 'saw', coarse: 12, vol: 0.25 }, off], cutoff: 2600, res: 3, fenv: 1.5, env: [0.003, 0.2, 0.4, 0.2],
      dly: { ...DLY_MODES['Ping-pong'], sync: '1/8d', fb: 0.4, mix: 0.35 }, rev: { ...REV_MODES.Hall, mix: 0.2 },
      demo: { bpm: 118, root: 57, gate: 0.5, seq: '0 3 7 12 0 3 7 12 0 5 8 12 0 5 8 12' } },
    { cat: 'Lead', name: 'Chip Echo', desc: 'A chiptune square with a 1/16 echo that doubles every note.',
      osc: [{ shape: 'square', vol: 0.65 }, off, off], env: [0.002, 0.1, 0.5, 0.05],
      dly: { ...DLY_MODES.Echo, sync: '1/16', fb: 0.3, mix: 0.35, tone: 9000 },
      demo: { bpm: 140, root: 60, gate: 0.4, seq: '0 . 4 . 7 . 12 . 7 . 4 . 0 . 7 .' } },
    { cat: 'Bass', name: 'Gated Bass', desc: 'A long bass note chopped into 16ths by the Gator in Pluck shape — instant rolling bassline.',
      osc: [{ shape: 'saw', vol: 0.7 }, { shape: 'sine', coarse: -12, vol: 0.6 }, off], cutoff: 700, res: 6, env: [0.005, 0.3, 1, 0.2],
      gator: G('XXXXXXXXXXXXXXXX', 'down', 16, { len: 0.9, smooth: 0.02 }),
      demo: { bpm: 126, root: 33, bars: 2, gate: 1, seq: '0 . . . . . . . 3 . . . 5 . . .', lanes: [{ target: 'cutoff', shape: 'tri', cycles: 1, lo: 0.4, hi: 0.62 }] } },
    { cat: 'Bass', name: 'Wobble Gate Bass', desc: 'Triangle-shaped gates at 1/8 plus a resonant filter: a softer, rhythmic wobble.',
      osc: [{ shape: 'saw', vol: 0.65 }, { shape: 'square', fine: 10, vol: 0.5 }, { shape: 'sine', coarse: -12, vol: 0.5 }], cutoff: 500, res: 10, env: [0.01, 0.3, 1, 0.2],
      gator: G('XXXXXXXXXXXXXXXX', 'tri', 8, { len: 1, smooth: 0 }), rev: { ...REV_MODES.Room, mix: 0.15 },
      demo: { bpm: 140, root: 33, bars: 2, gate: 1, seq: '0 . . . . . . . 3 . . . . . . .', lanes: [{ target: 'cutoff', shape: 'sine', cycles: 2, lo: 0.25, hi: 0.55 }] } },
    { cat: 'FX', name: 'Heartbeat', desc: 'A deep sine chopped into a lub-dub pattern by the Gator, in a small room.',
      osc: [{ shape: 'sine', vol: 0.9 }, { shape: 'triangle', coarse: 12, vol: 0.15 }, off], env: [0.01, 0.5, 1, 0.3],
      gator: G(GATE_PATTERNS.Heartbeat, 'down', 16, { len: 0.9, smooth: 0.05 }), rev: { ...REV_MODES.Room, mix: 0.2 },
      demo: { bpm: 66, root: 28, gate: 1, seq: '. . . . . . . . . . . . . . . .', drone: 28 } },
    { cat: 'FX', name: 'Space Drone', desc: 'Sines, noise and an infinite reverb with a long, dark echo. Mod 1 slowly moves the echo time for pitch-bending repeats.',
      osc: [{ shape: 'sine', vol: 0.5 }, { shape: 'triangle', coarse: 7, fine: 6, vol: 0.3 }, { shape: 'noise', vol: 0.06 }], cutoff: 2500, res: 4, env: [2, 1, 1, 4],
      dly: { ...DLY_MODES.Dub, fb: 0.7, tone: 1500, mix: 0.45 }, rev: { ...REV_MODES.Infinite },
      mods: [{ on: true, target: 'dlyTime', shape: 'sine', rate: 0.07, depth: 0.15 }, { on: true, target: 'cutoff', shape: 'tri', rate: 0.05, depth: 0.4 }],
      demo: { bpm: 60, root: 36, bars: 4, gate: 1, seq: '. . . . . . . . . . . . . . . .', drone: 36 } },
    { cat: 'FX', name: 'Rain', desc: 'Bright noise chopped into random 1/32 droplets by the Gator, with a plate reverb.',
      osc: [{ shape: 'noise', vol: 0.6 }, off, off], cutoff: 7000, res: 2, env: [0.5, 0.5, 1, 1.5],
      gator: G('XxX.x.XXx.Xx.XxX', 'down', 32, { len: 0.35, smooth: 0.02 }), rev: { ...REV_MODES.Plate, mix: 0.4 },
      demo: { bpm: 100, root: 48, gate: 1, seq: '. . . . . . . . . . . . . . . .', drone: 48 } },
    { cat: 'FX', name: 'Siren', desc: 'A square whose pitch rises and falls (automation lane, triangle shape) with an echo trail.',
      osc: [{ shape: 'square', vol: 0.5 }, { shape: 'square', coarse: 12, vol: 0.15 }, off], cutoff: 4000, env: [0.05, 0.3, 1, 0.5],
      dly: { ...DLY_MODES.Echo, fb: 0.35, mix: 0.25 }, rev: { ...REV_MODES.Hall, mix: 0.25 },
      demo: { bpm: 100, root: 60, bars: 1, gate: 1, seq: '. . . . . . . . . . . . . . . .', drone: 60, lanes: [{ target: 'pitch', shape: 'tri', cycles: 2, lo: 0.75, hi: 0.92 }] } },
    { cat: 'FX', name: 'Underwater', desc: 'A muffled chord with chorus while Mod 1 slowly opens and closes the filter — like hearing music from under the surface.',
      osc: [{ shape: 'saw', vol: 0.5 }, { shape: 'saw', coarse: 7, vol: 0.4 }, { shape: 'square', coarse: -12, vol: 0.3 }], cutoff: 450, res: 8, env: [0.3, 0.5, 0.9, 1],
      dly: { ...DLY_MODES.Chorus, depth: 0.006, rate: 0.4, mix: 0.6 }, rev: { ...REV_MODES.Hall, mix: 0.35 },
      mods: [{ on: true, target: 'cutoff', shape: 'sine', rate: 0.25, depth: 0.3 }],
      demo: { bpm: 80, root: 48, bars: 2, gate: 1, seq: '0 . . . . . . . 5 . . . . . . .' } },
  );

  // ================================================================ global controls
  const winInp = document.getElementById('window');
  const winOut = document.getElementById('windowOut');
  const fmtWin = (ms) => (ms < 100 ? ms.toFixed(1) + ' ms' : Math.round(ms) + ' ms');
  function setWindowMs(ms) {
    state.windowMs = ms;
    winInp.value = Math.log(ms) / Math.log(1000);
    winOut.textContent = fmtWin(ms);
    refreshExplainLive();
  }
  winInp.addEventListener('input', () => {
    state.windowMs = Math.pow(1000, Number(winInp.value));
    winOut.textContent = fmtWin(state.windowMs);
    refreshExplainLive();
  });

  const freezeBtn = document.getElementById('freeze');
  freezeBtn.addEventListener('click', () => { state.freeze = !state.freeze; freezeBtn.classList.toggle('on', state.freeze); });

  const holdBtn = document.getElementById('hold');
  function setHold(on) {
    state.hold = on;
    holdBtn.classList.toggle('on', on);
    if (!on && actx) releaseUnpressed();
  }
  holdBtn.addEventListener('click', () => setHold(!state.hold));
  document.getElementById('panic').addEventListener('click', () => { stopTransport(); stopAll(); setHold(false); clearLesson(); });

  const modePlay = document.getElementById('modePlay');
  const modeLearn = document.getElementById('modeLearn');
  function setMode(learn) {
    state.learn = learn;
    document.body.classList.toggle('play-mode', !learn);
    modePlay.classList.toggle('on', !learn);
    modeLearn.classList.toggle('on', learn);
  }
  modePlay.addEventListener('click', () => setMode(false));
  modeLearn.addEventListener('click', () => setMode(true));

  function syncAll() {
    Object.keys(PARAMS).forEach(syncParam);
    for (let i = 0; i < 3; i++) syncOscUI(i);
    state.lanes.forEach((l, k) => syncLaneUI(k));
    syncTransportUI();
    if (fxUI.gateOn) syncFxUI();
    if (masterGain) masterGain.gain.setTargetAtTime(state.master, actx.currentTime, 0.02);
    markDirty();
  }

  // ================================================================ keyboard
  const kb = document.getElementById('keyboard');
  const octOut = document.getElementById('octOut');
  const keyEls = new Map();   // midi -> element
  const KEYMAP = {
    z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, ',': 12,
    q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24,
  };
  const isBlack = (n) => [1, 3, 6, 8, 10].includes(((n % 12) + 12) % 12);
  const baseNote = () => (state.octave + 1) * 12;

  function buildKeyboard() {
    kb.innerHTML = '';
    keyEls.clear();
    const base = baseNote();
    const notes = [];
    for (let n = base; n <= base + 24; n++) notes.push(n);
    const ww = 100 / notes.filter((n) => !isBlack(n)).length;
    let wi = 0;
    for (const n of notes) {
      const el = document.createElement('div');
      el.className = 'key' + (isBlack(n) ? ' black' : '');
      el.dataset.note = n;
      if (isBlack(n)) {
        el.style.left = `calc(${wi * ww}% - ${ww * 0.32}%)`;
        el.style.width = `${ww * 0.64}%`;
      } else {
        wi++;
        if (n % 12 === 0) el.textContent = noteName(n);
      }
      if (voices.has(n)) el.classList.add('down');
      kb.appendChild(el);
      keyEls.set(n, el);
    }
    octOut.textContent = `C${state.octave}`;
  }

  function setKeyDown(note, down) {
    const el = keyEls.get(note);
    if (el) el.classList.toggle('down', down);
  }

  const pointerNotes = new Map();   // pointerId -> note (drag across keys for glissando)
  function noteFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    return el && el.classList.contains('key') ? Number(el.dataset.note) : null;
  }
  kb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    kb.setPointerCapture(e.pointerId);
    const n = noteFromPoint(e.clientX, e.clientY);
    if (n != null) { pointerNotes.set(e.pointerId, n); noteOn(n); }
  });
  kb.addEventListener('pointermove', (e) => {
    if (!pointerNotes.has(e.pointerId)) return;
    const n = noteFromPoint(e.clientX, e.clientY);
    const cur = pointerNotes.get(e.pointerId);
    if (n != null && n !== cur) { noteOff(cur); pointerNotes.set(e.pointerId, n); noteOn(n); }
  });
  const endPointer = (e) => {
    const cur = pointerNotes.get(e.pointerId);
    if (cur != null) { noteOff(cur); pointerNotes.delete(e.pointerId); }
  };
  kb.addEventListener('pointerup', endPointer);
  kb.addEventListener('pointercancel', endPointer);

  const keyNotes = new Map();   // key -> note (so octave changes mid-press still release correctly)
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLSelectElement) return;
    if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (e.repeat) return;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      if (transport.playing) stopTransport(); else startTransport();
      return;
    }
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (!(k in KEYMAP)) return;
    const n = baseNote() + KEYMAP[k];
    keyNotes.set(k, n);
    noteOn(n);
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (!keyNotes.has(k)) return;
    noteOff(keyNotes.get(k));
    keyNotes.delete(k);
  });
  window.addEventListener('blur', () => { for (const n of keyNotes.values()) noteOff(n); keyNotes.clear(); });

  document.getElementById('octDown').addEventListener('click', () => { state.octave = clamp(state.octave - 1, 0, 7); buildKeyboard(); });
  document.getElementById('octUp').addEventListener('click', () => { state.octave = clamp(state.octave + 1, 0, 7); buildKeyboard(); });

  // Web MIDI (Chrome/Edge). Silently skipped where unsupported.
  const midiStatus = document.getElementById('midiStatus');
  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess().then((access) => {
      const hook = () => {
        let count = 0;
        access.inputs.forEach((input) => {
          count++;
          input.onmidimessage = (msgEv) => {
            const [st, d1, d2] = msgEv.data;
            const cmd = st & 0xf0;
            if (cmd === 0x90 && d2 > 0) noteOn(d1, d2 / 127);
            else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) noteOff(d1);
          };
        });
        midiStatus.textContent = count ? `MIDI: ${count} input${count > 1 ? 's' : ''}` : 'MIDI: none';
        midiStatus.classList.toggle('dim', !count);
      };
      hook();
      access.onstatechange = hook;
    }).catch(() => { midiStatus.textContent = 'MIDI: blocked'; });
  } else {
    midiStatus.textContent = 'MIDI: n/a';
  }

  // ================================================================ lessons
  const LESSONS = [
    {
      title: 'A pure tone',
      osc: [{ shape: 'sine', vol: 0.8 }, off, off],
      windowMs: 10,
      text: '<p>One sine wave: the simplest sound there is. The spectrum shows a <b>single spike</b> — one frequency only.</p><p>Move Osc 1 <b>Coarse</b>: more cycles fit in the window as the pitch rises, the speed wheel spins faster, and the panel turns from dark blue to light red. Move <b>Volume</b>: the wave gets bigger and thicker.</p>',
    },
    {
      title: 'Harmonics: why a saw sounds buzzy',
      osc: [{ shape: 'saw', vol: 0.8 }, off, off],
      windowMs: 10,
      text: '<p>A saw wave is built from sine waves at 1×, 2×, 3×, 4×… the base frequency. See the <b>row of spikes</b> in the spectrum and the bars in the harmonic fingerprint.</p><p>Click through <b>Sine → Tri → Square → Saw</b>: Square and Tri only have <i>odd</i> harmonics, which is why they sound hollow.</p>',
    },
    {
      title: 'Speed: from rhythm to pitch',
      osc: [{ shape: 'saw', vol: 0.7, fixed: true, hz: 2 }, off, off],
      windowMs: 1000,
      text: '<p>Osc 1 is on <b>Fixed Hz</b> at 2 Hz — two cycles per second. You hear it as <b>clicks</b>, not a note. Watch the slow speed wheel.</p><p>Slowly drag <b>Frequency</b> up. Around <b>20 Hz</b> the clicks blur into a low buzz — that is where rhythm turns into pitch. Keep going and the wheel spins faster and the panel turns redder.</p>',
    },
    {
      title: 'Filter: removing harmonics',
      osc: [{ shape: 'saw', vol: 0.8 }, off, off],
      cutoff: 400, res: 6,
      windowMs: 10,
      text: '<p>The same bright saw, but through a <b>low-pass filter</b> set to 400 Hz. Harmonics above the cutoff are turned down — see them fade in the harmonic fingerprint and spectrum.</p><p>Sweep <b>Cutoff</b> up and down (that is the classic filter sweep), then raise <b>Resonance</b> to hear the whistling peak.</p>',
    },
    {
      title: 'Octaves and fifths',
      osc: [{ shape: 'saw', vol: 0.6 }, { shape: 'saw', coarse: -12, vol: 0.5 }, { shape: 'saw', coarse: 7, vol: 0.4 }],
      windowMs: 20,
      text: '<p>Osc 2 is 12 semitones down (half the frequency, ratio 1:2). Osc 3 is 7 semitones up — a perfect fifth, very close to ratio 3:2.</p><p>Simple ratios line their cycles up often, which sounds smooth. Try Osc 3 at +6 (tritone) and listen to the tension.</p>',
    },
    {
      title: 'Beating: two nearly equal pitches',
      osc: [{ shape: 'sine', vol: 0.6 }, { shape: 'sine', fine: 16, vol: 0.6 }, off],
      windowMs: 1000,
      text: '<p>Osc 2 is 16 cents sharp of Osc 1 — about 2 Hz apart. The two waves slide in and out of step, so the sum <b>swells and fades about twice a second</b>.</p><p>Move Osc 2 <b>Fine</b> toward 0 and the beating slows; move it away and it speeds up.</p>',
    },
    {
      title: 'Phase cancellation',
      osc: [{ shape: 'sine', vol: 0.7 }, { shape: 'sine', vol: 0.7, invert: true }, off],
      windowMs: 10,
      text: '<p>Two identical sine waves, but Osc 2 is <b>inverted</b>. Every peak meets a trough, so they add to <b>zero: silence</b>. The white sum line is flat.</p><p>Untick Invert and the sound comes back twice as strong. Or drag Osc 2 <b>Phase</b> away from 0° to hear it gradually return.</p>',
    },
    {
      title: 'Osc 3 as a wobble (AM)',
      osc: [{ shape: 'saw', vol: 0.7 }, off, { shape: 'sine', fixed: true, hz: 4, vol: 0.9 }],
      am: true,
      windowMs: 1000,
      text: '<p>Osc 3 is on <b>Fixed Hz</b> at 4 Hz and switched to <b>AM</b>: you do not hear it directly — it moves the volume of Osc 1 up and down four times a second.</p><p>Raise Osc 3 <b>Frequency</b>. Once it passes about 20 Hz you stop hearing a wobble and start hearing new metallic tones (sidebands). Osc 3 <b>Volume</b> sets the depth.</p>',
    },
  ];

  const lessonList = document.getElementById('lessonList');
  const lessonText = document.getElementById('lessonText');
  const lessonBtns = LESSONS.map((L, k) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${k + 1}. ${L.title}`;
    b.addEventListener('click', () => startLesson(k));
    li.appendChild(b);
    lessonList.appendChild(li);
    return b;
  });

  function clearLesson() {
    lessonBtns.forEach((b) => b.classList.remove('on'));
    lessonText.innerHTML = '';
  }

  function startLesson(k) {
    const L = LESSONS[k];
    if (!ensureAudio()) return;
    stopTransport();
    stopAll();
    applyPatch({ osc: L.osc, am: L.am, cutoff: L.cutoff, res: L.res, env: [0.05, 0.3, 0.9, 0.4] });
    presetBtns.forEach((b) => b && b.classList.remove('on'));
    setWindowMs(L.windowMs);
    setHold(true);
    noteOn(57, 0.9);   // A3, 220 Hz
    pressed.delete(57);
    lessonBtns.forEach((b, j) => b.classList.toggle('on', j === k));
    lessonText.innerHTML = `<h3 style="margin:8px 0 6px;font-size:14px">${k + 1}. ${L.title}</h3>${L.text}<p class="dim small">Press <b>Stop all</b> when you are done.</p>`;
    markDirty();
  }

  // ================================================================ animation loop
  let animTime = 0, lastFrame = performance.now(), frameCount = 0, lastRefresh = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!state.freeze) animTime += dt * SLOWMO;
    const env = liveEnvelope();
    const pos = posNow();
    if (pos && (pos.s !== transport.visStep || pos.loop !== transport.visLoop)) {
      if (pos.loop !== transport.visLoop) { transport.visLoop = pos.loop; transport.pulse = now; }
      transport.visStep = pos.s;
      const n = state.seq[pos.s % 16];
      if (n >= 0) { flash[pos.s % 16] = now; lastNote = state.seqRoot + n; markDirty(); }
    }
    for (let i = 0; i < 3; i++) {
      drawOscScope(i, animTime, env);
      drawSpeed(i, dt);
      if (state.learn && frameCount % 6 === 0) drawHarmonics(i);
    }
    drawMix(animTime);
    drawOutput();
    drawSpectrum();
    drawFilter(env);
    drawEnvelope(env);
    drawSeq(pos);
    drawRing(pos);
    drawLane(0, pos);
    drawLane(1, pos);
    drawLane(2, pos);
    drawGator();
    drawEcho();
    drawReverb();
    drawMods();
    drawQuiz();
    drawChain(env);
    if (frameCount % 10 === 0) drawRecTimer();
    if (dirty && now - lastRefresh > 90) { dirty = false; lastRefresh = now; refreshReadouts(); }
    frameCount++;
    requestAnimationFrame(frame);
  }

  // ================================================================ start
  buildPresets();
  buildOscPanels();
  buildLanes();
  buildFxUI();
  bindParamInputs(document);
  for (let i = 0; i < 3; i++) rebuildTable(i);
  state.lanes.forEach(genLane);
  buildKeyboard();
  hookInfo(document);
  document.querySelectorAll('canvas').forEach((c) => ro.observe(c));
  setWindowMs(state.windowMs);
  setMode(true);
  syncAll();
  renderSounds();
  loadFromHash();
  requestAnimationFrame(frame);
})();
