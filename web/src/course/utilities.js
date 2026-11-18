// Overhead utility lines: poles along the roadside, wherever there are buildings to serve, with wires sagging between them.
// Which places get them (and in what style) is `style.lines` in buildings.json, written by tools/build_buildings.py:
//   jp   wooden poles every ~38 m, three power wires on a crossarm, a pair of comms cables below, a transformer now and then
//   rio  concrete poles every ~28 m and far more cables on each, hung loose and criss-crossing: the tangle over a favela street
import * as THREE from 'three';
import { rng } from './track.js';

const LOOK = {
  jp: { gap: 38, jitter: 5, h: 8.8, power: 3, comms: 2, sag: 0.012, pole: 0x4d4236, can: 0x6f747a, tangle: false },
  rio: { gap: 28, jitter: 6, h: 7.6, power: 3, comms: 7, sag: 0.02, pole: 0x8d8a82, can: 0x6f747a, tangle: true },
};
const NEAR = 55, WINDOW = 90; // a pole stands where a building is within NEAR m (along the road); the side is whichever has more within WINDOW

export function buildUtilities(path, heightAt, course) {
  const group = new THREE.Group(); group.name = 'utilities';
  const data = course.buildings, look = LOOK[data?.style?.lines];
  if (!look || !data.buildings?.length) return group;
  const r = rng(77), o = {};
  const inSpan = (spans, s) => (spans || []).some(([a, b]) => s >= a - 12 && s <= b + 12);

  // which side of the road each building is on, binned along the road
  const BIN = 10, nb = Math.ceil(path.length / BIN) + 1;
  const count = { '-1': new Float32Array(nb), 1: new Float32Array(nb) };
  for (const b of data.buildings) {
    let x = 0, z = 0; const n = b.p.length / 2;
    for (let i = 0; i < n; i++) { x += b.p[i * 2]; z += b.p[i * 2 + 1]; }
    path.sample(b.s, 0, o);
    const side = (x / n - o.pos.x) * o.right.x + (z / n - o.pos.z) * o.right.z < 0 ? -1 : 1;
    count[side][Math.min(nb - 1, Math.floor(b.s / BIN))]++;
  }
  const tally = (side, s, w) => {
    let t = 0;
    for (let k = Math.max(0, Math.floor((s - w) / BIN)); k <= Math.min(nb - 1, Math.floor((s + w) / BIN)); k++) t += count[side][k];
    return t;
  };

  // the poles: [{ s, side }], with `chain` marking where one continues from the last
  const poles = [];
  let side = 1;
  for (let s = 20; s < path.length - 20; s += look.gap + (r() - 0.5) * 2 * look.jitter) {
    if (tally(-1, s, NEAR) + tally(1, s, NEAR) < 2 || inSpan(course.tunnels, s) || inSpan(course.bridges, s)) continue;
    const l = tally(-1, s, WINDOW), rr = tally(1, s, WINDOW);
    if (l !== rr) side = l > rr ? -1 : 1;
    poles.push({ s, side });
  }
  if (!poles.length) return group;

  const up = new THREE.Vector3(0, 1, 0);
  const place = (q) => {
    path.sample(q.s, q.side * (path.half + 1.7), o);
    const roadY = o.pos.y, ground = heightAt(o.pos.x, o.pos.z);
    q.pos = o.pos.clone(); q.right = o.right.clone(); q.fwd = o.forward.clone();
    q.foot = Math.min(ground, roadY) - 0.3;
    q.top = Math.max(ground, roadY - 1) + look.h;
  };
  poles.forEach(place);

  // poles and crossarms (instanced), transformers
  const mat = (color) => new THREE.MeshLambertMaterial({ color });
  const poleMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.8, 1, 1, 6), mat(look.pole), poles.length);
  const armMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(look.pole), poles.length);
  const cans = poles.filter((_, i) => i % 4 === 2);
  const canMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8), mat(look.can), Math.max(1, cans.length));
  const m4 = new THREE.Matrix4(), id = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), basis = new THREE.Matrix4(), q4 = new THREE.Quaternion();
  poles.forEach((q, i) => {
    const len = q.top - q.foot;
    poleMesh.setMatrixAt(i, m4.compose(v.set(q.pos.x, q.foot + len / 2, q.pos.z), id, sc.set(0.14, len, 0.14)));
    q4.setFromRotationMatrix(basis.makeBasis(q.right, up, q.fwd));
    armMesh.setMatrixAt(i, m4.compose(v.set(q.pos.x, q.top - 0.45, q.pos.z), q4, sc.set(look.tangle ? 2.2 : 1.9, 0.11, 0.11)));
  });
  cans.forEach((q, i) => {
    const toward = -q.side; // on the road side of the pole
    canMesh.setMatrixAt(i, m4.compose(v.set(q.pos.x + q.right.x * toward * 0.45, q.top - 1.5, q.pos.z + q.right.z * toward * 0.45), id, sc.set(0.22, 0.85, 0.22)));
  });
  canMesh.count = cans.length;
  for (const m of [poleMesh, armMesh, canMesh]) m.instanceMatrix.needsUpdate = true;
  group.add(poleMesh, armMesh, canMesh);

  // wires: each pole has attachment points (power on the crossarm, comms lower down); a span joins the matching ones of neighbouring poles
  const attach = (q, k, lowRand) => {
    const off = k < look.power ? (k - (look.power - 1) / 2) * 0.85 : (r() - 0.5) * 0.7;
    const drop = k < look.power ? 0.5 : 2.2 + (k - look.power) * 0.38 + (lowRand ? r() * 0.6 : 0);
    return new THREE.Vector3(q.pos.x + q.right.x * off, q.top - drop, q.pos.z + q.right.z * off);
  };
  const verts = [];
  const span = (A, B, sag) => {
    const SEG = 8; let prev = A;
    for (let i = 1; i <= SEG; i++) {
      const t = i / SEG, p = A.clone().lerp(B, t);
      p.y -= sag * 4 * t * (1 - t);
      verts.push(prev.x, prev.y, prev.z, p.x, p.y, p.z); prev = p;
    }
  };
  const total = look.power + look.comms;
  for (let i = 0; i + 1 < poles.length; i++) {
    const a = poles[i], b = poles[i + 1], d = a.pos.distanceTo(b.pos);
    if (d > look.gap * 1.9) continue; // a gap in the village: the line ends here
    for (let k = 0; k < total; k++) {
      const A = attach(a, k, look.tangle), B = attach(b, k, look.tangle);
      span(A, B, d * look.sag * (look.tangle && k >= look.power ? 0.8 + r() * 1.6 : 1));
    }
    if (look.tangle && i + 2 < poles.length && r() < 0.5) {   // a cable that skips a pole, over the others
      const c = poles[i + 2], D = attach(a, look.power + 1, true), E = attach(c, look.power + 2, true);
      if (D.distanceTo(E) < look.gap * 2.2) span(D, E, D.distanceTo(E) * look.sag * 1.4);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  const wires = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x17171c }));
  wires.frustumCulled = false;
  group.add(wires);
  return group;
}
