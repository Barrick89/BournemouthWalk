// ============================================================================
// audio: a procedural seaside soundscape (no sample files)
// ============================================================================
// A fixed Web Audio graph, built on the first click / key / touch and driven by a 10 Hz timer, not the frame loop.
// Layers: surf that swells with the wash on the sand (the same rhythm as the waves you see), the hiss of the
// foam, wind (stronger up high and out on the piers), herring gulls, and footsteps that sound like the ground.
let AC, OUT, muted = false, playStep = () => {};
const VOL = 0.75;
function mkSound(ac) {
  const sr = ac.sampleRate;
  const N = (C, o, ...to) => { const n = new C(ac, o); for (const d of to) n.connect(d); if (n.start) n.start(); return n; };
  const G = (gain, ...to) => N(GainNode, { gain }, ...to);
  const BQ = (type, frequency, Q, ...to) => N(BiquadFilterNode, { type, frequency, Q }, ...to);
  const lfo = (frequency, depth, to) => N(OscillatorNode, { frequency }, G(depth, to));
  const noise = (secs, f) => { const n = sr * secs | 0, b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr }); f(b.getChannelData(0), n); f(b.getChannelData(1), n); return b; };
  // seamless brown noise loop (the end cross-fades into the start) and plain white noise
  const brown = noise(9, (d, n) => { for (let i = 0, b = 0; i < n + 4096; i++) { b = (b + 0.02 * (rnd() * 2 - 1)) / 1.02; if (i < n) d[i] = b * 3.5; else { const k = (i - n) / 4096; d[i - n] = d[i - n] * k + b * 3.5 * (1 - k); } } });
  const white = noise(2, (d, n) => { for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1; });
  const src = (buffer, playbackRate, ...to) => N(AudioBufferSourceNode, { buffer, loop: true, playbackRate }, ...to);

  const lim = N(DynamicsCompressorNode, { threshold: -8, knee: 6, ratio: 12, attack: 0.003, release: 0.25 }, ac.destination);
  const out = OUT = G(0, lim);
  // surf: low roar + foam hiss, both following the wash
  const surf = G(0, out), hiss = G(0, out);
  src(brown, 1, BQ('lowpass', 520, 0.6, surf)); src(brown, 0.71, BQ('lowpass', 900, 0.4, surf));
  src(white, 1, BQ('bandpass', 2600, 0.5, hiss));
  const far = G(0.12, out); src(brown, 0.53, BQ('bandpass', 380, 0.5, far)); lfo(0.05, 0.04, far.gain);
  // wind
  const wind = G(0.05, out), windF = BQ('bandpass', 600, 0.8, wind);
  src(brown, 1.37, windF); lfo(0.13, 0.03, wind.gain); lfo(0.071, 160, windF.frequency);
  // gulls: pooled voices, a sawtooth through a resonant band-pass, panned
  const gull = Array.from({ length: 3 }, () => { const p = N(StereoPannerNode, {}, out), g = G(0, p), f = BQ('bandpass', 1800, 3, g); return { p, g, o: N(OscillatorNode, { type: 'sawtooth', frequency: 1200 }, f) }; });
  // footsteps: two voices on looping noise, filter set by the surface
  const steps = Array.from({ length: 2 }, () => { const g = G(0, out), f = BQ('lowpass', 600, 1, g); src(white, 1, f); return { g, f }; });
  // surfaces: 0 dry sand, 1 wet sand, 2 concrete, 3 timber, 4 grass
  const SURF = [['lowpass', 520, 0.7, 0.32, 0.06], ['lowpass', 380, 1.5, 0.35, 0.05], ['bandpass', 1900, 0.9, 0.3, 0.025], ['lowpass', 260, 6, 0.6, 0.05], ['lowpass', 900, 0.5, 0.18, 0.05]];
  let si = 0;
  playStep = (s) => {
    if (AC.state !== 'running') return;
    const v = steps[si ^= 1], t = ac.currentTime + 0.01, [type, f, q, vol, dec] = SURF[s];
    v.f.type = type; v.f.frequency.setValueAtTime(f * rr(0.85, 1.15), t); v.f.Q.setValueAtTime(q, t);
    v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(0, t); v.g.gain.linearRampToValueAtTime(vol * rr(0.7, 1), t + 0.006); v.g.gain.setTargetAtTime(0, t + 0.012, dec);
  };
  let tG = ac.currentTime + 2, gi = 0;
  out.gain.setTargetAtTime(VOL, ac.currentTime, 1);
  return () => {
    const t = ac.currentTime + 0.05;
    // the wash: same phase as swash() in the sea shader
    const ph = TIME * 0.75 + px * 0.011, rise = cos(ph), prox = 1 / (1 + abs(pz + 46) / 20) * (feet > 3.5 ? 0.75 : 1);
    const k = max(rise, 0) ** 2;
    surf.gain.setTargetAtTime(prox * (0.12 + 0.55 * k), t, 0.35);
    hiss.gain.setTargetAtTime(prox * (0.015 + 0.09 * max(sin(ph - 0.6), 0) ** 3), t, 0.25);
    wind.gain.setTargetAtTime(0.04 + clamp((feet - 2) / 30, 0, 1) * 0.12 + (pz < -60 ? 0.05 : 0), t, 1);
    if (t > tG) {
      // a call of 2-5 falling "kyow" notes, sometimes a laugh of short ones
      const v = gull[gi++ % 3], fast = rnd() < 0.35, n = 2 + rnd() * 4 | 0, base = rr(1000, 1500), vol = rr(0.015, 0.05);
      v.p.pan.setValueAtTime(rr(-0.9, 0.9), t);
      let tt = t;
      for (let i = 0; i < n; i++) {
        const d = fast ? 0.12 : rr(0.22, 0.32);
        v.o.frequency.setValueAtTime(base * 1.35, tt); v.o.frequency.exponentialRampToValueAtTime(base * 0.75, tt + d);
        v.g.gain.setValueAtTime(0, tt); v.g.gain.linearRampToValueAtTime(vol, tt + 0.02); v.g.gain.setTargetAtTime(0, tt + d * 0.6, d * 0.25);
        tt += d * (fast ? 1.2 : 1.5);
      }
      tG = tt + rr(3, 14);
    }
  };
}
// called on every click / key / touch: builds the graph once and resumes it when the browser allows
function sound() {
  if (!AC) { AC = new AudioContext({ latencyHint: 'playback' }); setInterval(mkSound(AC), 100); }
  if (AC.state === 'suspended' && !document.hidden) AC.resume();
}
const mute = () => { if (!AC) return; muted = !muted; OUT.gain.setTargetAtTime(muted ? 0 : VOL, AC.currentTime, 0.08); };
document.addEventListener('visibilitychange', () => { if (AC) document.hidden ? AC.suspend() : AC.resume(); });
