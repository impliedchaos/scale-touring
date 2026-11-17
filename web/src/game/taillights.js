// Tail lights that read at night: a hotter lamp colour, a glow sprite on each light (fake bloom), and (with ?trails)
// short light trails that hang behind the car for a moment (long-exposure style), brightest under braking.
// Works on any car GLB: tail lamps are found as red, emissive-or-"light"-named materials that sit at the rear.
import * as THREE from 'three';

const TRAIL_TIME = 0.22;   // seconds of history in a trail...
const TRAIL_LEN = 4.5;     // ...but never longer than this (m): any more and it reaches the chase camera
const TRAIL_WIDTH = 0.085; // half-width (m) at the car end
const MAX_PTS = 64;
// Light trails are opt-in: ?trails (or ?trails=1) turns them on, anywhere a car has tail lights.
const TRAILS_PARAM = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('trails') : null;
const TRAILS_DEFAULT = TRAILS_PARAM !== null && TRAILS_PARAM !== '0';

let glowTexture = null;
function glowTex() {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,190,170,1)');
  grd.addColorStop(0.18, 'rgba(255,60,40,.85)');
  grd.addColorStop(0.5, 'rgba(200,10,10,.25)');
  grd.addColorStop(1, 'rgba(120,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  glowTexture = new THREE.CanvasTexture(c);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

const isTailMaterial = (m) => {
  const em = m.emissive && Math.max(m.emissive.r, m.emissive.g, m.emissive.b) > 0.05;
  if (!em && !/light|luz|lighst/i.test(m.name || '')) return false;
  const hsl = (em ? m.emissive : m.color).getHSL({});
  return hsl.s > 0.6 && (hsl.h < 0.05 || hsl.h > 0.95);
};

/**
 * Trails are rebuilt for the camera in the *scene's* onBeforeRender. Not the mesh's: three.js uploads a mesh's
 * buffers before calling its onBeforeRender, so edits made there show up a frame late (the trail lags the car).
 */
function sceneHooks(scene) {
  if (!scene.userData.trailHooks) {
    const hooks = new Set(), before = scene.onBeforeRender;
    scene.onBeforeRender = function (renderer, sc, camera, target) {
      before.call(this, renderer, sc, camera, target);
      for (const t of hooks) t.build(camera);
    };
    scene.userData.trailHooks = hooks;
  }
  return scene.userData.trailHooks;
}

/** A ribbon through recent positions of one light, rebuilt facing the camera just before it's drawn. */
class Trail {
  /** head(): the lamp's world position right now; the ribbon always starts there, glued to the car */
  constructor(scene, head) {
    this.head = head;
    this.pts = [];   // {p: Vector3, t}
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX_PTS * 2 * 3);
    this.col = new Float32Array(MAX_PTS * 2 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < MAX_PTS - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.hooks = sceneHooks(scene);
    this.hooks.add(this);
    this.level = 0;
    this.now = 0;
    scene.add(this.mesh);
  }

  push(p, now, level) {
    this.now = now; this.level = level;
    const last = this.pts[this.pts.length - 1];
    if (!last || last.p.distanceToSquared(p) > 0.0025) this.pts.push({ p: p.clone(), t: now });
    else last.t = now;
    while (this.pts.length > MAX_PTS || (this.pts.length && now - this.pts[0].t > TRAIL_TIME)) this.pts.shift();
    // trim to TRAIL_LEN metres, measured back from the car
    let len = 0;
    for (let i = this.pts.length - 1; i > 0; i--) {
      len += this.pts[i].p.distanceTo(this.pts[i - 1].p);
      if (len > TRAIL_LEN) { this.pts.splice(0, i - 1); break; }
    }
  }

  clear() { this.pts.length = 0; }

  build(camera) {
    const geo = this.mesh.geometry;
    if (!this.pts.length || this.level <= 0) { geo.setDrawRange(0, 0); this.mesh.visible = false; return; }
    // replace the newest sample with where the lamp is as it's drawn, so nothing can open a gap at the car
    const now = this.head();
    const last = this.pts[this.pts.length - 1];
    if (last.p.distanceToSquared(now) > 1e-6) {
      if (this.pts.length > 1 && last.t === this.now) last.p.copy(now); else this.pts.push({ p: now.clone(), t: this.now });
    }
    while (this.pts.length > MAX_PTS) this.pts.shift();
    const n = this.pts.length;
    if (n < 2) { geo.setDrawRange(0, 0); this.mesh.visible = false; return; }
    const side = new THREE.Vector3(), dir = new THREE.Vector3(), view = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const p = this.pts[i].p, q = this.pts[Math.min(i + 1, n - 1)].p, o = this.pts[Math.max(i - 1, 0)].p;
      dir.subVectors(q, o).normalize();
      view.subVectors(camera.position, p).normalize();
      side.crossVectors(dir, view);
      // a trail seen end-on (straight behind the car) would be a dot, not a stripe down the road: fade it by how
      // side-on we see it, so drifts and fly-pasts streak and the chase view stays clean
      // fade by position along the trail (0 = car end, 1 = oldest), so short and long trails look alike
      const age = 1 - i / (n - 1);
      // ...but never near the car: the first stretch always shows, so the trail stays attached
      const endOn = THREE.MathUtils.smoothstep(side.length(), 0.2, 0.75) * 0.9 + 0.1;
      const sideOn = THREE.MathUtils.lerp(1, endOn, THREE.MathUtils.smoothstep(age, 0.04, 0.3));
      side.normalize();
      const fade = (1 - age) ** 2 * this.level * sideOn, w = TRAIL_WIDTH * (0.3 + 0.7 * (1 - age));
      this.pos.set([p.x + side.x * w, p.y + side.y * w, p.z + side.z * w, p.x - side.x * w, p.y - side.y * w, p.z - side.z * w], i * 6);
      const r = 0.7 * fade, g = 0.05 * fade, b = 0.04 * fade;
      this.col.set([r, g, b, r, g, b], i * 6);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.setDrawRange(0, (n - 1) * 6);
    this.mesh.visible = true;
  }

  dispose() { this.hooks.delete(this); this.mesh.parent?.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

let streakTexture = null;
const PEAK = 0.25; // where along the streak the reflection is brightest (Reflection puts the mirror image there)
function streakTex() {
  if (streakTexture) return streakTexture;
  const c = document.createElement('canvas'); c.width = 32; c.height = 128;
  const g = c.getContext('2d');
  for (let y = 0; y < 128; y++) {
    const t = y / 127; // 0 = the far end (under the lamp), 1 = toward the viewer
    const a = t < PEAK ? (t / PEAK) ** 0.7 : ((1 - t) / (1 - PEAK)) ** 1.1; // brightest at the mirror image
    const row = g.createLinearGradient(0, 0, 32, 0);
    row.addColorStop(0, 'rgba(255,40,30,0)'); row.addColorStop(0.5, `rgba(255,60,45,${a})`); row.addColorStop(1, 'rgba(255,40,30,0)');
    g.fillStyle = row; g.fillRect(0, 127 - y, 32, 1);
  }
  streakTexture = new THREE.CanvasTexture(c);
  streakTexture.colorSpace = THREE.SRGBColorSpace;
  return streakTexture;
}

/**
 * On a wet road a light is reflected where the line from the eye to its mirror image (as far below the road as the
 * light is above it) meets the road: on the line from the camera to the spot under the light, a fraction
 * h_light / (h_light + h_camera) of the way. So a low camera sees it far back towards itself, a high one right under
 * the car. Water smears it along that line into a streak: a flat quad on the road, swung to face the camera.
 * `ground(x, z)`: the road's height there, or null (no road: no reflection). Without it, the road is under the car.
 */
class Reflection {
  constructor(scene, root, c, ground) {
    this.root = root; this.c = c; this.ground = ground; this.opacity = 0;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({
      map: streakTex(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.hooks = sceneHooks(scene);
    this.hooks.add(this);
    this._L = new THREE.Vector3(); this._G = new THREE.Vector3(); this._up = new THREE.Vector3(0, 1, 0);
    this._d = new THREE.Vector3(); this._x = new THREE.Vector3(); this._a = new THREE.Vector3();
    this._b = new THREE.Vector3(); this._n = new THREE.Vector3();
  }

  build(camera) {
    this.mesh.visible = this.opacity > 0.01;
    if (!this.mesh.visible) return;
    const L = this._L.copy(this.c).applyMatrix4(this.root.matrix);         // the lamp, in the world
    const up = this._up, G = this._G;                                      // the road straight below it
    if (this.ground) {
      const y = this.ground(L.x, L.z);
      if (y === null) { this.mesh.visible = false; return; }               // nothing wet underneath
      G.set(L.x, y + 0.03, L.z);
    } else G.set(L.x, L.y - this.c.y + 0.03, L.z);                         // the car sits on the road
    const hl = L.y - G.y, hc = camera.position.y - G.y;
    if (hl <= 0 || hc <= 0.05) { this.mesh.visible = false; return; }
    const d = this._d.set(camera.position.x - G.x, 0, camera.position.z - G.z); // towards the camera, along the road
    const dist = d.length();
    if (dist < 0.3) { this.mesh.visible = false; return; }
    d.divideScalar(dist);
    const r = dist * hl / (hl + hc);                                       // how far out the mirror image lands
    // water smears it along the line of sight, back to the lamp and on towards the eye
    // from just behind the lamp's foot, sized so the brightest point lands on the mirror image
    const start = 0.1, len = THREE.MathUtils.clamp((r - start) / PEAK, 1.6, 18);
    // lay it along the road, which climbs or falls towards the camera (on a descent it rises behind the car)
    const a = this._a.copy(G).addScaledVector(d, start), b = this._b.copy(G).addScaledVector(d, start + len);
    const ya = this.ground?.(a.x, a.z), yb = this.ground?.(b.x, b.z);
    if (ya != null) a.y = ya + 0.03;
    b.y = yb != null ? yb + 0.03 : a.y + (a.y - G.y) * (len / Math.max(start, 0.01)); // off the road: carry the slope on
    const along = this._d.subVectors(b, a);
    const x = this._x.crossVectors(up, along).normalize().multiplyScalar(0.38);
    const n = this._n.crossVectors(along, x).normalize(); // up out of the road (x × along points into it)
    this.mesh.matrix.makeBasis(x, along, n).setPosition(a);
    // a light high above the road throws a dimmer reflection
    this.mesh.material.opacity = Math.min(1, this.opacity * 1.5 * THREE.MathUtils.clamp(1.6 / (hl + 0.8), 0.15, 1));
  }

  dispose() { this.hooks.delete(this); this.mesh.parent?.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

export class TailLights {
  /** root: the car's root (its .matrix is its world pose). scene: where the trails live (world space). */
  /** `ground(x, z)`: road height there or null, for the wet-road reflections (see Reflection). */
  constructor(root, scene, { day = false, trails = TRAILS_DEFAULT, wet = false, ground = null } = {}) {
    this.root = root;
    this.day = day;
    this.braking = false;
    this.mats = [];
    this.time = 0;
    this._w = new THREE.Vector3();
    const left = [], right = [];
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), v = new THREE.Vector3();
    let zMax = -Infinity, zMin = Infinity;
    // the car's own extent along its length: only the model's meshes (not beams or other add-ons), in the car's space
    const isBody = (o) => o.isMesh && !o.material?.isShaderMaterial && !o.isSprite;
    const box = new THREE.Box3(), rel = new THREE.Matrix4();
    root.traverse((o) => {
      if (!isBody(o)) return;
      o.geometry.computeBoundingBox();
      box.copy(o.geometry.boundingBox).applyMatrix4(rel.multiplyMatrices(inv, o.matrixWorld));
      zMax = Math.max(zMax, box.max.z); zMin = Math.min(zMin, box.min.z);
    });
    const rearZ = zMin + (zMax - zMin) * 0.8;
    root.traverse((o) => {
      if (!isBody(o)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.length !== 1 || !isTailMaterial(mats[0])) return;
      const pos = o.geometry.attributes.position, m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      const pts = [];
      for (let i = 0; i < pos.count; i++) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(m).clone());
      if (pts.filter((p) => p.z > rearZ).length < pts.length * 0.9) return; // shared with the front (indicators)
      const mat = mats[0].clone();
      o.material = mat;
      mat.userData.base = (Math.max(mats[0].emissive.r, mats[0].emissive.g) > 0.05 ? mats[0].emissive : mats[0].color).clone();
      this.mats.push(mat);
      for (const p of pts) (p.x < 0 ? left : right).push(p);
    });
    const centre = (list) => {
      if (!list.length) return null;
      const c = new THREE.Vector3(); list.forEach((p) => c.add(p)); c.divideScalar(list.length);
      c.z = Math.max(...list.map((p) => p.z)) + 0.03; // on the lens surface
      const w = Math.max(...list.map((p) => p.x)) - Math.min(...list.map((p) => p.x));
      return { c, w };
    };
    this.lights = [centre(left), centre(right)].filter(Boolean);
    this.sprites = this.lights.map(({ c, w }) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: true,
      }));
      s.position.copy(c);
      s.position.z -= 0.04; // centred just inside the lens, so less of it hangs off the bodywork
      s.userData.size = THREE.MathUtils.clamp(w * 0.75, 0.32, 0.6);
      s.renderOrder = 2;
      root.add(s);
      return s;
    });
    this.reflections = wet ? this.lights.map(({ c }) => new Reflection(scene, root, c, ground)) : [];
    this.trails = !trails ? [] : this.lights.map(({ c }) => new Trail(scene, () => this._w.copy(c).applyMatrix4(this.root.matrix)));
    this.set(1);
  }

  /** level: 0 off (lights switched off), 1 running lights, 2 brake lights on */
  set(level) {
    this.level = level;
    if (level === 0) { // unlit lens: just the red plastic
      for (const m of this.mats) { m.emissive.copy(m.userData.base); m.emissiveIntensity = 0; }
      for (const s of this.sprites) s.visible = false;
      for (const r of this.reflections ?? []) r.opacity = 0;
      return;
    }
    const hot = new THREE.Color(1, 0.55, 0.45);
    for (const m of this.mats) {
      // the renderer clips at 1, so "brighter" means a hotter, whiter core rather than more red
      m.emissive.copy(m.userData.base).lerp(hot, this.day ? 0.05 : 0.12 * level);
      m.emissiveIntensity = this.day ? 0.6 + 0.6 * level : 1.2 + 0.9 * level;
    }
    // a faint halo while driving; it blooms when braking
    const brake = THREE.MathUtils.clamp(level - 1, 0, 1);
    const glow = this.day ? 0.12 * brake : 0.3 + 0.6 * brake;
    for (const s of this.sprites) {
      s.material.opacity = glow;
      s.visible = glow > 0.01;
      s.scale.setScalar(s.userData.size * (1 + 0.6 * brake));
    }
    for (const r of this.reflections ?? []) r.opacity = this.day ? 0.12 + 0.18 * brake : 0.4 + 0.45 * brake;
  }

  /** after the car is posed for this frame */
  update(dt, braking = this.braking, lightsOn = true) {
    this.time += dt;
    const level = braking ? 2 : lightsOn ? 1 : 0; // brake lights work with the headlights off; nothing else does
    if (level !== this.level) this.set(level);
    const trailLevel = this.day || !level ? 0 : 0.5 + 0.5 * (level - 1);
    const w = new THREE.Vector3();
    this.trails.forEach((t, i) => t.push(w.copy(this.lights[i].c).applyMatrix4(this.root.matrix), this.time, trailLevel));
  }

  /** after a teleport (warps etc.), so a trail doesn't streak across the mountain */
  reset() { for (const t of this.trails) t.clear(); }

  dispose() { for (const t of [...this.trails, ...this.reflections]) t.dispose(); }
}
