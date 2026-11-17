// Engine synth DSP: a train of combustion pulses. Each firing is a short ringing, decaying pulse plus a little
// noise; a fixed per-cylinder imbalance pattern and random timing/amplitude jitter make it lope like an engine
// instead of buzzing like an oscillator. Lifting off at high rpm backfires a few times (a short burst right after
// the lift, not for as long as you coast: the course is all downhill, so coasting at high rpm is most of it).
//
// Self-contained ON PURPOSE: sound.js stringifies this class into an AudioWorklet, and also runs it directly in a
// ScriptProcessor fallback (worklets need a secure context, so plain-http hosting would otherwise be silent).
// Do not reference anything outside the class.
export class EngineCore {
  constructor(sampleRate, pattern) {
    this.sr = sampleRate;
    this.pattern = pattern || [1, 0.8, 0.94, 0.74];
    this.phase = 0;
    this.idx = 0;
    this.jit = 0;
    this.pulses = [];
    this.x1 = 0;
    this.y1 = 0;
    this.seed = 0x2545f491;
    this.rpm = 900;
    this.load = 0;
    this.onGas = false; // was the throttle open? lifting from it starts a short burst of pops
    this.popT = 0;      // seconds of that burst left
    // targets, set from outside (AudioParams in the worklet, plain assignment in the fallback)
    this.p = {
      rpm: 900, load: 0, firingsPerRev: 2, decay: 0.0055, resonance: 190, resTrack: 0.55,
      rough: 0.12, jitter: 0.015, noise: 0.35, uneven: 0.25, pops: 0.6,
    };
  }

  rand() {
    let x = this.seed | 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x;
    return (x >>> 0) / 4294967296;
  }

  process(out) {
    const p = this.p, sr = this.sr, n = out.length;
    this.rpm += (p.rpm - this.rpm) * 0.35;           // de-zipper control changes per block
    this.load += (p.load - this.load) * 0.35;
    const rpm = this.rpm, load = this.load;
    if (load > 0.35) this.onGas = true;
    else if (load < 0.1 && this.onGas) { this.onGas = false; this.popT = 0.9; }
    this.popT = Math.max(0, this.popT - n / sr);
    const popChance = p.pops * 0.05 * (this.popT / 0.9); // tails off over the burst
    const firingHz = (rpm / 60) * p.firingsPerRev;    // 4-stroke: cylinders/2 firings per crank revolution
    const resHz = p.resonance * (1 - p.resTrack + p.resTrack * (rpm / 3000));
    const w = (2 * Math.PI * resHz) / sr;
    const k = Math.exp(-1 / Math.max(1, p.decay * sr));
    const pat = this.pattern, L = pat.length;
    for (let i = 0; i < n; i++) {
      this.phase += (firingHz * (1 + this.jit)) / sr;
      if (this.phase >= 1) {
        this.phase -= 1;
        this.jit = (this.rand() * 2 - 1) * p.jitter;
        const c = this.idx++ % L;
        let amp = (1 - p.uneven * (1 - pat[c])) * (1 + (this.rand() * 2 - 1) * p.rough) * (0.22 + 0.78 * load);
        let nz = p.noise;
        if (load < 0.1 && rpm > 3500 && this.rand() < popChance) { amp *= 3; nz *= 4; } // backfire
        this.pulses.push({ t: 0, env: amp, nz });
        if (this.pulses.length > 8) this.pulses.shift();
      }
      let s = 0;
      for (let j = 0; j < this.pulses.length; j++) {
        const q = this.pulses[j];
        s += q.env * (Math.sin(w * q.t) + q.nz * (this.rand() * 2 - 1));
        q.env *= k;
        q.t++;
      }
      const y = s - this.x1 + 0.996 * this.y1;          // DC blocker
      this.x1 = s;
      this.y1 = y;
      out[i] = y * 0.45;
    }
    let m = 0;
    for (const q of this.pulses) if (q.env > 1e-4) this.pulses[m++] = q;
    this.pulses.length = m;
  }
}

export const ENGINE_PARAM_NAMES = ['rpm', 'load', 'firingsPerRev', 'decay', 'resonance', 'resTrack', 'rough', 'jitter', 'noise', 'uneven', 'pops'];
