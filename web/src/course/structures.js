// Structures on the road: bridges (slab, arch, columns) and tunnels (liner, portal frames, and the cut in the terrain).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Concrete under each deck span in `course.bridges` ([[s0, s1], ...] metres of s): a solid slab the width of the road (it
 *  casts the shadow into the valley), an open-spandrel arch under the middle of the span (a pair of ribs springing from the
 *  ground), and columns from the arch, or straight from the ground where the valley is shallow, up to the deck. */
export function buildBridges(path, course, heightAt) {
  const group = new THREE.Group(); group.name = 'bridges';
  const spans = course.bridges || [];
  if (!spans.length) return group;
  const half = path.half, W = half * 2 + 1.8, SLAB = 1.3, RIB = 1.6, COL = 1.4;
  const parts = [], o = {}, up = new THREE.Vector3(0, 1, 0);
  const paint = (g, hex) => { // flat colour with a little variation so the faces read in the tilt-shift
    const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g;
  };
  /** a w x h x len box centred at p, long axis along `fwd`, width along `right` */
  const box = (p, fwd, right, w, h, len, hex) => {
    const g = new THREE.BoxGeometry(w, h, len).toNonIndexed();
    const m = new THREE.Matrix4().makeBasis(right, up, fwd).setPosition(p);
    g.applyMatrix4(m); g.deleteAttribute('uv'); parts.push(paint(g, hex));
  };
  const at = (s, lat = 0) => { path.sample(s, lat, o); return o; };

  for (const [s0, s1] of spans) {
    const L = s1 - s0;
    const deckY = (s) => at(s).pos.y;
    const ground = (s, lat = 0) => { const p = at(s, lat).pos; return heightAt(p.x, p.z); };
    // the slab: short boxes end to end along the (curving) road
    const STEP = 3;
    for (let s = s0; s < s1; s += STEP) {
      const m = Math.min(s + STEP, s1), c = (s + m) / 2, a = at(c), f = a.forward.clone(), r = a.right.clone();
      const p = a.pos.clone(); p.y -= SLAB / 2 + 0.04;
      box(p, f, r, W, SLAB, m - s + 0.3, 0xb9b3a6);
    }
    // the arch, over the middle 60% of the span, springing from the ground at both ends
    const a0 = s0 + L * 0.2, a1 = s1 - L * 0.2, la = a1 - a0;
    const y0 = Math.min(ground(a0, -half), ground(a0, half)) , y1 = Math.min(ground(a1, -half), ground(a1, half));
    const crown = Math.min(deckY(a0 + la / 2) - SLAB - 6, Math.max(y0, y1) + 60);
    const archY = (s) => { const t = (s - a0) / la; return y0 + (y1 - y0) * t + Math.max(0, crown - (y0 + y1) / 2) * 4 * t * (1 - t); };
    const hasArch = crown > Math.max(y0, y1) + 8;
    if (hasArch) {
      for (const lat of [-half * 0.6, half * 0.6]) {
        for (let s = a0; s < a1; s += 2) {
          const m = Math.min(s + 2, a1), pa = at(s, lat).pos.clone(), pb = at(m, lat).pos.clone();
          pa.y = archY(s); pb.y = archY(m);
          const d = pb.clone().sub(pa), len = d.length(), f = d.clone().normalize();
          const r = new THREE.Vector3().crossVectors(f, up).normalize().negate(); // right of travel
          const mid = pa.clone().add(pb).multiplyScalar(0.5);
          const g = new THREE.BoxGeometry(RIB, RIB, len + 0.3).toNonIndexed();
          const basisUp = new THREE.Vector3().crossVectors(r, f).normalize();
          g.applyMatrix4(new THREE.Matrix4().makeBasis(r, basisUp, f).setPosition(mid)); g.deleteAttribute('uv'); parts.push(paint(g, 0xa9a396));
        }
      }
    }
    // columns: every ~14 m, a pair, from the arch (or the valley floor) up to the underside of the slab
    const N = Math.max(2, Math.round(L / 14));
    for (let k = 0; k <= N; k++) {
      const s = s0 + (L * k) / N;
      for (const lat of [-half * 0.6, half * 0.6]) {
        const a = at(s, lat), top = a.pos.y - SLAB;
        const inArch = hasArch && s > a0 && s < a1;
        const base = inArch ? archY(s) : heightAt(a.pos.x, a.pos.z);
        if (top - base < 2.5) continue;
        const f = a.forward.clone(), r = a.right.clone(), p = a.pos.clone(); p.y = (top + base) / 2;
        const wide = inArch ? COL : COL * 1.6; // the end piers are heavier than the spandrel columns
        box(p, f, r, wide, top - base, wide * 1.3, 0xb2ac9f);
      }
    }
  }
  const mesh = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
  mesh.name = 'bridges-mesh';
  group.add(mesh);
  return group;
}

// SQUASH: the arch is an ellipse this much lower than it is wide (a full semicircle over a 9 m road is ~6 m tall and pokes out of thin hills)
const TUN = { WALL: 1.5, EXT: 4, CUT: 14, FORE: 6, FRAME: 1.1, DEPTH: 1.4, SQUASH: 0.7 };

/** Where each tunnel in `course.tunnels` ([[s0, s1], ...] metres of s, the part well inside the hill) opens: one entry per
 *  portal, with the point on the road, the horizontal direction into the hill, the road's rise per metre that way and the arch
 *  radius. The portal sits EXT metres outside the span, at the foot of the ramp the 6 m terrain makes over the road. */
export function tunnelPortals(path, course) {
  const out = [], o = {}, R = path.half + 0.9;
  for (const [a, b] of course.tunnels || []) {
    const s0 = Math.max(a - TUN.EXT, 0), s1 = Math.min(b + TUN.EXT, course.length);
    for (const [s, dir] of [[s0, 1], [s1, -1]]) {
      path.sample(s, 0, o);
      const p = o.pos.clone(), f = o.forward.clone().multiplyScalar(dir);
      path.sample(s + dir * 4, 0, o);
      const hz = Math.hypot(f.x, f.z) || 1;
      out.push({ s, dir, p, fx: f.x / hz, fz: f.z / hz, g: (o.pos.y - p.y) / 4, R });
    }
  }
  return out;
}

/** Patch a terrain material so it discards the surface inside each portal's arch-shaped volume (CUT metres into the hill, and FORE
 *  metres out of it: the ramp starts up to a grid cell before the face, and a triangle there can cut across the opening).
 *  The terrain is a 6 m heightfield, so where it climbs over the road it can only make a ramp across the opening; this opens it. */
export function cutPortals(mat, portals) {
  const n = portals.length;
  const A = portals.map(q => new THREE.Vector4(q.p.x, q.p.y, q.p.z, q.R));
  const B = portals.map(q => new THREE.Vector4(q.fx, q.fz, TUN.CUT, q.g));
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPA = { value: A }; sh.uniforms.uPB = { value: B };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>',
      `#include <common>
varying vec3 vWP;
uniform vec4 uPA[${n}];
uniform vec4 uPB[${n}];`).replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
for (int i = 0; i < ${n}; i++) {
  vec2 d = vWP.xz - uPA[i].xz;
  float al = dot(d, uPB[i].xy), u = dot(d, vec2(-uPB[i].y, uPB[i].x));
  if (al > -${TUN.FORE.toFixed(1)} && al < uPB[i].z) {
    float v = vWP.y - (uPA[i].y + uPB[i].w * al), R = uPA[i].w - 0.05, w = (v - ${TUN.WALL.toFixed(2)}) / ${TUN.SQUASH.toFixed(2)};
    if (v > 0.0 && ((w < 0.0 && abs(u) < R) || u * u + w * w < R * R)) discard;
  }
}`);
  };
  return mat;
}

/** A dark tube and a concrete frame at each portal. */
export function buildTunnels(path, course) {
  const group = new THREE.Group(); group.name = 'tunnels';
  const portals = tunnelPortals(path, course);
  if (!portals.length) return group;
  const R = path.half + 0.9, o = {};
  const profile = (r, low = 0) => {                      // the arch's cross-section as (right, up), left foot round to right foot
    const p = [[-r, low], [-r, TUN.WALL]];
    for (let k = 1; k < 12; k++) { const t = Math.PI * (1 - k / 12); p.push([r * Math.cos(t), TUN.WALL + r * TUN.SQUASH * Math.sin(t)]); }
    p.push([r, TUN.WALL], [r, low]);
    return p;
  };
  const ring = (s, prof) => {
    path.sample(s, 0, o);
    const p = o.pos, r = o.right;
    return prof.map(([u, v]) => new THREE.Vector3(p.x + r.x * u, p.y + v, p.z + r.z * u));
  };
  const liner = [], frame = [];
  const strip = (out, A, B) => { for (let i = 0; i + 1 < A.length; i++) out.push(A[i], B[i], A[i + 1], A[i + 1], B[i], B[i + 1]); };
  const geo = (verts) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts.flatMap(v => [v.x, v.y, v.z]), 3));
    g.computeVertexNormals(); return g;
  };
  const inner = profile(R), outer = profile(R + TUN.FRAME, -1.5), innerLow = profile(R, -1.5);
  for (let k = 0; k < portals.length; k += 2) {          // portals come in pairs: the span's two ends
    const s0 = portals[k].s, s1 = portals[k + 1].s;
    for (let s = s0; s < s1; s += 3) strip(liner, ring(s, inner), ring(Math.min(s + 3, s1), inner));
    for (const { s, dir } of [portals[k], portals[k + 1]]) {
      strip(frame, ring(s, innerLow), ring(s, outer));                      // the face
      strip(frame, ring(s, outer), ring(s + dir * TUN.DEPTH, outer));       // its outer skin, running back into the hill
    }
  }
  group.add(
    Object.assign(new THREE.Mesh(geo(liner), new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 1, side: THREE.DoubleSide })), { name: 'tunnels-liner' }),
    Object.assign(new THREE.Mesh(geo(frame), new THREE.MeshStandardMaterial({ color: 0xb3ad9f, roughness: 0.95, flatShading: true, side: THREE.DoubleSide })), { name: 'tunnels-frame' }));
  return group;
}
