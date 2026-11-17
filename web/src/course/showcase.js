// The drone and its car: an 86 flat out down the mountain with a bootlegger reverse at each end, and a drone flying
// long, slow shots of the course at the car's pace. Used by the fly-by.
import * as THREE from 'three';
import { CarRig } from '../game/car.js';
import { DriftLine } from './drift.js';
import { Smoke, SkidMarks } from './effects.js';
import { beamStrength } from '../game/beams.js';

/** Dress the scene for the drone: see further than from the road (even fog thins out above it), a brighter moon at
 *  night (no headlights up there), a long far plane. Returns a function that puts it all back. */
export function droneLook(scene, camera, { day, weather }) {
  const saved = { density: scene.fog.density, far: camera.far, fov: camera.fov, lights: [] };
  scene.fog.density *= weather.fog ? 0.33 : 0.66;
  // scaled and unscaled rather than saved and restored, so it stacks with moon shadows switching on or off meanwhile
  if (!day) scene.traverse((o) => {
    if (!o.isLight || o.isSpotLight) return; // the moon and sky, not anyone's headlights
    const k = o.isHemisphereLight ? 2.6 : 4;
    saved.lights.push([o, k]);
    o.intensity *= k;
  });
  camera.far = 9000;
  camera.fov = 55;
  camera.updateProjectionMatrix();
  return () => {
    scene.fog.density = saved.density;
    for (const [o, k] of saved.lights) o.intensity /= k;
    camera.far = saved.far;
    camera.fov = saved.fov;
    camera.updateProjectionMatrix();
  };
}

// ---------------------------------------------------------------- the car
const STOP_TOP = 150;              // the uphill run stops this far below the start line
const ACCEL = 8, REV_ACCEL = 7, REV_TOP = 15, WHIP_T = 0.95;

/** run (nose along `dir`: +1 downhill, -1 uphill) → stop → back up the way it came → whip 180° (bootlegger reverse)
 *  → run the other way, forever. `s` is where it is on the course. */
export class BootlegCar {
  /** `tuning`, `lane`: a car's driving (DRIVERS in drivers.js); defaults are the 86's. */
  constructor({ path, scene, weather, day, gltf, spec, shadow = false, s = 0, dir = 1, tuning = undefined, lane = 0 }) {
    this.path = path;
    this.weather = weather;
    this.rig = new CarRig('c', gltf, spec, { scene, day, wet: weather.wet, beams: beamStrength(weather, day), shadow, ground: (x, z) => path.surfaceAt(x, z) });
    scene.add(this.rig.root);
    weather.addBeams(this.rig.beams);
    // The drift choreography both ways: downhill on the course, uphill on a mirror of it (arc length from
    // the bottom, curvature negated: a right-hander going down is a left-hander coming up). Each speed plan ends in a
    // stop: past the finish going down, a little below the summit going up.
    this.L = (path.n - 1) * path.step;
    const mirror = { step: path.step, half: path.half, n: path.n, K: Float32Array.from(path.K).reverse().map((k) => -k), finish: this.L - STOP_TOP - 80 };
    this.down = new DriftLine(path, tuning, { flyingStart: true });
    this.up = new DriftLine(mirror, tuning);
    this.lane = lane;
    this.smoke = new Smoke(scene, { color: day ? 0xe4e4e4 : 0x8a909c });
    this.skids = new SkidMarks(scene);
    this.restart(s, dir);
  }

  /** Back to `s`, flat out (a flying start) downhill, or uphill with `dir` -1. */
  restart(s = 0, dir = 1) {
    const line = dir > 0 ? this.down : this.up;
    Object.assign(this, { s, dir, phase: 'run', v: line.speedAt(dir > 0 ? s : this.L - s), t: 0, lat: 0, whipSide: 1, speed: 0 });
    line.angle = line.angleVel = 0;
    this._step(0);
    this.rig.resetVelocity(this.skids);
  }

  /** Advance `dt` seconds (in small steps, for the drift spring) and update its smoke. */
  update(dt, camera, renderer, fog) {
    for (let k = 0, n = Math.ceil(dt / 0.02); k < n; k++) this._step(dt / n);
    if (!dt) this._step(0);
    this.smoke.update(dt, camera, renderer, fog);
  }

  /** Which way a camera following it should look down the road: the way the nose points (swaps halfway round a whip). */
  camDir() { return this.phase === 'whip' && this.t > WHIP_T / 2 ? -this.dir : this.dir; }

  _step(dt) {
    const r = this.rig, path = this.path;
    const base = this.dir > 0 ? 0 : Math.PI;        // nose downhill / uphill, as a yaw from the road's forward
    let angle = base, slip = 0, speed = this.v, lat = this.lat, demand = 0;
    this.t += dt;
    if (this.phase === 'run') {
      const line = this.dir > 0 ? this.down : this.up, sl = this.dir > 0 ? this.s : this.L - this.s;
      const plan = line.speedAt(sl);
      this.v = Math.min(plan, this.v + ACCEL * dt);
      this.s = THREE.MathUtils.clamp(this.s + this.dir * this.v * dt, 0, this.L);
      slip = line.update(dt, sl, this.v);
      angle = base + slip;
      // a lane habit: mostly that side of the road (right of the way it's going), a bit of line
      lat = this.lat = this.dir * (this.lane ? THREE.MathUtils.clamp(line.lateralAt(sl) * 0.4 + this.lane, -2.4, 2.4) : line.lateralAt(sl));
      demand = line.lateralDemand(sl, this.v);
      speed = this.v;
      if (this.v < 0.3 && plan < 0.5 && dt > 0) { this.phase = 'stop'; this.t = 0; this.v = 0; }
    } else if (this.phase === 'stop') {             // a beat, then into reverse
      speed = 0;
      if (this.t > 0.7) { this.phase = 'reverse'; this.t = 0; }
    } else if (this.phase === 'reverse') {          // backing up the way it came, building speed
      this.v = Math.min(this.v + REV_ACCEL * dt, REV_TOP);
      this.s = THREE.MathUtils.clamp(this.s - this.dir * this.v * dt, 0, this.L);
      this.lat += (0 - this.lat) * Math.min(1, dt * 0.8); // drift to the middle of the road
      lat = this.lat;
      speed = -this.v;                              // wheels turn backwards
      if (this.v >= REV_TOP) {
        this.phase = 'whip'; this.t = 0;
        this.whipSide = Math.sign(this.lat) || 1;   // swing the nose out towards the side it's on: room to turn
      }
    } else {                                        // whip: yank it round, still sliding the same way
      const u = Math.min(this.t / WHIP_T, 1), e = u * u * (3 - 2 * u);
      slip = -this.whipSide * Math.PI * (1 - e);    // how far the nose is from the way it's travelling...
      angle = base + this.whipSide * Math.PI * e;   // ...as it comes round
      const v = REV_TOP * (1 - 0.4 * u);
      this.s = THREE.MathUtils.clamp(this.s - this.dir * v * dt, 0, this.L);
      lat = this.lat;
      speed = v;
      if (u >= 1) {                                 // facing the way it's going: drive off
        this.dir = -this.dir; this.phase = 'run'; this.v = v; this.t = 0;
        const line = this.dir > 0 ? this.down : this.up;
        line.angle = line.angleVel = 0;
      }
    }
    r.poseOnRoad(path, this.s, lat, angle, demand);
    r.animate(dt, speed, slip, r.o.curvature * this.dir);
    r.trackVelocity(dt);
    if (dt > 0) { r.tireFx(dt, Math.abs(speed), slip, this.smoke, this.skids); this.weather.spray(r, Math.abs(speed), dt); }
    this.speed = Math.abs(speed);
    // what its engine would be doing, for the sound (course/audio.js): signed road speed, drift 0..1, whether it's on the gas
    this.drive = { v: speed, slip: Math.min(1, Math.abs(slip) / 0.9), throttle: this.phase === 'run' ? 1 : this.phase === 'stop' ? 0 : 0.6 };
  }
}

// ---------------------------------------------------------------- the drone
// Slow overlapping waves so it drifts between high sweeping aerials and low skims down the road.
const wave = (sv, period, phase = 0) => 0.5 + 0.5 * Math.sin((sv / period) * Math.PI * 2 + phase);
function shot(sv) {
  const high = wave(sv, 2300, -1.2) * 0.75 + wave(sv, 900, 0.7) * 0.25; // 0 = skimming, 1 = high
  return {
    height: 22 + 120 * high,
    back: 35 + 70 * high,                                              // how far behind the look point
    side: 70 * Math.sin((sv / 3100) * Math.PI * 2) * (0.4 + high),     // swing out to one side, then the other
    ahead: 70 + 90 * high,
  };
}

const LOOK_SAMPLES = 6;
const MAX_YAW = THREE.MathUtils.degToRad(60), MAX_PITCH = THREE.MathUtils.degToRad(30); // rad/s: hairpins need ~75°/s, so it trails a touch

export class Drone {
  static maxYaw = MAX_YAW; // rad/s (a static so tests can lift it)
  /** `lookAhead`: scales how far up the road it looks, so <1 keeps what it's following nearer the middle of the
   *  frame (for a zoomed-in lens, e.g. the fly-by's tilt-shift). */
  constructor(path, heightAt, camera, { lookAhead = 1 } = {}) {
    this.path = path;
    this.lookAhead = lookAhead;
    this.heightAt = heightAt;
    this.camera = camera;
    // The road itself has hairpins a camera can't follow gracefully; a gaussian-blurred copy (σ ≈ 45 m) cuts the
    // corners like a drone pilot would. Sampled every path step; lookups interpolate.
    const N = path.n, step = path.step;
    this.smooth = new Float32Array(N * 3);
    const sig = 45 / step, R = Math.ceil(sig * 3), w = [];
    for (let k = -R; k <= R; k++) w.push(Math.exp(-0.5 * (k / sig) ** 2));
    for (let i = 0; i < N; i++) {
      let x = 0, y = 0, z = 0, ws = 0;
      for (let k = -R; k <= R; k++) {
        const p = path.P[THREE.MathUtils.clamp(i + k, 0, N - 1)], wk = w[k + R];
        x += p.x * wk; y += p.y * wk; z += p.z * wk; ws += wk;
      }
      this.smooth.set([x / ws, y / ws, z / ws], i * 3);
    }
    this.cam = new THREE.Vector3(); this.look = new THREE.Vector3();
    this.road = {}; // the road sample it's looking at
    this._goal = new THREE.Vector3(); this._lookGoal = new THREE.Vector3();
    this._a = new THREE.Vector3(); this._b = new THREE.Vector3(); this._dir = new THREE.Vector3(); this._side = new THREE.Vector3();
    this.reset();
  }

  /** The point on the road it's looking at. */
  get focus() { return this._lookGoal; }

  /** Next aim() jumps straight to the shot instead of flying there. */
  reset() { this.first = true; }

  _lineAt(sv, out) {
    const N = this.path.n, sm = this.smooth;
    const f = THREE.MathUtils.clamp(sv / this.path.step, 0, N - 1.001), i = Math.floor(f), t = f - i;
    return out.set(
      sm[i * 3] + (sm[i * 3 + 3] - sm[i * 3]) * t,
      sm[i * 3 + 1] + (sm[i * 3 + 4] - sm[i * 3 + 1]) * t,
      sm[i * 3 + 2] + (sm[i * 3 + 5] - sm[i * 3 + 2]) * t,
    );
  }

  /** Fly the shot for road position `s`, looking down the road in direction `d` (+1 downhill, -1 up). `snap`: no easing.
   *  `subject`: a point to keep dead centre (the camera still flies the usual path, it just looks straight at it). */
  aim(s, d, dt, snap = false, subject = null) {
    const { path, heightAt, camera, cam, look } = this, goal = this._goal, lookGoal = this._lookGoal;
    const a = this._a, b = this._b, dir = this._dir, side = this._side;
    const p = shot(s);
    p.ahead *= this.lookAhead;
    // look at the middle of the road ahead: the average of it from here to `ahead`, so the camera follows its bends
    // without swinging round to stare at the far side of a hairpin (one point on the road can be behind you there)
    lookGoal.set(0, 0, 0);
    for (let k = 1; k <= LOOK_SAMPLES; k++) {
      path.sample(THREE.MathUtils.clamp(s + d * p.ahead * (k / LOOK_SAMPLES), 0, path.length), 0, this.road);
      lookGoal.add(this.road.pos);
    }
    lookGoal.divideScalar(LOOK_SAMPLES);
    if (subject) lookGoal.copy(subject);
    this._lineAt(THREE.MathUtils.clamp(s - d * p.back, 0, path.length), a);
    this._lineAt(THREE.MathUtils.clamp(s + d * 30, 0, path.length), b);
    dir.subVectors(b, a).setY(0).normalize();
    side.set(-dir.z, 0, dir.x);
    goal.copy(a).addScaledVector(side, p.side);
    goal.y = a.y + p.height;

    // keep the view clear: the camera must be above the ground under it and above every ridge between it and the
    // look point (line of sight), with a little air
    let minY = heightAt(goal.x, goal.z) + 14;
    for (let f = 0.1; f < 0.9; f += 0.1) {
      const gx = goal.x + (lookGoal.x - goal.x) * f, gz = goal.z + (lookGoal.z - goal.z) * f;
      minY = Math.max(minY, (heightAt(gx, gz) + 6 - f * lookGoal.y) / (1 - f));
    }
    // rise quickly when a ridge needs it, sink back slowly
    const want = Math.max(goal.y, minY);
    this.ground = this.first ? want : this.ground + (want - this.ground) * Math.min(1, dt * (want > this.ground ? 3 : 0.6));
    goal.y = this.ground;

    if (this.first || snap) cam.copy(goal);
    else cam.lerp(goal, Math.min(1, dt * 1.6));

    // Turn to face the road ahead, like a gimbal. In a hairpin the road folds back under the drone, and the heading
    // to a point beneath you swings wildly (it once hit 860°/s), so the steeper it's looking down, the more slowly
    // the heading follows: tilt keeps the road in frame and the heading catches up once it's out in front again.
    const dx = lookGoal.x - cam.x, dy = lookGoal.y - cam.y, dz = lookGoal.z - cam.z, hd = Math.hypot(dx, dz);
    const yawGoal = Math.atan2(dx, dz), pitchGoal = Math.atan2(dy, hd);
    const outFront = THREE.MathUtils.smoothstep(hd / Math.max(-dy, 1), 0.35, 1.3); // 0 = right below, 1 = well ahead
    if (this.first || snap || subject) { this.yaw = yawGoal; this.pitch = pitchGoal; this.first = false; }
    else {
      let dYaw = yawGoal - this.yaw;
      dYaw -= Math.round(dYaw / (2 * Math.PI)) * 2 * Math.PI; // the short way round
      const ease = Math.min(1, dt * 2.2);
      const yawEase = Math.min(1, dt * 2.2 * (0.08 + 0.92 * outFront));
      this.yaw += THREE.MathUtils.clamp(dYaw * yawEase, -Drone.maxYaw * dt, Drone.maxYaw * dt);
      this.pitch += THREE.MathUtils.clamp((pitchGoal - this.pitch) * ease, -MAX_PITCH * dt, MAX_PITCH * dt);
    }
    const cp = Math.cos(this.pitch);
    look.set(cam.x + Math.sin(this.yaw) * cp * 100, cam.y + Math.sin(this.pitch) * 100, cam.z + Math.cos(this.yaw) * cp * 100);
    camera.position.copy(cam);
    camera.lookAt(look);
  }
}
