// A drivable-looking car: poses the GLB on the road (or anywhere), animates wheels and pop-ups,
// and emits tire smoke / skid marks. Knows nothing about rules; the caller decides where it goes.
import * as THREE from 'three';
import { TailLights } from './taillights.js';
import { Beams } from './beams.js';

const UP = new THREE.Vector3(0, 1, 0);
const BRAKE_DECEL = 2.5; // m/s²

// Headlamps, found on any car GLB: whitish materials that glow or are named like a light, in the front of the car.
// (Orange indicators and red tail lamps are too colourful; some models put front and rear lamps in one material.)
const LAMP_NAME = /light|lighst|luz|lamp|emission/i;
function isHeadlampMaterial(m) {
  const em = m.emissive && Math.max(m.emissive.r, m.emissive.g, m.emissive.b) > 0.3;
  if (!em && !LAMP_NAME.test(m.name || '')) return false;
  const c = em ? m.emissive : m.color;
  const hi = Math.max(c.r, c.g, c.b);
  return hi > 0.5 && hi - Math.min(c.r, c.g, c.b) < 0.45;
}

/** Each headlamp's face, in the car's own space: [{ pos, r }] left then right, or null if the model has none we can
 *  find. Pop-up lamps are measured raised. */
function findHeadlamps(root, spec) {
  const popups = root.getObjectByName('popups'), keep = popups?.rotation.x;
  if (popups) popups.rotation.x = 0;
  root.updateMatrixWorld(true);
  const toCar = new THREE.Matrix4().copy(root.matrixWorld).invert(), m = new THREE.Matrix4(), v = new THREE.Vector3();
  const box = [new THREE.Box3(), new THREE.Box3()]; // left, right
  const front = -spec.length * 0.3;
  root.traverse((o) => {
    if (!o.isMesh || !isHeadlampMaterial(o.material)) return;
    m.multiplyMatrices(toCar, o.matrixWorld);
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      if (v.z < front && Math.abs(v.x) > 0.15) box[v.x < 0 ? 0 : 1].expandByPoint(v);
    }
  });
  if (popups) { popups.rotation.x = keep; root.updateMatrixWorld(true); }
  if (box.some((b) => b.isEmpty())) return null;
  return box.map((b) => ({
    pos: new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z - 0.02),
    r: THREE.MathUtils.clamp(Math.min(b.max.x - b.min.x, b.max.y - b.min.y) / 2, 0.04, 0.12),
  }));
}

/** A sky for the windows to reflect (there's no environment map in the scene): an equirectangular gradient, dark
 *  overhead, a pale band at the horizon (the bright streak that slides over the glass as the car turns), dark ground.
 *  One shared texture for day and one for night. */
const _sky = {};
function skyReflection(day) {
  const key = day ? 'day' : 'night';
  if (_sky[key]) return _sky[key];
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d'), grad = g.createLinearGradient(0, 0, 0, 128);
  const stops = day
    ? [[0, '#5d7896'], [0.42, '#a9bccd'], [0.5, '#e8eef2'], [0.53, '#4a4c4e'], [1, '#1c1d1e']]
    : [[0, '#05070c'], [0.4, '#141c2a'], [0.49, '#4a5a70'], [0.52, '#0a0b0d'], [1, '#030303']];
  for (const [t, col] of stops) grad.addColorStop(t, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return (_sky[key] = tex);
}

export class CarRig {
  // `shadow`: the headlights can cast shadows (trees, rails, buildings, other cars); switch with setShadow(). Each lamp
  // casts its own (two shadow passes), so the light on the road really comes from the two headlights.
  // `ground(x, z)`: road height there or null (wet-road reflections land on the road, not under a flying car).
  constructor(id, gltf, spec, { headlights = true, scene = null, day = false, wet = false, beams = 0, shadow = false, ground = null } = {}) {
    this.id = id;
    this.spec = spec;
    this.root = gltf.scene;
    this.root.matrixAutoUpdate = false;
    this.wheels = ['FL', 'FR', 'RL', 'RR'].map((k) => this.root.getObjectByName(`wheel_${k}`));
    this.wheels.forEach((w) => (w.rotation.order = 'YXZ')); // steer first, then roll
    this.brakes = ['FL', 'FR'].map((k) => this.root.getObjectByName(`brake_${k}`)).filter(Boolean); // steer, don't roll
    // brake discs (a `brake_disc` material, see build_car.py) glow after hard braking: each its own material, front
    // ones hotter (they do most of the braking)
    this.discHeat = 0; // 0 cold .. ~0.95 glowing orange
    this.discs = [];
    this.glass = new Set();
    this.root.updateMatrixWorld(true);
    this.root.traverse((o) => {
      // windows (one shared `glass` material, see build_car.py): dark, glossy, reflecting a sky
      if (o.isMesh && o.material?.name === 'glass') this.glass.add(o.material);
      if (!o.isMesh || o.material?.name !== 'brake_disc') return;
      o.material = o.material.clone();
      this.discs.push({ mat: o.material, k: o.getWorldPosition(new THREE.Vector3()).z < 0 ? 1 : 0.6 });
    });
    this.setSky(day);
    this.popups = this.root.getObjectByName('popups');
    this.popupsUp = true;   // AE86: pop-ups up = headlights on
    this.popupDown = spec.hinge_closed?.popups ?? -1.52; // rad, folded flush with the hood (0 = raised)
    this.lightsOn = true;   // cars without pop-ups
    this.spots = [];
    this.lightPower = 900;
    const found = findHeadlamps(this.root, spec);
    const lamps = [-1, 1].map((side, k) => {
      const pos = found?.[k].pos ?? new THREE.Vector3(side * 0.55, 0.7, -spec.length / 2 + 0.1); // a guess, if none found
      return { pos, r: found?.[k].r ?? 0.08, target: new THREE.Vector3(pos.x, 0, pos.z - 16) }; // straight ahead, dipped: pools start near the car
    });
    this.shadowSpots = [];
    if (headlights) {
      for (const lamp of lamps) {
        const spot = new THREE.SpotLight(0xfff2d6, 900, 140, 0.34, 0.5, 1.6);
        spot.position.copy(lamp.pos);
        spot.target.position.copy(lamp.target);
        if (shadow) {
          spot.shadow.mapSize.set(1024, 1024);
          spot.shadow.camera.near = 0.3;
          spot.shadow.camera.far = 140;
          spot.shadow.bias = -0.0004;
          spot.shadow.normalBias = 0.04;
          this.shadowSpots.push(spot);
        }
        this.root.add(spot, spot.target);
        this.spots.push(spot);
      }
    }
    this.tail = scene ? new TailLights(this.root, scene, { day, wet, ground }) : null; // before anything else is added to the car
    // visible beams in the air (fog, rain): see beams.js. `beams` is how thick the air is.
    this.scene = scene;
    this.beams = headlights && beams > 0 ? new Beams(this.root, lamps, { strength: beams }) : null;
    this.braking = false;              // brake pedal, set by whoever drives it (the player's input)
    this._v = null; this._decel = 0; this._brakeHold = 0; // ...and the lights also come on whenever it slows hard
    this.o = {};                       // last road sample (pos, forward, right, curvature)
    this.pos = new THREE.Vector3();
    this.fwd = new THREE.Vector3(0, 0, -1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.prev = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._tmp = new THREE.Vector3();
  }

  /** What the windows reflect: a day or a night sky. */
  setSky(day) {
    for (const m of this.glass) { m.envMap = skyReflection(day); m.envMapIntensity = day ? 1 : 0.8; }
  }

  /** Brake discs from cold (nothing) through dull red to orange-yellow, by discHeat. */
  glowDiscs() {
    for (const d of this.discs) {
      const g = THREE.MathUtils.smoothstep(this.discHeat * d.k, 0.3, 0.95);
      // (kept under 1 per channel: the renderer clips there, and a clipped orange is flat yellow)
      d.mat.emissive.setRGB(0.9 * g, 0.04 * g + 0.3 * g ** 3, 0.03 * g ** 3);
      d.mat.emissiveIntensity = 1;
    }
  }

  /** Headlight shadows on or off (needs the `shadow` option). */
  setShadow(on) {
    for (const spot of this.shadowSpots) spot.castShadow = on;
  }

  /** The body casts (and receives) shadows; the see-through bits stuck to it (beam cones, glows) don't, or a beam
   *  cone would block its own headlight and throw a cone-shaped moon shadow. Solid parts cast from both faces: three
   *  casts from back faces only, and a body shell that isn't closed underneath (the RX-7) throws just slivers. */
  castShadows() {
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      const solid = !o.material?.transparent && !o.material?.isShaderMaterial;
      o.castShadow = o.receiveShadow = solid;
      if (solid) o.material.shadowSide = THREE.DoubleSide;
    });
  }

  /** Pose on the road at distance s, `lateral` m right of centre, body yawed `angle` rad (+ = nose right).
   *  `roll` (rad, + = right side down) and `lift` (m) are extras on top, e.g. for grinding a guardrail. */
  poseOnRoad(path, s, lateral, angle = 0, lateralDemand = 0, { roll = 0, lift = 0 } = {}) {
    path.sample(s, lateral, this.o);
    const fwd = this._tmp.copy(this.o.forward).applyQuaternion(this._q.setFromAxisAngle(UP, -angle));
    const pos = lift ? this.o.pos.clone().addScaledVector(UP, lift) : this.o.pos;
    this.poseBasis(pos, fwd, roll - THREE.MathUtils.clamp(lateralDemand / 300, -0.07, 0.07));
  }

  /** Pose anywhere: position, nose direction, roll about the nose (rad). */
  poseBasis(pos, fwd, roll = 0) {
    const f = this.fwd.copy(fwd).normalize();
    const right = this.right.crossVectors(f, UP).normalize();
    if (roll) right.applyQuaternion(this._q.setFromAxisAngle(f, roll));
    const up = new THREE.Vector3().crossVectors(right, f);
    const back = f.clone().negate();
    this.root.matrix.makeBasis(right, up, back).setPosition(pos);
    this.root.matrixWorldNeedsUpdate = true;
    this.pos.copy(pos);
  }

  /** Wheels roll with speed v; fronts counter-steer into the slide; rears spin up when sideways. */
  animate(dt, v, angle = 0, curvature = 0) {
    const roll = (v * dt) / this.spec.wheel_radius;
    const steer = THREE.MathUtils.clamp(angle * 0.9 - Math.atan(this.spec.wheelbase * curvature), -0.7, 0.7);
    this.wheels.forEach((w, k) => {
      w.rotation.x -= k < 2 ? roll : roll * (1 + Math.abs(angle) * 1.5);
      if (k < 2) w.rotation.y = steer;
    });
    for (const b of this.brakes) b.rotation.y = steer;
    if (this.popups) this.popups.rotation.x += ((this.popupsUp ? 0 : this.popupDown) - this.popups.rotation.x) * Math.min(1, dt * 8);
    // beams follow the pop-ups: folding them down really does turn the lights off
    const open = this.popups ? THREE.MathUtils.clamp(1 - this.popups.rotation.x / this.popupDown, 0, 1) : this.lightsOn ? 1 : 0;
    for (const spot of this.spots) spot.intensity = this.lightPower * (spot.userData.power || 1) * open * open;
    if (this.beams) { this.beams.set(this.lightPower > 0 ? open : 0); this.beams.update(this.scene?.fog); }
    // brake lights: pedal, or decelerating harder than BRAKE_DECEL (the rivals and the 86's own speed plan slow for
    // corners). Held a moment so they don't flicker.
    if (dt > 0) {
      const speed = Math.abs(v); // reversing faster isn't braking
      if (this._v !== null) this._decel += ((this._v - speed) / dt - this._decel) * (1 - Math.exp(-dt * 8));
      this._v = speed;
      this._brakeHold = this._decel > BRAKE_DECEL ? 0.3 : this._brakeHold - dt;
      // heat ~ braking power (deceleration past 7 m/s², × speed), bleeding away in a second or two: tuned on the
      // rivals' speed plans, so the discs flash dull red into the hard corners and only the biggest stops get orange
      this.discHeat = Math.min(1.2, this.discHeat * Math.exp(-dt / 1.5) + Math.max(0, this._decel - 7) * speed * dt / 400);
    }
    if (this.discs.length) this.glowDiscs();
    // tail lights follow the light switch (instantly: the pop-ups take a moment, the switch doesn't)
    this.tail?.update(dt, this.braking || this._brakeHold > 0, this.popups ? this.popupsUp : this.lightsOn);
  }

  trackVelocity(dt) {
    if (dt > 0) this.vel.copy(this.pos).sub(this.prev).divideScalar(dt);
    this.prev.copy(this.pos);
  }

  /** Call after a teleport so effects don't see a huge velocity spike. */
  resetVelocity(skids) {
    this.prev.copy(this.pos);
    this.vel.set(0, 0, 0);
    this._v = null; this._decel = 0;
    this.tail?.reset();
    if (skids) for (const k of [2, 3]) skids.lift(this.id + k);
  }

  /** Rear tire contact patches in world space. */
  rearContacts() {
    return [2, 3].map((k) => {
      const wp = this.wheels[k].position;
      return new THREE.Vector3(wp.x, 0, wp.z).applyMatrix4(this.root.matrix);
    });
  }

  tireFx(dt, v, angle, smoke, skids) {
    const sliding = Math.abs(angle) > 0.22 && Math.abs(v) > 8;
    const contacts = this.rearContacts();
    contacts.forEach((p, i) => {
      const id = this.id + (i + 2);
      if (!sliding) return skids.lift(id);
      skids.add(id, p);
      const strength = Math.min(1, (Math.abs(angle) - 0.22) * 2.2);
      for (let e = 0; e < Math.ceil(dt * 90 * strength); e++) smoke.emit(p, this.vel, strength);
    });
    return sliding;
  }
}
