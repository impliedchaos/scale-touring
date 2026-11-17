// Cartoon drift choreography for an on-rails car: racing line, speed plan, and the drift (body yaw) spring.
// Not physics. It's choreography tuned to look outrageous.
import * as THREE from 'three';

/** Gaussian-smooth an array (sigma in samples), clamping at the ends. */
export function smoothArray(a, sigma) {
  const r = Math.ceil(sigma * 3), w = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0, ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = Math.min(Math.max(i + k, 0), a.length - 1);
      s += a[j] * w[k + r]; ws += w[k + r];
    }
    out[i] = s / ws;
  }
  return out;
}

export const DRIFT_TUNING = {
  vmax: 46,          // m/s (~165 km/h) top speed on the straights
  aLat: 30,          // m/s² "grip" — wildly unrealistic, on purpose
  decel: 18, accel: 8,
  maxAngle: 1.15,    // rad (~66°) max body angle to the road
  driftFrom: 120,    // corner radius (m) where drifting starts...
  driftFull: 25,     // ...and where it's fully sideways
  driftSpeed: [8, 18], // m/s: no drift below the first, full drift above the second
  feint: 0.55,       // how hard to flick the wrong way before a corner
  omega: 7.5, zeta: 0.5, // drift spring: frequency (rad/s) and damping (<1 overshoots)
  lineGain: 28,      // racing-line aggression
};

export class DriftLine {
  constructor(path, tuning = DRIFT_TUNING, { flyingStart = false } = {}) {
    this.path = path;
    this.t = tuning = { ...DRIFT_TUNING, ...tuning };
    const n = path.n, st = path.step;
    this.Ks = smoothArray(path.K, 3); // curvature smoothed over ~6 m

    // racing line: outside before the corner, inside at the apex (positive lateral = right)
    const lim = path.half - 1.1, ahead = Math.round(26 / st);
    const k = (i) => this.Ks[Math.min(Math.max(i, 0), n - 1)];
    const lat = new Float32Array(n);
    for (let i = 0; i < n; i++) lat[i] = lim * Math.tanh(tuning.lineGain * (k(i) - 0.75 * k(i + ahead)));
    this.lat = smoothArray(lat, 6);

    // speed plan: corner limit, braking pass (backward), acceleration pass (forward)
    const v = Array.from(this.Ks, (kk) => Math.min(tuning.vmax, Math.sqrt(tuning.aLat / Math.max(Math.abs(kk), 1e-4))));
    const fin = Math.floor(path.finish / st);
    for (let i = fin + 40; i < n; i++) v[i] = 0; // stop in the run-off
    for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * tuning.decel * st));
    if (!flyingStart) v[0] = 0;
    for (let i = 0; i < n - 1; i++) v[i + 1] = Math.min(v[i + 1], Math.sqrt(v[i] ** 2 + 2 * tuning.accel * st));
    this.v = v;

    this.angle = 0;     // body yaw relative to the road; + = nose to the right
    this.angleVel = 0;
  }

  _interp(arr, s) {
    const f = Math.min(Math.max(s / this.path.step, 0), this.path.n - 1.001), i = Math.floor(f), t = f - i;
    return arr[i] * (1 - t) + arr[i + 1] * t;
  }
  speedAt(s) { return this._interp(this.v, s); }
  lateralAt(s) { return this._interp(this.lat, s); }
  curvatureAt(s) { return this._interp(this.Ks, s); }

  /** Where the drift spring wants the body to point. */
  targetAngle(s, v) {
    const { maxAngle, driftFrom, driftFull, driftSpeed, feint } = this.t;
    const gate = THREE.MathUtils.clamp((v - driftSpeed[0]) / (driftSpeed[1] - driftSpeed[0]), 0, 1);
    const k0 = 1 / driftFrom, k1 = 1 / driftFull;
    const F = (d) => {
      const k = this.curvatureAt(s + d);
      const m = THREE.MathUtils.clamp((Math.abs(k) - k0) / (k1 - k0), 0, 1);
      return Math.sign(k) * maxAngle * Math.pow(m, 0.7) * gate;
    };
    const near = F(v * 0.25 + 4);      // the corner we're in / about to be in
    const far = F(v * 0.9 + 14);       // the next one: flick the other way first (inertia drift)
    return near - feint * far * (1 - Math.abs(near) / maxAngle);
  }

  update(dt, s, v) {
    const { omega, zeta, maxAngle } = this.t;
    const target = this.targetAngle(s, v);
    const n = Math.max(1, Math.ceil(dt / 0.005));
    const h = dt / n;
    for (let k = 0; k < n; k++) {
      const acc = omega * omega * (target - this.angle) - 2 * zeta * omega * this.angleVel;
      this.angleVel += acc * h;
      this.angle += this.angleVel * h;
    }
    this.angle = THREE.MathUtils.clamp(this.angle, -maxAngle * 1.25, maxAngle * 1.25);
    return this.angle;
  }

  /** Throw the car sideways (rad/s of yaw rate); the spring brings it back. */
  kick(rate) { this.angleVel += rate; }

  /** Lateral acceleration demand at s (signed, m/s²), used for body roll and effects. */
  lateralDemand(s, v) { return v * v * this.curvatureAt(s); }
}
