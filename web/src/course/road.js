// The road: the course's strip with its markings, the OSM side roads, guardrails and gutters.
import * as THREE from 'three';
import { rng } from './track.js';

// `centre` (course.json, per place): 'yellow' a single solid yellow line (Japan, the default) · 'double-yellow' (US, Brazil) ·
// 'white' a solid white line (Europe) · 'double-white' (Hong Kong)
function roadTexture(markings = true, centre = 'yellow') {
  // 7 m wide x 14 m long tile. Solid centre line (no overtaking: it's a mountain pass),
  // white edge lines 0.3 m in from the edge.
  const W = 256, H = 512, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#3a3b3f'; g.fillRect(0, 0, W, H);
  const r = rng(7);
  for (let k = 0; k < 9000; k++) {
    const v = 40 + r() * 40;
    g.fillStyle = `rgb(${v},${v},${v + 3})`;
    g.fillRect(r() * W, r() * H, 1 + r() * 2, 1 + r() * 2);
  }
  const m = W / 7; // px per metre
  if (!markings) {
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    return tex;
  }
  g.fillStyle = '#e8e6dc';
  g.fillRect(0.3 * m, 0, 0.15 * m, H);
  g.fillRect(W - 0.45 * m, 0, 0.15 * m, H);
  g.fillStyle = centre.endsWith('white') ? '#e8e6dc' : '#e0a020';
  if (centre.startsWith('double')) {
    for (const side of [-1, 1]) g.fillRect(W / 2 + side * 0.13 * m - 0.065 * m, 0, 0.13 * m, H); // two 13 cm lines, a 13 cm gap
  } else g.fillRect(W / 2 - 0.08 * m, 0, 0.16 * m, H);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export function buildRoad(path, { centre = 'yellow', heightAt, bridges } = {}) {
  const half = path.half, TILE = 14;
  // the course plus its scenery extensions either end (path.ext), as one strip
  const pts = [...[...path.ext.start].reverse(), ...path.P.map((p, i) => ({ p, r: path.R[i] })), ...path.ext.end];
  const s0 = -path.ext.start.length * path.step, n = pts.length;
  const pos = new Float32Array(n * 6), uv = new Float32Array(n * 4), idx = [];
  const tmp = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const { p, r } = pts[i];
    tmp.copy(p).addScaledVector(r, -half); pos.set([tmp.x, tmp.y, tmp.z], i * 6);
    tmp.copy(p).addScaledVector(r, half); pos.set([tmp.x, tmp.y, tmp.z], i * 6 + 3);
    const v = (s0 + i * path.step) / TILE;
    uv.set([0, v, 1, v], i * 4);
    if (i < n - 1) { const a = 2 * i; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const road = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: roadTexture(true, centre), roughness: 0.9 }));
  road.name = 'road';
  road.add(buildRoadBody(pts, half, s0, path.step, heightAt, bridgeTest({ bridges })));

  // start and finish lines
  const lines = new THREE.Group();
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.8 });
  for (const s of [0, path.finish]) {
    const o = path.sample(s), q = [];
    for (const [a, b] of [[-1, -0.3], [1, -0.3], [-1, 0.3], [1, 0.3]]) {
      const v = o.pos.clone().addScaledVector(o.right, a * half).addScaledVector(o.forward, b);
      q.push(v.x, v.y + 0.02, v.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(q, 3));
    g.setIndex([0, 1, 2, 1, 3, 2]); // corners: L-back, R-back, L-front, R-front -> faces up
    g.computeVertexNormals();
    lines.add(new THREE.Mesh(g, lineMat));
  }
  road.add(lines);
  if (path.sideRoads.length) road.add(buildSideRoads(path.sideRoads));
  return road;
}

/** Under the surface: a slab (the road is its top face) whose lower part also juts `flange` out each side, giving the cross-section
 *  an upside-down T. The flange follows the ground: its top sits `sink` below the terrain beside the road, so it is buried wherever
 *  the ground is near the road, while the slab's wall fills the gap down to it where the ground falls away (at most `maxDrop`
 *  down). On a bridge (the slab under it is its own) it stays at the fixed depth `bridgeDrop`. The guardrail posts run down to it. */
export const ROAD_BODY = { flange: 0.85, flangeThick: 0.25, sink: 0.3, maxDrop: 2, bridgeDrop: 0.3 };

/** How far below the road surface the flange top is at (x, z): see ROAD_BODY. */
export function flangeDrop(heightAt, x, z, roadY, onBridge) {
  if (onBridge) return ROAD_BODY.bridgeDrop;
  return THREE.MathUtils.clamp(roadY - heightAt(x, z) + ROAD_BODY.sink, ROAD_BODY.bridgeDrop, ROAD_BODY.maxDrop);
}

/** `s => bool`: is road position `s` on a bridge deck (course.bridges, padded a little)? */
export function bridgeTest(course, pad = 3) {
  const spans = course.bridges || [];
  return (s) => spans.some(([a, b]) => s >= a - pad && s <= b + pad);
}

function buildRoadBody(pts, half, s0, step, heightAt, isBridge) {
  const { flange, flangeThick } = ROAD_BODY, w = half + flange, mid = half + flange / 2;
  const pos = [], idx = [], n = pts.length;
  const drops = pts.map(({ p, r }, i) => {                                  // flange top depth, left and right
    const bridge = isBridge(s0 + i * step);
    return [-1, 1].map((side) => flangeDrop(heightAt, p.x + r.x * side * mid, p.z + r.z * side * mid, p.y, bridge));
  });
  for (let m = 0; m < 7; m++) {
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const { p, r } = pts[i], [dl, dr] = drops[i];
      // cross-section (right of the centre line, up from the surface), left top edge round to the right top edge
      const prof = [[-half, 0], [-half, -dl], [-w, -dl], [-w, -dl - flangeThick], [w, -dr - flangeThick], [w, -dr], [half, -dr], [half, 0]];
      for (const [u, v] of [prof[m], prof[m + 1]]) pos.push(p.x + r.x * u, p.y + v, p.z + r.z * u);
      if (i < n - 1) { const q = base + 2 * i; idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8a8880, roughness: 0.95, side: THREE.DoubleSide }));
  mesh.name = 'road-body';
  return mesh;
}

/** The other roads (OSM), as one unmarked strip mesh. Each tucks under the course where they meet (polygon offset),
 *  and wider roads sit a hair above narrower ones so their junctions don't flicker. */
function buildSideRoads(roads, TILE = 14) {
  const pos = [], uv = [], col = [], idx = [];
  const paved = new THREE.Color(1, 1, 1), track = new THREE.Color(0.95, 0.78, 0.55);
  const foot = new THREE.Color(1.5, 1.42, 1.28), steps = new THREE.Color(1.9, 1.85, 1.75); // pale concrete (the texture is asphalt-dark, so >1)
  for (const rd of roads) {
    const p = rd.p, n = p.length / 3, half = rd.w / 2, lift = Math.max(rd.w, 3) * 0.004, c = rd.k === 3 ? steps : rd.k === 2 ? foot : rd.k ? track : paved;
    const base = pos.length / 3;
    let v = 0;
    for (let k = 0; k < n; k++) {
      const a = Math.max(k - 1, 0), b = Math.min(k + 1, n - 1);
      let fx = p[b * 3] - p[a * 3], fz = p[b * 3 + 2] - p[a * 3 + 2];
      const L = Math.hypot(fx, fz) || 1; fx /= L; fz /= L;
      const x = p[k * 3], y = p[k * 3 + 1] + lift, z = p[k * 3 + 2];
      if (k) v += Math.hypot(x - p[k * 3 - 3], z - p[k * 3 - 1]) / TILE;
      pos.push(x + fz * half, y, z - fx * half, x - fz * half, y, z + fx * half); // left, right
      uv.push(0, v, rd.w / 7, v);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (k < n - 1) { const q = base + 2 * k; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: roadTexture(false), vertexColors: true, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
  }));
  mesh.name = 'side-roads';
  mesh.userData.asphalt = true; // weather.js wets it along with the course
  return mesh;
}

// ---------------------------------------------------------------- guardrails

export function buildGuardrails(path, course, heightAt) {
  const group = new THREE.Group();
  group.name = 'guardrails';
  const railMat = new THREE.MeshStandardMaterial({ color: 0xdedcd4, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
  const postGeo = new THREE.BoxGeometry(0.12, 1, 0.12);   // scaled per post: from the top of the rail (0.8) down into the ground, to the road flange
  const isBridge = bridgeTest(course);
  const reflGeo = new THREE.BoxGeometry(0.16, 0.12, 0.04);
  const postMat = new THREE.MeshStandardMaterial({ color: 0xb8b6ae, roughness: 0.6 });
  const reflMat = new THREE.MeshBasicMaterial({ color: 0xff9a1f });
  const posts = [], refls = [];
  const off = path.half + 0.7;
  const tmp = new THREE.Vector3();

  // open the rail where a side road joins (just the mesh: the gameplay rail flags stay as they are)
  const open = { [-1]: new Set(), [1]: new Set() };
  for (const j of path.junctions()) {
    const r = Math.ceil((j.half + 1.5) / path.step);
    for (let k = j.i - r; k <= j.i + r; k++) open[j.side].add(k);
  }
  for (const [rails, side] of [[course.rail_left, -1], [course.rail_right, 1]]) {
    // also drop the rail on the inside of a bend tighter than the offset allows (the offset line folds back into the road)
    const tight = (k) => { for (let m = Math.max(0, k - 2); m <= Math.min(path.n - 1, k + 2); m++) if (side * path.K[m] * off > 0.7) return true; return false; };
    const flags = Array.from(rails, (f, k) => (open[side].has(k) || tight(k) ? '0' : f));
    let i = 0;
    while (i < path.n) {
      if (flags[i] !== '1') { i++; continue; }
      let j = i;
      while (j < path.n && flags[j] === '1') j++;
      // one W-beam strip for the run [i, j)
      const cnt = j - i, pos = new Float32Array(cnt * 6), idx = [];
      for (let k = 0; k < cnt; k++) {
        const p = path.P[i + k], r = path.R[i + k];
        tmp.copy(p).addScaledVector(r, side * off);
        pos.set([tmp.x, tmp.y + 0.45, tmp.z, tmp.x, tmp.y + 0.8, tmp.z], k * 6);
        if (k < cnt - 1) { const a = 2 * k; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
        if ((i + k) % 2 === 0) posts.push([tmp.clone(), 0.8 + flangeDrop(heightAt, tmp.x, tmp.z, p.y, isBridge((i + k) * path.step)) + ROAD_BODY.flangeThick]);
        if ((i + k) % 10 === 0) refls.push([tmp.clone(), r.clone().multiplyScalar(-side)]);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, railMat));
      i = j;
    }
  }
  const m4 = new THREE.Matrix4(), tmpScale = new THREE.Vector3();
  const postMesh = new THREE.InstancedMesh(postGeo, postMat, posts.length);
  const one0 = new THREE.Vector3(), id = new THREE.Quaternion();
  posts.forEach(([p, h], k) => postMesh.setMatrixAt(k, m4.compose(one0.set(p.x, p.y + 0.8 - h / 2, p.z), id, tmpScale.set(1, h, 1))));
  const reflMesh = new THREE.InstancedMesh(reflGeo, reflMat, refls.length);
  const q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  refls.forEach(([p, inward], k) => {
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), inward);
    m4.compose(new THREE.Vector3(p.x, p.y + 0.62, p.z).addScaledVector(inward, 0.03), q, one);
    reflMesh.setMatrixAt(k, m4);
  });
  group.add(postMesh, reflMesh);
  return group;
}

// ---------------------------------------------------------------- gutters

/** Concrete U-channel drainage gutter along the mountain side of the road (metres, outward from the road edge). */
export const GUTTER = { lip: 0.04, width: 0.36, depth: 0.2, curb: 0.3 };
GUTTER.centre = GUTTER.lip + GUTTER.width / 2; // wheel line, measured from the road edge

/** Per centreline point, per side: is there a gutter? Wherever there's no guardrail and the ground doesn't drop away. */
export function gutterFlags(path, course, heightAt) {
  const flags = { left: new Uint8Array(path.n), right: new Uint8Array(path.n) };
  const tmp = new THREE.Vector3();
  for (const [rails, side, out] of [[course.rail_left, -1, flags.left], [course.rail_right, 1, flags.right]]) {
    for (let i = 0; i < path.n; i++) {
      if (rails[i] === '1') continue;
      tmp.copy(path.P[i]).addScaledVector(path.R[i], side * (path.half + 4));
      out[i] = heightAt(tmp.x, tmp.z) >= path.P[i].y - 2 ? 1 : 0;
    }
  }
  return flags;
}

export function buildGutters(path, flags) {
  const { lip, width: w, depth: d, curb } = GUTTER;
  // cross-section (outward, up) from the road edge: inner lip, channel, outer curb, skirt down into the terrain
  const prof = [[0, 0], [lip, 0], [lip, -d], [lip + w, -d], [lip + w, 0.03], [lip + w + curb, 0.03], [lip + w + curb, -0.35]];
  const top = new THREE.Color(0x9c9a92), grime = new THREE.Color(0x46453f), floor = new THREE.Color(0x2e2d29);
  const segCol = [top, grime, floor, grime, top, grime];
  const pos = [], col = [], idx = [];
  const tmp = new THREE.Vector3(), c = new THREE.Color();
  for (const [f, side] of [[flags.left, -1], [flags.right, 1]]) {
    let i = 0;
    while (i < path.n) {
      if (!f[i]) { i++; continue; }
      let j = i;
      while (j < path.n && f[j]) j++;
      const a = Math.max(i - 1, 0), b = Math.min(j, path.n - 1); // overlap a point either end: no gaps at runs' ends
      for (let m = 0; m < prof.length - 1; m++) {
        const base = pos.length / 3;
        for (let k = a; k <= b; k++) {
          const P = path.P[k], R = path.R[k];
          // concrete sections every 2 m: alternate the shade a touch so the joints read
          c.copy(segCol[m]).multiplyScalar(k % 2 ? 1 : 0.9);
          for (const [x, y] of [prof[m], prof[m + 1]]) {
            tmp.copy(P).addScaledVector(R, side * (path.half + x));
            pos.push(tmp.x, tmp.y + y, tmp.z);
            col.push(c.r, c.g, c.b);
          }
          if (k < b) { const q = base + 2 * (k - a); idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }
        }
      }
      i = j;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }));
  mesh.name = 'gutters';
  return mesh;
}
