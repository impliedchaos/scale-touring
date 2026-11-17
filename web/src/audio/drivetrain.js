// Fake gearbox: turns road speed + driver intent into engine rpm and load for the synth.
// Real-ish gear ratios, short final drives (more scream), and touge habits: upshift near redline,
// aggressive downshifts with throttle blips when braking for hairpins, rev limiter bounce in the air.
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export const GEARBOXES = {
  // the 86 runs a TRD Group A 4A-GE: redline 11,000, but it normally shifts around 9,000 (`shift`; default redline - 350).
  // `down`: rpm under which it drops a gear [coasting, braking hard] (default [4200, 5800]); a high-revving close box
  // wants both higher.
  // Close-ratio box (each step ×1.23) on a short final drive: every upshift lands around 7,300, right in the power, for
  // getting back up to speed out of a corner; 1st runs to ~64 km/h, and 5th tops out near 10,000 at the 86's top speed
  // (166 km/h)
  ae86:    { ratios: [2.56, 2.07, 1.68, 1.36, 1.10], reverse: 3.484, final: 6.0, idle: 950, redline: 11000, limiter: 11200, shift: 9000,
             down: [5400, 7600] },
  r32:     { ratios: [3.214, 1.925, 1.302, 1.0, 0.752], reverse: 3.369, final: 4.9, idle: 900, redline: 8000, limiter: 8200 },
  gtr:     { ratios: [4.056, 2.301, 1.595, 1.248, 1.001, 0.796], reverse: 3.383, final: 4.2, idle: 850, redline: 7000, limiter: 7100 },
  supra:   { ratios: [3.827, 2.36, 1.685, 1.312, 1.0, 0.793], reverse: 3.28, final: 4.2, idle: 850, redline: 6800, limiter: 7000 },
  celica6: { ratios: [3.23, 1.913, 1.258, 0.918, 0.731], reverse: 3.545, final: 5.0, idle: 900, redline: 7000, limiter: 7200 },
  rx7:     { ratios: [3.483, 2.015, 1.391, 1.0, 0.762], reverse: 3.288, final: 4.1, idle: 800, redline: 7500, limiter: 7800 }, // FC turbo: 13B rotary, revs out
  celica7: { ratios: [3.166, 2.05, 1.481, 1.166, 0.916, 0.725], reverse: 3.25, final: 5.1, idle: 900, redline: 8200, limiter: 8400 },
};

export class Drivetrain {
  constructor(box, wheelRadius) {
    this.box = box;
    this.r = wheelRadius;
    this.gear = 1;
    this.rpm = box.idle;
    this.load = 0;
    this.vPrev = 0;
    this.accel = 0;
    this.shiftT = 0; this.blipT = 0; this.cutT = 0; this.limT = 0;
  }

  wheelRpm(v) { return (Math.abs(v) / this.r) * (60 / (2 * Math.PI)) * this.box.final; }

  /** throttle/brake: driver intent (0/1). slip: rear wheelspin 0..1 (drifting). */
  update(dt, { v, throttle = 0, brake = 0, slip = 0, airborne = false }) {
    if (dt <= 0) return this;
    const box = this.box;
    const a = (v - this.vPrev) / dt;
    this.vPrev = v;
    this.accel += (a - this.accel) * Math.min(1, dt * 6);
    const w = this.wheelRpm(v);
    const inGear = (g) => w * box.ratios[g - 1];

    if (v < -0.5) this.gear = -1;
    else if (this.gear < 1) this.gear = 1;
    const shiftAt = box.shift ?? box.redline - 350, downAt = box.down ?? [4200, 5800];
    if (this.gear >= 1 && this.shiftT <= 0 && !airborne) {
      const top = this.gear >= box.ratios.length;
      // upshift at the shift point, or when it's stopped gaining speed (flat out at the car's top speed, cruising) and
      // the next gear still keeps it on the boil: nobody holds 4th at 8,000 down a straight
      const cruising = Math.abs(this.accel) < 0.6 && w * box.ratios[Math.min(this.gear, box.ratios.length - 1)] > shiftAt * 0.6;
      if (!top && (inGear(this.gear) > shiftAt || cruising)) {
        this.gear++; this.shiftT = 0.14; this.cutT = 0.08;                      // upshift: brief fuel cut
      } else if (this.gear > 1 && inGear(this.gear - 1) < shiftAt - 150 &&
                 (inGear(this.gear) < downAt[0] || (this.accel < -3 && inGear(this.gear) < downAt[1]))) {
        this.gear--; this.shiftT = 0.16; this.blipT = 0.13;                     // downshift: heel-toe blip
      }
    }
    this.shiftT -= dt; this.blipT -= dt; this.cutT -= dt; this.limT -= dt;

    const ratio = this.gear < 0 ? box.reverse : box.ratios[this.gear - 1];
    // wheelspin in drifts revs it up, but stays under redline: the limiter stutter is saved for jumps
    let target = Math.min(w * ratio * (1 + slip * 0.3), Math.max(box.redline, w * ratio));
    if (Math.abs(v) < 4) target = Math.max(target, box.idle + throttle * 2600 * (1 - Math.abs(v) / 4)); // clutch slip
    target = Math.max(target, box.idle);

    // load: off-throttle when coasting or braking; lifts automatically when the car scrubs speed for a corner
    let load;
    if (airborne) load = throttle ? 1 : 0.3;
    else if (brake) load = 0;
    else if (throttle) load = this.accel < -2 ? 0.1 : 1;
    else load = 0.05;
    if (airborne) target = load > 0.5 ? box.limiter + 400 : Math.max(box.idle * 1.5, this.rpm * 0.97);
    if (this.blipT > 0) load = 1;
    if (this.cutT > 0) load = 0;
    if (this.rpm > box.limiter) this.limT = 0.06;                              // bang off the limiter
    if (this.limT > 0) { load = 0; target = Math.min(target, box.limiter - 350); }

    this.rpm += (target - this.rpm) * Math.min(1, dt * (this.shiftT > 0 ? 14 : 22));
    this.load += (load - this.load) * Math.min(1, dt * 18);
    this.rpm = clamp(this.rpm, box.idle * 0.8, box.limiter + 200);
    return this;
  }
}
