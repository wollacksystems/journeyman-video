/**
 * The brag's music bed (wollacksystems/journeyman#31).
 *
 * NOT a Node module: `brag/cut.mjs` reads this file as text, injects it into
 * the capture page, and evaluates it there, because the only audio path #31
 * measured as working headlessly is Web Audio's `OfflineAudioContext` — it
 * renders sample-exact PCM with no output device and no capture step.
 * Everything else was ruled out on evidence: `speechSynthesis` cannot be routed
 * into a Web Audio graph and has no offline renderer, and headless
 * `getDisplayMedia` throws `NotSupportedError` (headed it hands back zero audio
 * tracks), so browser speech capture is not automatable.
 *
 * `renderBed(ctx)` schedules all thirty-four seconds onto an OfflineAudioContext
 * and returns a normalizer for the rendered buffer. Every noise source (the
 * reverb tail, the percussion, the wash) is drawn from a seeded PRNG, so the
 * *material* is identical on every run: the same notes, the same tail, the same
 * level.
 *
 * Byte-identical it is not, and that belongs here as a measurement rather than
 * as a caveat. Two renders of this file in the same browser — and a render with
 * the `ConvolverNode` bypassed, so it is not the reverb's background FFT —
 * disagree by one in the low byte in about 625 of 1.76M samples, which is the
 * last bit of a float32 and inaudible. Chromium's audio graph (denormal
 * handling, block scheduling) does not promise the bit-exactness the page's
 * `seek(t)` render does: the frames are byte-identical across runs and this
 * WAV is not. A rebuild is not a re-listen at any audible level, but it will not
 * hash the same, and nothing should assert that it does.
 *
 * The arrangement follows the edit's own clock rather than a bar line: each
 * section starts on its scene's boundary in `BragTimeline.astro` (those
 * boundaries are that component's reading budget's answer, so they are not round
 * numbers), and every cut lands on a chord or a hit. Inside a section the pulse
 * and tick grids keep the 0.5s beat wherever there is room for one — at 120 BPM
 * a beat is 0.5s and a bar is 2.0s:
 *
 *   0.00–4.50  hook      pad and a slow pulse: room to hear the copy
 *   4.50–8.10  capture   a bell on each of the four camera marks as it draws
 *   8.10–13.40 pipeline  bass climbs the four stages, then a riser
 *   13.40–22.20 demo     the full groove: a chord per slide, a clock under the
 *                        UI, a tick on the ask to answer dissolve at 16.40
 *   22.20–30.20 proof    ticks and bass drop out, a wash holds the tension
 *   25.75      —         the refusal lands on a soft hit; then four quiet seconds
 *   30.20–34.0 tagline   Am resolves, three bells ring, the master fades out
 *
 * Rust and iron, not a jingle: an A minor pad under a low pulse and a sparse FM
 * bell, which is the sonic version of the design system's rules — rust as the
 * only saturated hue, instrumentation rather than decoration.
 */

function renderBed(ctx) {
  const DURATION = 34;
  const BEAT = 0.5; // 120 BPM

  // Deterministic noise. mulberry32, fixed seed: same bed every build.
  let seed = 0x9e3779b9 >>> 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const noise = (seconds) => {
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = rand() * 2 - 1;
    return buffer;
  };

  /** A reverb impulse: exponentially decaying noise, seeded like the rest. */
  const impulse = (seconds, decay) => {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) data[i] = (rand() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
    return buffer;
  };

  // --- buses ----------------------------------------------------------------

  const mix = ctx.createGain();
  mix.gain.value = 0.62;

  const verbBus = ctx.createGain();
  verbBus.gain.value = 1;
  const convolver = ctx.createConvolver();
  convolver.buffer = impulse(1.9, 2.6);
  const verbLevel = ctx.createGain();
  verbLevel.gain.value = 0.42;
  const verbLow = ctx.createBiquadFilter();
  verbLow.type = 'lowpass';
  verbLow.frequency.value = 2600;
  verbBus.connect(convolver).connect(verbLow).connect(verbLevel).connect(mix);

  // Soft saturation, then a gentle limiter, then the master fade. Three nodes
  // is enough to keep the pulse from clipping when the pad, bass, and bells
  // stack up in the demo section.
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  const k = 1.5;
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k) / Math.tanh(k);
  }
  shaper.curve = curve;
  shaper.oversample = '2x';

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 6;
  limiter.ratio.value = 6;
  limiter.attack.value = 0.004;
  limiter.release.value = 0.18;

  const fade = ctx.createGain();
  fade.gain.setValueAtTime(0.0001, 0);
  fade.gain.linearRampToValueAtTime(1, 0.35);
  // Out over the picture's own half-second close, and a little longer than it:
  // the picture can settle to the ground in 0.5s, but the music resolving that
  // fast would just stop.
  fade.gain.setValueAtTime(1, DURATION - 0.7);
  fade.gain.linearRampToValueAtTime(0.0001, DURATION);

  mix.connect(shaper).connect(limiter).connect(fade).connect(ctx.destination);

  const send = (node, amount) => {
    const gain = ctx.createGain();
    gain.gain.value = amount;
    node.connect(gain).connect(verbBus);
  };

  const panned = (node, pan) => {
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    node.connect(panner);
    return panner;
  };

  // --- voices ---------------------------------------------------------------

  /** The heartbeat: a sine that drops in pitch and dies fast. */
  const pulse = (t, gain = 0.5, dur = 0.6) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(94, t);
    osc.frequency.exponentialRampToValueAtTime(41, t + 0.13);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(mix);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  };

  /** Plucked bass: a filtered triangle, short and round. */
  const pluck = (t, freq, gain = 0.24, dur = 0.75) => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.7;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.014);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(filter).connect(env);
    env.connect(mix);
    send(env, 0.12);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  };

  /** The bell: sine carrier, inharmonic FM index that decays to nothing. */
  const bell = (t, freq, gain = 0.13, dur = 2.4, pan = 0) => {
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = freq;
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = freq * 3.01;
    const index = ctx.createGain();
    index.gain.setValueAtTime(freq * 1.3, t);
    index.gain.exponentialRampToValueAtTime(freq * 0.015, t + 0.45);
    mod.connect(index).connect(carrier.frequency);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    carrier.connect(env);
    const out = panned(env, pan);
    out.connect(mix);
    send(out, 0.55);
    mod.start(t);
    mod.stop(t + dur + 0.02);
    carrier.start(t);
    carrier.stop(t + dur + 0.02);
  };

  /** Sustained pad: two detuned saws a side, through a dark lowpass. */
  const pad = (t, freq, duration, gain = 0.05) => {
    for (const side of [-1, 1]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = side * 7;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 600;
      filter.Q.value = 0.55;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(gain, t + 0.32);
      env.gain.setValueAtTime(gain, t + Math.max(0.4, duration - 0.55));
      env.gain.linearRampToValueAtTime(0.0001, t + duration);
      osc.connect(filter).connect(env);
      const out = panned(env, side * 0.4);
      out.connect(mix);
      send(out, 0.3);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    }
  };

  const chord = (t, duration, freqs, gain = 0.05) => {
    for (const freq of freqs) pad(t, freq, duration, gain);
  };

  /** The clock under the demo: a very short filtered noise burst. */
  const tick = (t, gain = 0.1, pan = 0, freq = 2600) => {
    const src = ctx.createBufferSource();
    src.buffer = noise(0.06);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 1.1;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
    src.connect(filter).connect(env);
    const out = panned(env, pan);
    out.connect(mix);
    send(out, 0.25);
    src.start(t);
    src.stop(t + 0.08);
  };

  /** A noise wash with a moving cutoff: the bed's pressure, not a melody. */
  const wash = (t, duration, gain = 0.045, from = 220, to = 1100) => {
    const src = ctx.createBufferSource();
    src.buffer = noise(2.5);
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.linearRampToValueAtTime(to, t + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(gain, t + duration * 0.75);
    env.gain.linearRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(env).connect(mix);
    src.start(t);
    src.stop(t + duration + 0.05);
  };

  /** The riser into the demo, and the hit that marks a cut. */
  const riser = (t, duration, gain = 0.075) => {
    const src = ctx.createBufferSource();
    src.buffer = noise(2.5);
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(360, t);
    filter.frequency.exponentialRampToValueAtTime(4200, t + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(gain, t + duration * 0.92);
    env.gain.linearRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(env).connect(mix);
    src.start(t);
    src.stop(t + duration + 0.05);
  };

  const hit = (t, gain = 0.34) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(128, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.55);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
    osc.connect(env).connect(mix);
    osc.start(t);
    osc.stop(t + 0.8);
    tick(t, gain * 0.5, 0, 900);
    send(env, 0.2);
  };

  // --- the thirty-four seconds ----------------------------------------------

  // The section starts are the edit's, read straight off the picture's clock.
  const S = { hook: 0, capture: 4.5, pipeline: 8.1, demo: 13.4, proof: 22.2, tagline: 30.2 };
  /** The ask→answer dissolve, and where the refusal takes the frame. */
  const DISSOLVE = S.demo + 3.0;
  const REFUSAL = S.proof + 3.55;

  // 0.00–4.50 — the hook. Alone with the copy, so this stays sparse: the pad,
  // a pulse every second, and one low pluck to lead the ear into the capture.
  chord(S.hook, 4.7, [110, 130.81, 164.81], 0.05);
  pulse(S.hook, 0.46);
  pulse(1.0, 0.3);
  pulse(2.0, 0.28);
  pulse(3.0, 0.26);
  tick(2.0, 0.08, 0.3);
  pluck(3.7, 55.0, 0.19, 0.9);

  // 4.50–8.10 — the capture. The four bells now land on the four camera marks
  // being drawn (1.0s, 1.3s, 1.6s, 1.9s into the scene) rather than near them.
  chord(S.capture, 3.7, [110, 130.81, 164.81], 0.048);
  pulse(S.capture, 0.44);
  pulse(S.capture + 1.0, 0.28);
  pulse(S.capture + 2.0, 0.3);
  tick(S.capture, 0.09, 0);
  [440.0, 659.25, 523.25, 783.99].forEach((freq, index) => {
    const at = S.capture + 1.0 + index * 0.3;
    bell(at, freq, 0.11, 2.1, [-0.35, 0.4, -0.15, 0.25][index]);
    tick(at, 0.055, index % 2 === 0 ? -0.25 : 0.25);
  });

  // 8.10–13.40 — the pipeline. The bass climbs the four stages as the columns
  // fill (0.55s, 1.05s, 1.55s, 2.05s into the scene), then the riser hands the
  // frame to the demo.
  chord(S.pipeline, 2.7, [110, 130.81, 164.81], 0.046);
  chord(S.pipeline + 2.1, 3.1, [98.0, 123.47, 146.83], 0.044);
  pulse(S.pipeline, 0.42);
  pulse(S.pipeline + 1.0, 0.34);
  pulse(S.pipeline + 2.0, 0.32);
  pulse(S.pipeline + 3.0, 0.3);
  pulse(S.pipeline + 4.0, 0.34);
  const bassLine = [55.0, 65.41, 82.41, 98.0];
  // One pluck per column, on the column's own beat.
  bassLine.forEach((freq, i) => pluck(S.pipeline + 0.6 + i * 0.5, freq, 0.22, 0.5));
  tick(S.pipeline, 0.09, 0);
  for (let t = S.pipeline + 0.5; t < S.pipeline + 5.3; t += BEAT) {
    tick(t, 0.055, Math.round(t * 2) % 2 === 0 ? -0.25 : 0.25);
  }
  riser(S.pipeline + 4.4, 0.85);

  // 13.40–22.20 — the demo. The section the piece was always built around, now
  // at its proper length: the full sixteen-note ostinato, a chord per slide, the
  // clock under the UI, and a tick on the ask→answer dissolve so the ear follows
  // the cut at 16.40.
  chord(S.demo, 2.6, [110, 130.81, 164.81], 0.05);
  chord(S.demo + 3.0, 2.6, [87.31, 110, 130.81], 0.05);
  chord(S.demo + 5.6, 3.2, [98.0, 123.47, 146.83], 0.048);
  for (let t = S.demo; t < S.demo + 8.6; t += 1.0) pulse(t, t === S.demo ? 0.46 : 0.36);
  const ostinato = [
    55.0, 110.0, 82.41, 55.0, 43.65, 87.31, 65.41, 43.65, 49.0, 98.0, 73.42, 49.0, 55.0, 110.0,
    82.41, 65.41,
  ];
  ostinato.forEach((freq, i) => pluck(S.demo + i * BEAT, freq, 0.2, 0.46));
  for (let t = S.demo; t < S.demo + 8.8; t += BEAT) {
    tick(t, 0.05, Math.round(t * 2) % 2 === 0 ? -0.22 : 0.22);
  }
  tick(S.demo, 0.1, 0);
  tick(DISSOLVE, 0.11, 0, 3200);
  bell(S.demo + 0.6, 659.25, 0.11, 2.1, 0.4);
  bell(S.demo + 4.2, 880.0, 0.1, 2.2, -0.3);
  bell(S.demo + 7.0, 783.99, 0.1, 2.1, 0.25);

  // 22.20–30.20 — the proof. The clock stops; the wash holds the tension; the
  // refusal lands at 25.75 and then the frame is deliberately almost silent for
  // four seconds, which is the longest quiet in the piece and the point of it.
  hit(S.proof, 0.32);
  chord(S.proof, 2.9, [87.31, 110, 130.81], 0.046);
  // Deliberately quieter than the answer's own section, and quieter again after
  // the refusal lands: the abstention is the beat the room should go quiet for.
  chord(S.proof + 3.1, 3.1, [82.41, 103.83, 123.47], 0.024);
  pulse(S.proof, 0.44);
  pulse(S.proof + 2.0, 0.3);
  pulse(REFUSAL, 0.17);
  pluck(S.proof, 43.65, 0.2, 1.0);
  pluck(S.proof + 3.1, 41.2, 0.15, 1.0);
  wash(S.proof, 7.6, 0.036, 180, 1200);
  riser(S.proof + 2.3, 0.85, 0.06);
  hit(REFUSAL, 0.24);
  bell(S.proof + 6.6, 329.63, 0.07, 2.4, 0.15);

  // 30.20–34.00 — the tagline. The resolution the whole bed has been leaning
  // on, with the master fade taking the last 0.7s.
  chord(S.tagline, 3.6, [110, 130.81, 164.81], 0.055);
  pulse(S.tagline, 0.45);
  pulse(S.tagline + 1.0, 0.26);
  pluck(S.tagline, 55.0, 0.22, 1.4);
  bell(S.tagline + 0.05, 880.0, 0.16, 3.4, 0.15);
  bell(S.tagline + 0.5, 659.25, 0.12, 3.0, -0.25);
  bell(S.tagline + 1.8, 1108.73, 0.08, 2.6, 0.35);

  // Peak-normalize on the way out: a fixed gain derived from the render, so the
  // exported WAV is at the same level on every machine instead of at whatever
  // the mix happened to sum to, and loud enough that nobody has to turn the
  // video up. The peak moves in the seventh decimal between renders (see the
  // note at the top of this file), so the gain does too: the level is what
  // reproduces here, not the bytes.
  return (buffer) => {
    let peak = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < data.length; i++) {
        const value = Math.abs(data[i]);
        if (value > peak) peak = value;
      }
    }
    const target = 0.89;
    const gain = peak > 0 ? target / peak : 0;
    let sum = 0;
    let count = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < data.length; i++) {
        data[i] *= gain;
        sum += data[i] * data[i];
        count++;
      }
    }
    return { peak, appliedGain: gain, rms: Math.sqrt(sum / count) };
  };
}
