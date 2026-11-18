// The fly-by's camera views (VIEWS in options.js lists them; Space cycles). Each one places the camera every frame.
//   drone     a long lens from the drone's path, the car kept dead centre (the miniature-model look)
//   wide      the same drone path with a wide lens, looking down the road ahead
//   chase     behind and above the car, turning to follow where it is heading, so a drift swings it across the frame
//   hood      fixed to the car just ahead of the windscreen, looking out over the bonnet
//   trackside a camera beside the road ahead that pans with the car as it passes, then cuts to the next spot
// Tilt-shift is only the blur pass (tiltshift.js); it fades itself out by camera height, so low views stay sharp.
import * as THREE from 'three';
import { Drone } from './showcase.js';
import { VIEWS } from './options.js';

const SHOTS = {
  drone: { fov: 30, lookAhead: 0.4 },
  wide: { fov: 60, lookAhead: 1 },
  chase: { fov: 58 },
  hood: { fov: 72 },
  trackside: { fov: 24 },
};
const CHASE_BACK = 8.5, CHASE_UP = 2.7, SPOT_AHEAD = 85, SPOT_SIDE = 7, SPOT_UP = 3, SPOT_DONE = 18;
const SPOT_TRIES = [85, 60, 110, 45];
const UP = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  /** `car`: a BootlegCar, or null (then only the drone views work). */
  constructor({ camera, path, heightAt, car }) {
    Object.assign(this, { camera, path, heightAt, car });
    this.drone = new Drone(path, heightAt, camera);
    this.view = 'drone';
    this.focus = new THREE.Vector3();   // what the sharp shadows centre on
    this.subject = new THREE.Vector3(); // what the tilt-shift keeps in focus
    this.spot = new THREE.Vector3(); this.spotS = null; this.side = 1;
    this.look = new THREE.Vector3(); this.heading = 0; this.fresh = true;
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3(); this._u = new THREE.Vector3(); this._o = {}; this._o2 = {};
  }

  /** Switch to view `id`; one that needs a car falls back to the drone without one. Returns the view in use. */
  set(id) {
    const def = VIEWS.find((v) => v.id === id);
    this.view = !def || (def.car && !this.car) ? 'drone' : id;
    const shot = SHOTS[this.view];
    this.camera.fov = shot.fov;
    this.camera.updateProjectionMatrix();
    this.drone.lookAhead = shot.lookAhead ?? 1;
    // From the bonnet the beam cones sit a few metres from the lens and blow out, so drop them there.
    const rig = this.car?.rig, hood = this.view === 'hood';
    if (rig?.beams) { this.beamStrength ??= rig.beams.strength; rig.beams.strength = hood ? 0 : this.beamStrength; }
    this.reset();
    return this.view;
  }

  /** The next view that works with the current car (or lack of one). */
  next() { const ok = VIEWS.filter((v) => !v.car || this.car), i = ok.findIndex((v) => v.id === this.view); return ok[(i + 1) % ok.length].id; }

  /** Jump straight to the shot on the next update instead of flying there. */
  reset() { this.drone.reset(); this.spotS = null; this.fresh = true; }

  /** Place the camera for road position `s`, travelling in direction `dir` (+1 downhill, -1 up). `dt`: world seconds. */
  update(s, dir, dt, snap = false) {
    const { car, drone, camera } = this;
    if (car) this.subject.copy(car.rig.pos).y += 0.7;
    if (this.view === 'drone' || this.view === 'wide') {
      drone.aim(s, car ? car.camDir() : dir, dt, snap, car && this.view === 'drone' ? this.subject : null);
      this.focus.copy(drone.focus);
      if (!car) this.subject.copy(drone.focus);
    } else {
      this.focus.copy(car.rig.pos);
      this[`_${this.view}`](dt, snap || this.fresh);
    }
    this.fresh = false;
    if (this.view !== 'hood') camera.up.copy(UP);
  }

  _chase(dt, snap) {
    const r = this.car.rig, p = r.pos, v = r.vel, camera = this.camera;
    // heading: where it is going, or the nose when it's slow (or just placed)
    const moving = Math.hypot(v.x, v.z) > 4 && !snap;
    const goal = moving ? Math.atan2(v.x, v.z) : Math.atan2(r.fwd.x, r.fwd.z);
    let d = goal - this.heading;
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
    this.heading = snap ? goal : this.heading + d * Math.min(1, dt * 2.5);
    const hx = Math.sin(this.heading), hz = Math.cos(this.heading);
    camera.position.set(p.x - hx * CHASE_BACK, 0, p.z - hz * CHASE_BACK);
    camera.position.y = Math.max(p.y + CHASE_UP, this.heightAt(camera.position.x, camera.position.z) + 1.5);
    camera.lookAt(p.x + hx * 2, p.y + 1.1, p.z + hz * 2);
  }

  _hood() {
    const car = this.car, spec = car.rig.spec, m = car.rig.root.matrix, camera = this.camera;
    camera.position.set(0, spec.height * 0.85, -spec.length * 0.3).applyMatrix4(m);
    camera.up.set(m.elements[4], m.elements[5], m.elements[6]); // the car's own up, so it rolls with the car
    camera.lookAt(this._v.set(0, spec.height * 0.78, -40).applyMatrix4(m));
  }

  /** Choose the roadside spot ahead of the car: prefer the side where the ground falls away (not a cut slope) and where
   *  nothing stands between the spot and the road the car is about to drive. Alternates sides when both are fine. */
  _pickSpot() {
    const car = this.car, path = this.path, o = this._o, p = this._v, q = this._w;
    let best = null;
    for (const side of [-this.side, this.side]) {
      for (const ahead of SPOT_TRIES) {
        const s = THREE.MathUtils.clamp(car.s + car.dir * ahead, 0, path.length);
        path.sample(s, side * (path.half + SPOT_SIDE), o);
        p.copy(o.pos);
        const ground = this.heightAt(p.x, p.z);
        p.y = Math.max(p.y + SPOT_UP, ground + 2.5);
        let score = -Math.abs(ahead - SPOT_AHEAD) * 0.02;
        score -= Math.max(0, ground - o.pos.y - 1.5) * 2;                       // spot on a cut slope above the road
        for (let k = 1; k <= 6; k++) {                                          // sight line to the road on the car's side of the spot
          const sk = s - car.dir * k * (ahead / 6);
          path.sample(sk, 0, this._o2);
          const t = this._o2.pos;
          q.set(p.x + (t.x - p.x) * 0.9, 0, p.z + (t.z - p.z) * 0.9);
          const line = p.y + ((t.y + 1) - p.y) * 0.9;
          if (this.heightAt(q.x, q.z) > line) score -= 3;
        }
        if (!best || score > best.score) best = { score, side, s, pos: p.clone() };
      }
    }
    this.side = best.side; this.spotS = best.s; this.spot.copy(best.pos);
  }

  _trackside(dt, snap) {
    const car = this.car, camera = this.camera, path = this.path;
    const passed = this.spotS === null ? Infinity : (car.s - this.spotS) * car.dir; // metres the car is beyond the spot
    if (passed > SPOT_DONE || passed < -SPOT_AHEAD * 2.2) {
      this._pickSpot();
      snap = true;
    }
    camera.position.copy(this.spot);
    const target = this.subject;
    if (snap) this.look.copy(target); else this.look.lerp(target, Math.min(1, dt * 10));
    camera.lookAt(this.look);
  }
}
