// Weather: clear, wet (it rained earlier), rain, fog, wet + fog. ?weather=<kind> or the options menu picks one.
//   wet:  darker, glossy road (headlights and sun catch it), tail lights streak in it (taillights.js), tire spray
//   rain: wet + falling rain around the camera, a greyer sky, a bit more haze
//   fog:  thick fog in a lighter grey, so the mountain fades out instead of going black
import * as THREE from 'three';
import { Smoke } from '../course/effects.js';

export const WEATHER = {
  clear: { label: '' },
  wet: { label: 'WET', wet: true },
  rain: { label: 'RAIN', wet: true, rain: true },
  fog: { label: 'FOG', fog: true },
  wetfog: { label: 'WET · FOG', wet: true, fog: true },
};

/** Which weather: ?weather=<kind> if valid, else `fallback`, else clear. */
export function pickWeather(params, fallback) {
  const q = params.get('weather');
  return WEATHER[q] ? q : WEATHER[fallback] ? fallback : 'clear';
}

/** Re-dress a world for the weather. Returns { kind, wet, rain, fog, label, line, update(dt, camera), spray(rig, v, dt) }. */
export function applyWeather({ scene, renderer, road, day, kind = 'clear' }) {
  const w = { kind, ...WEATHER[kind], beams: [] };
  const lights = [];
  scene.traverse((o) => { if (o.isLight) lights.push(o); });

  // sky and haze
  let sky = null, density = scene.fog.density, dim = 1;
  if (w.fog) { sky = day ? 0xb4bcc5 : 0x151a24; density = day ? 0.0065 : 0.012; dim = day ? 0.75 : 1.1; }
  else if (w.rain) { sky = day ? 0x8995a2 : 0x0a0e16; density = day ? 0.003 : 0.0062; dim = day ? 0.62 : 0.9; }
  else if (w.wet) { sky = day ? 0xa9bccd : null; dim = day ? 0.85 : 1; }
  if (sky !== null) { scene.background = new THREE.Color(sky); scene.fog.color.set(sky); }
  scene.fog.density = density;
  for (const l of lights) l.intensity *= dim;

  // the road: dark and glossy, so lights catch in it
  if (w.wet && road?.material) {
    const mats = [road.material];
    road.traverse((o) => { if (o.userData.asphalt) mats.push(o.material); }); // the side roads too
    for (const m of mats) {
      m.roughness = 0.3;
      m.metalness = 0.12;
      m.color.setScalar(0.62);
      m.needsUpdate = true;
    }
  }

  // rain: streaks in a box that follows the camera
  let rain = null;
  if (w.rain) {
    const N = 2600, H = 34, TOP = 22, BOT = -8;
    const fall = new THREE.Vector3(1.4, -12.5, 0.6), streak = fall.clone().multiplyScalar(0.045);
    const drops = new Float32Array(N * 3), pos = new Float32Array(N * 6), col = new Float32Array(N * 8); // RGBA: drops in a beam are brighter and more opaque
    const base = new THREE.Color(day ? 0xb8c2ce : 0x3f4a5c), lit = new THREE.Color(0xfff2d8), alpha0 = day ? 0.22 : 0.1; // dim, so drops in a beam pop
    for (let i = 0; i < N; i++) drops.set([(Math.random() * 2 - 1) * H, BOT + Math.random() * (TOP - BOT), (Math.random() * 2 - 1) * H], i * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, fog: true,
    }));
    lines.frustumCulled = false;
    scene.add(lines);
    const wrap = (v, c, h) => c + ((((v - c + h) % (2 * h)) + 2 * h) % (2 * h)) - h;
    rain = (dt, cam) => {
      const c = cam.position;
      // headlight beams that are on: rain falling through them sparkles
      const beams = [];
      for (const b of w.beams) if (b.level > 0.005) for (const l of b.world()) beams.push({ p: l.wpos, d: l.wdir, len: b.length, cos: b.cosAngle, k: Math.min(1, b.level * 9) });
      for (let i = 0; i < N; i++) {
        const k = i * 3;
        let x = drops[k] + fall.x * dt, y = drops[k + 1] + fall.y * dt, z = drops[k + 2] + fall.z * dt;
        x = wrap(x, c.x, H); z = wrap(z, c.z, H);
        y = wrap(y, c.y + (TOP + BOT) / 2, (TOP - BOT) / 2); // modular, so warps and the first frame just work
        drops[k] = x; drops[k + 1] = y; drops[k + 2] = z;
        pos.set([x, y, z, x - streak.x, y - streak.y, z - streak.z], i * 6);
        let glow = 0;
        for (const b of beams) {
          const vx = x - b.p.x, vy = y - b.p.y, vz = z - b.p.z;
          const along = vx * b.d.x + vy * b.d.y + vz * b.d.z;
          if (along <= 0 || along > b.len) continue;
          const cos = along / Math.sqrt(vx * vx + vy * vy + vz * vz);
          if (cos > b.cos) glow = Math.max(glow, (1 - along / b.len) ** 1.3 * b.k * Math.min(1, (cos - b.cos) * 40));
        }
        const r = base.r + (lit.r - base.r) * glow, g = base.g + (lit.g - base.g) * glow, bl = base.b + (lit.b - base.b) * glow;
        const a = alpha0 + (0.95 - alpha0) * glow;
        col.set([r, g, bl, a, r, g, bl, a * 0.5], i * 8); // the streak's tail is fainter
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    };
  }

  // spray off the tires on a wet road
  const spray = w.wet ? new Smoke(scene, {
    max: 500, color: day ? 0xd9dee4 : 0x6f7786, size0: [0.35, 0.75], grow: 2.4, life: [0.45, 0.9], lift: [0.2, 0.9],
    spread: 1.6, alpha: day ? 0.2 : 0.16, drag: 2.6, inherit: 0.35, jitter: 0.35, rise: 0.12,
  }) : null;

  w.spray = (rig, v, dt) => {
    if (!spray || dt <= 0) return;
    const speed = Math.abs(v);
    if (speed < 7) return;
    const k = Math.min(1, (speed - 7) / 28);
    for (const p of rig.rearContacts()) for (let e = 0; e < Math.ceil(dt * 50 * k); e++) spray.emit(p, rig.vel, k);
  };
  /** headlight beams (beams.js) for rain to sparkle in */
  w.addBeams = (b) => { if (b) w.beams.push(b); };
  w.update = (dt, camera) => {
    rain?.(dt, camera);
    spray?.update(dt, camera, renderer, scene.fog);
  };
  return w;
}
