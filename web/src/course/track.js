// Course loading and geometry: the road, guardrails, terrain, forest and buildings.
// Data comes from tools/build_track.py (see web/public/track/course.json).
// Frame: metres, x east, z south, y elevation. Driving "right" = forward × up.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export async function loadCourse(base = 'track/') {
  const course = await (await fetch(base + 'course.json')).json();
  const buf = await (await fetch(base + course.terrain.file)).arrayBuffer();
  course.heights = new Float32Array(buf);
  // buildings are optional scenery (tools/build_buildings.py): a missing file just means an empty mountain
  course.buildings = await fetch(base + 'buildings.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // so are the other roads (tools/build_roads.py)
  course.roads = await fetch(base + 'roads.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return course;
}

// Deterministic RNG so the forest is the same every load.
export function rng(seed = 1) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Terrain height lookup (bilinear) in course coordinates. */
export function makeHeightAt(course) {
  const { nx, nz, x0, z0, cell } = course.terrain;
  const H = course.heights;
  return (x, z) => {
    const fx = Math.min(Math.max((x - x0) / cell, 0), nx - 1.001);
    const fz = Math.min(Math.max((z - z0) / cell, 0), nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const a = H[j * nx + i], b = H[j * nx + i + 1], c = H[(j + 1) * nx + i], d = H[(j + 1) * nx + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

/** The road centreline as a sampleable path, indexed by distance s (metres from the start line). */
export class TrackPath {
  constructor(course) {
    this.step = course.step;
    this.half = course.road_half_width;
    this.length = course.length;
    this.finish = course.finish;
    this.P = course.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    this.n = this.P.length;
    this.F = []; // 3D unit tangent (includes slope)
    this.R = []; // horizontal unit right
    const heading = [];
    for (let i = 0; i < this.n; i++) {
      const a = this.P[Math.max(i - 1, 0)], b = this.P[Math.min(i + 1, this.n - 1)];
      const f = b.clone().sub(a).normalize();
      this.F.push(f);
      this.R.push(new THREE.Vector3(-f.z, 0, f.x).normalize());
      heading.push(Math.atan2(f.z, f.x));
    }
    // signed curvature (1/m), positive = right-hander
    for (let i = 1; i < this.n; i++) {
      while (heading[i] - heading[i - 1] > Math.PI) heading[i] -= 2 * Math.PI;
      while (heading[i] - heading[i - 1] < -Math.PI) heading[i] += 2 * Math.PI;
    }
    this.K = heading.map((_, i) => {
      const a = heading[Math.max(i - 2, 0)], b = heading[Math.min(i + 2, this.n - 1)];
      return (b - a) / (this.step * (Math.min(i + 2, this.n - 1) - Math.max(i - 2, 0)));
    });
    this.ext = this._extensions(course);
    /** Scenery roads from OSM: [{ w: width, k: 1 for a track, p: [x, y, z, ...] }] */
    this.sideRoads = course.roads?.roads || [];
  }

  /** Height of the course's road surface at (x, z), or null if (x, z) isn't on it (off the edge, or nowhere near).
   *  (The road is flat across, so the centreline's height, followed along the slope, is the surface's.)
   *  Nearest centreline point by a coarse grid, so it's cheap enough to call per light per frame. */
  surfaceAt(x, z) {
    if (!this._grid) {
      const CELL = 16, grid = new Map();
      this.P.forEach((p, i) => {
        const k = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      });
      this._grid = { CELL, grid };
    }
    const { CELL, grid } = this._grid, ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    let best = -1, bd = Infinity;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const i of grid.get(`${ci + a},${cj + b}`) || []) {
        const d = (this.P[i].x - x) ** 2 + (this.P[i].z - z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    if (best < 0 || bd >= (this.half + 0.5) ** 2) return null;
    // the nearest point can be a metre up or down the road: follow the slope from it (it's steep in places)
    const P = this.P[best], F = this.F[best], h2 = F.x * F.x + F.z * F.z || 1;
    return P.y + ((x - P.x) * F.x + (z - P.z) * F.z) * F.y / h2;
  }

  /** Where side roads run onto the course: [{ i: centreline index, side: -1 left / +1 right, half: their half-width }] */
  junctions() {
    if (this._junctions) return this._junctions;
    const near = roadProximity(this, { sideRoads: false }), out = [];
    for (const rd of this.sideRoads) {
      for (const k of [0, rd.p.length / 3 - 1]) {
        const x = rd.p[k * 3], z = rd.p[k * 3 + 2];
        if (!near(x, z, this.half + 1)) continue;
        let best = 0, bd = Infinity;
        for (let i = 0; i < this.n; i++) { const d = (this.P[i].x - x) ** 2 + (this.P[i].z - z) ** 2; if (d < bd) { bd = d; best = i; } }
        const side = Math.sign((x - this.P[best].x) * this.R[best].x + (z - this.P[best].z) * this.R[best].z) || 1;
        out.push({ i: best, side, half: rd.w / 2 });
      }
    }
    return (this._junctions = out);
  }

  /** Scenery road beyond both ends: straight on from the summit and from the bottom out to the edge of the terrain,
   *  so the road doesn't just stop. Each is a list of { p, r } stepping outward from the end point: it leaves on the
   *  road's own grade, eases onto the terrain and never dips under it. The rival's run-up drives on it (`sample`). */
  _extensions(course) {
    const heightAt = makeHeightAt(course);
    const { nx, nz, x0, z0, cell } = course.terrain;
    const xa = x0 + 2 * cell, xb = x0 + (nx - 3) * cell, za = z0 + 2 * cell, zb = z0 + (nz - 3) * cell;
    const make = (end, dir) => {
      const P = this.P[end], f = this.F[end];
      const d = new THREE.Vector3(f.x, 0, f.z).normalize().multiplyScalar(dir);
      const r = new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(dir); // keep "right" pointing the same way as the road's
      const grade = (dir * f.y) / Math.hypot(f.x, f.z);
      const pts = [], ground = [];
      for (let k = 1; ; k++) {
        const dist = k * this.step, x = P.x + d.x * dist, z = P.z + d.z * dist;
        if (x < xa || x > xb || z < za || z > zb) break;
        let g = -Infinity;
        for (const l of [-this.half - 0.5, 0, this.half + 0.5]) g = Math.max(g, heightAt(x + r.x * l, z + r.z * l));
        ground.push(g + 0.2);
        const w = THREE.MathUtils.smoothstep(dist, 0, 60);
        pts.push({ p: new THREE.Vector3(x, THREE.MathUtils.lerp(P.y + grade * dist, g + 0.2, w), z), r });
      }
      // smooth over the terrain's 8 m cells, then make sure it's still on top of the ground
      const ys = pts.map((q) => q.p.y);
      pts.forEach((q, k) => {
        let sum = 0, cnt = 0;
        for (let m = Math.max(k - 8, 0); m <= Math.min(k + 8, pts.length - 1); m++) { sum += ys[m]; cnt++; }
        const w = Math.min(k / 8, 1); // no smoothing right at the join
        q.p.y = Math.max(THREE.MathUtils.lerp(ys[k], sum / cnt, w), ground[k]);
      });
      return pts;
    };
    return { start: make(0, -1), end: make(this.n - 1, 1) };
  }

  _idx(s) {
    const f = Math.min(Math.max(s / this.step, 0), this.n - 1.0001);
    const i = Math.floor(f);
    return [i, f - i];
  }

  /** Position on the road at distance s, `lateral` metres to the right of the centreline. */
  sample(s, lateral = 0, out = {}) {
    const [i, t] = this._idx(s);
    out.pos = (out.pos || new THREE.Vector3()).lerpVectors(this.P[i], this.P[i + 1], t);
    out.forward = (out.forward || new THREE.Vector3()).lerpVectors(this.F[i], this.F[i + 1], t).normalize();
    out.right = (out.right || new THREE.Vector3()).lerpVectors(this.R[i], this.R[i + 1], t).normalize();
    out.pos.addScaledVector(out.right, lateral);
    out.curvature = this.K[i] * (1 - t) + this.K[i + 1] * t;
    if (s < 0) { // before the start (the rival's run-up): along the scenery road straight on back
      const e = this.ext.start, f = Math.min(-s / this.step, e.length - 1.0001), k = Math.floor(f);
      const a = k ? e[k - 1].p : this.P[0], b = e[k].p;
      out.pos.lerpVectors(a, b, f - k).addScaledVector(out.right, lateral);
    }
    return out;
  }
}

// ---------------------------------------------------------------- road

function roadTexture(markings = true) {
  // 7 m wide x 14 m long tile. Solid yellow centre line (no overtaking: it's a mountain pass),
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
  g.fillStyle = '#e0a020';
  g.fillRect(W / 2 - 0.08 * m, 0, 0.16 * m, H);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export function buildRoad(path) {
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
  const road = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: roadTexture(), roughness: 0.9 }));
  road.name = 'road';

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

export function buildGuardrails(path, course) {
  const group = new THREE.Group();
  group.name = 'guardrails';
  const railMat = new THREE.MeshStandardMaterial({ color: 0xdedcd4, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
  const postGeo = new THREE.BoxGeometry(0.12, 0.8, 0.12);
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
        if ((i + k) % 2 === 0) posts.push(tmp.clone());
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
  const m4 = new THREE.Matrix4();
  const postMesh = new THREE.InstancedMesh(postGeo, postMat, posts.length);
  posts.forEach((p, k) => postMesh.setMatrixAt(k, m4.makeTranslation(p.x, p.y + 0.4, p.z)));
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

// ---------------------------------------------------------------- terrain

export function buildTerrain(course, portals = []) {
  const { nx, nz, x0, z0, cell } = course.terrain;
  const H = course.heights;
  const cells = (nx - 1) * (nz - 1);
  const pos = new Float32Array(cells * 18), col = new Float32Array(cells * 18);
  const r = rng(42);
  const G = course.ground || null;                      // per-site scrub / rock tints (fly-over sites); Japan has none
  const gScrub = G && new THREE.Color(G.scrub), gRock = G && new THREE.Color(G.rock), gGreen = G && new THREE.Color(G.green), gSand = G?.sand && new THREE.Color(G.sand);
  const hash = (i, j) => { const t = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return t - Math.floor(t); };
  const vnoise = (x, z) => {                            // smooth value noise, one lattice cell per `1` of x/z
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), w = fz * fz * (3 - 2 * fz);
    return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - w) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * w;
  };
  const forest = new THREE.Color(0x2c4a2a), meadow = new THREE.Color(0x56683a), rock = new THREE.Color(0x5e5a52);
  const c = new THREE.Color(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  let o = 0;
  const V = (i, j) => [x0 + i * cell, H[j * nx + i], z0 + j * cell];
  const tri = (a, b, d) => {
    pos.set(a, o); pos.set(b, o + 3); pos.set(d, o + 6);
    e1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    e2.set(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    nrm.crossVectors(e1, e2).normalize();
    const flat = Math.abs(nrm.y);                       // 1 = level ground
    const h = (a[1] + b[1] + d[1]) / 3;
    c.copy(forest).lerp(meadow, THREE.MathUtils.clamp((h - 1150) / 150, 0, 1) * 0.7);
    c.lerp(rock, THREE.MathUtils.clamp((0.8 - flat) / 0.25, 0, 1));
    if (G) {                                            // green base, dry scrub in patches, bare rock where it's steep
      const cx = (a[0] + b[0] + d[0]) / 3, cz = (a[2] + b[2] + d[2]) / 3;
      const patch = 0.6 * vnoise(cx / 90, cz / 90) + 0.4 * vnoise(cx / 28, cz / 28);
      c.copy(gGreen).lerp(gScrub, THREE.MathUtils.smoothstep(patch, 0.45, 0.7) * 0.85);
      const steep = THREE.MathUtils.clamp((G.rockFlat - flat) / 0.2, 0, 1) * (0.55 + 0.45 * vnoise(cx / 40, cz / 40));
      c.lerp(gRock, Math.min(1, steep));
      if (gSand) c.lerp(gSand, 0.92 * (1 - THREE.MathUtils.smoothstep(h, G.sandBelow, G.sandBelow + 1.5))); // beaches: low ground by the water
    }
    const jit = 0.9 + r() * 0.2;
    c.multiplyScalar(jit);
    for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], o + k * 3);
    o += 9;
  };
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = V(i, j), b = V(i + 1, j), cc = V(i, j + 1), d = V(i + 1, j + 1);
      if ((i + j) & 1) { tri(a, cc, b); tri(b, cc, d); }
      else { tri(a, cc, d); tri(a, d, b); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals(); // non-indexed -> faceted
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, portals.length ? cutPortals(mat, portals) : mat);
  mesh.name = 'terrain';
  return mesh;
}

// ---------------------------------------------------------------- forest

// Vegetation is instanced in square chunks, so three.js frustum-culls what's off screen, and each chunk is also skipped
// once it's further than the fog lets you see (or than `near`, for the small stuff). Distances come from the live
// fog every frame, so the flyby's thinner fog automatically keeps more of the mountain.
const FOG_GONE = Math.sqrt(-Math.log(0.02)); // FogExp2 is 98% opaque at FOG_GONE / density

/** Instanced meshes, one per `cell`-metre square that has any `items` ({ x, z, m: Matrix4, c: Color }). */
function chunked(items, geo, mat, cell, near = Infinity) {
  const buckets = new Map();
  for (const it of items) {
    const k = `${Math.floor(it.x / cell)},${Math.floor(it.z / cell)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }
  return [...buckets.values()].map((list) => {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => { mesh.setMatrixAt(i, it.m); mesh.setColorAt(i, it.c); });
    mesh.computeBoundingSphere(); // over the instances: what frustum culling and the distance check use
    mesh.userData.near = near;
    return mesh;
  });
}

/** A group of chunks that hides the ones out of sight range. Add it straight to the scene (that's when it hooks in). */
function cullingGroup(name, meshes) {
  const group = new THREE.Group();
  group.name = name;
  group.add(...meshes);
  // cull by distance in the scene's onBeforeRender (before three.js decides what to draw), chained like taillights.js.
  // Assumes the group sits untransformed in the scene, as the course does.
  group.addEventListener('added', () => {
    const scene = group.parent;
    if (!scene?.isScene || group.userData.hooked) return;
    group.userData.hooked = true;
    const before = scene.onBeforeRender;
    scene.onBeforeRender = function (renderer, sc, camera, target) {
      before.call(this, renderer, sc, camera, target);
      const fog = sc.fog, fogCut = fog?.isFogExp2 ? FOG_GONE / fog.density : fog?.isFog ? fog.far : Infinity;
      for (const m of group.children) {
        const b = m.boundingSphere;
        m.visible = camera.position.distanceTo(b.center) - b.radius < Math.min(fogCut, m.userData.near);
      }
    };
  });
  return group;
}

/** (x, z) → within `min` metres of any leg of the road? Spatial hash over the centreline points. */
// `min` is a clearance from the course's centreline; side roads get the same clearance from their edge.
function roadProximity(path, { sideRoads = true } = {}) {
  const CELL = 20, grid = new Map(), key = (i, j) => `${i},${j}`;
  const add = (x, z, extra) => {
    const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ x, z, extra });
  };
  for (const p of [...path.P, ...path.ext.start.map((q) => q.p), ...path.ext.end.map((q) => q.p)]) add(p.x, p.z, 0);
  if (sideRoads) for (const rd of path.sideRoads) for (let k = 0; k < rd.p.length; k += 3) add(rd.p[k], rd.p[k + 2], rd.w / 2 - path.half);
  return (x, z, min) => {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const p of grid.get(key(ci + a, cj + b)) || []) {
        const r = min + p.extra;
        if ((p.x - x) ** 2 + (p.z - z) ** 2 < r * r) return true;
      }
    }
    return false;
  };
}

/** Lower down the mountain the woods close in on the road: 0 at the summit stretch, 1 from ~980 m down. */
const LOWLAND = (y) => THREE.MathUtils.smoothstep(-y, -1110, -980);

/** (x, z) → 0..1, how "in town" (Ikaho) a spot is, by how many buildings stand within 250 m: a lone farmhouse
 *  (there's one mid-mountain) doesn't count, ~30+ is town. */
function townness(data) {
  if (!data?.buildings?.length) return () => 0;
  const CELL = 100, grid = new Map(), key = (i, j) => `${i},${j}`;
  for (const b of data.buildings) {
    let x = 0, z = 0;
    for (let i = 0; i < b.p.length; i += 2) { x += b.p[i]; z += b.p[i + 1]; }
    x /= b.p.length / 2; z /= b.p.length / 2;
    const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push([x, z]);
  }
  return (x, z) => {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    let n = 0;
    for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++)
      for (const [bx, bz] of grid.get(key(ci + a, cj + b)) || []) if ((bx - x) ** 2 + (bz - z) ** 2 < 250 * 250) n++;
    return THREE.MathUtils.smoothstep(n, 3, 30);
  };
}

/** Thin already-placed items near town (and push them back from the road) without touching anything elsewhere:
 *  a filter after placement, keyed on a position hash, so no other item's random draws shift. */
function thinForTown(items, town, { thin, push = 0, minRoad = 0 }) {
  const hash = (x, z) => { const h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return h - Math.floor(h); };
  return items.filter((it) => {
    const t = town(it.x, it.z);
    return !t || (hash(it.x, it.z) >= thin * t && Math.abs(it.lat) >= minRoad + push * t);
  });
}

/** The dense lower-mountain growth: comes in below the summit stretch, thins out again approaching town. */
function lowland(buildings) {
  const town = townness(buildings);
  return {
    weight: (y, x, z) => LOWLAND(y) * (1 - 0.85 * town(x, z)),
    keepOut: (x, z) => 5 * town(x, z), // and backs off the road: town verges are mown
  };
}

/** Scatter `count` things along the road, `minRoad`..`maxRoad` m from the centreline (biased towards the road by `bias`). */
// `forest.sparse` in course.json: { below: metres, palmRoad: metres } leaves no trees on ground lower than that, except palms within palmRoad of the road (a beach front; the sea is below it)
let sparse = null;
function scatter(path, heightAt, inTown, nearRoad, r, { count, minRoad, maxRoad, bias = 1.6, maxSlope = 4.5, weight = null, keepOut = null, palm = false }, make) {
  const items = [], o = {};
  for (let tries = 0; items.length < count && tries < count * 8; tries++) {
    const lat = (r() < 0.5 ? -1 : 1) * (minRoad + Math.pow(r(), bias) * (maxRoad - minRoad));
    path.sample(r() * path.length, lat, o);
    const x = o.pos.x, z = o.pos.z;
    if (sparse && heightAt(x, z) < sparse.below && !(palm && Math.abs(lat) < sparse.palmRoad)) continue; // the coastal plain: just palms by the road
    if (weight && r() >= weight(o.pos.y, x, z)) continue; // thinned out by elevation / town
    if (keepOut && Math.abs(lat) < minRoad + keepOut(x, z)) continue;
    if (nearRoad(x, z, minRoad) || inTown(x, z)) continue;
    const slope = Math.abs(heightAt(x + 2, z) - heightAt(x - 2, z)) + Math.abs(heightAt(x, z + 2) - heightAt(x, z - 2));
    if (slope > maxSlope) continue; // too steep / cliffy
    items.push({ x, z, lat, ...make(x, heightAt(x, z), z, o, lat) });
  }
  return items;
}

const UP_Y = new THREE.Vector3(0, 1, 0);
const placeAt = (r, x, y, z, sx, sy, sz) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP_Y, r() * Math.PI * 2), new THREE.Vector3(sx, sy, sz));

// `wideBroadleaf`: extra broadleaf trees scattered as wide as the conifers, for the drone's-eye views (the fly-by
// fly-by and the title screen behind it). From the road the fog hides them and the chunks skip drawing.
export function buildForest(path, heightAt, { count = 14000, young = 6000, minRoad = 10, maxRoad = 320, wideBroadleaf = 0, wideBias = 1.6, roadsideBroadleaf = 9000, palms = 0, foliage = null, buildings = null, sparse: sparseSpec = null } = {}) {
  sparse = sparseSpec;
  const inTown = townMask(buildings), nearRoad = roadProximity(path);
  // 22 triangles: no trunk caps (inside the crown / underground). The crown keeps its base: you see it from below
  // when a tree stands on a cut slope above the road.
  const trunk = new THREE.CylinderGeometry(0.18, 0.25, 1.6, 5, 1, true).translate(0, 0.8, 0);
  const crown = new THREE.ConeGeometry(1.9, 6.5, 6).translate(0, 4.6, 0);
  const paint = (g, hex) => {
    const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  const geo = mergeGeometries([paint(trunk.toNonIndexed(), 0x2b2018), paint(crown.toNonIndexed(), 0x2f5a30)]);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

  const r = rng(99);
  const tree = (k) => (x, y, z) => ({
    m: placeAt(r, x, y - 0.2, z, k, k * (0.85 + r() * 0.4), k),
    c: new THREE.Color().setHSL(0.27 + r() * 0.08, 0.35 + r() * 0.2, 0.55 + r() * 0.3),
  });
  const town = townness(buildings);
  let items = scatter(path, heightAt, inTown, nearRoad, r, { count, minRoad, maxRoad }, (x, y, z) => tree(0.7 + r() * 0.8)(x, y, z));
  // saplings closer in, so the roadside isn't a lawn (small crowns: they stay clear of the gutters and the camera)
  const saplings = scatter(path, heightAt, inTown, nearRoad, r, { count: young, minRoad: 6.5, maxRoad: 16, bias: 1 },
    (x, y, z) => tree(0.35 + r() * 0.25)(x, y, z));
  // approaching Ikaho: fewer trees, and none crowding the road
  items = [...thinForTown(items, town, { thin: 0.6, push: 6, minRoad }), ...thinForTown(saplings, town, { thin: 0.85, push: 6, minRoad: 6.5 })];
  const low = lowland(buildings), broadleaves = broadleaf(path, heightAt, inTown, nearRoad, low, { ...foliage, count: roadsideBroadleaf });
  if (wideBroadleaf) broadleaves.push(...broadleaf(path, heightAt, inTown, nearRoad, low, { count: wideBroadleaf, minRoad, maxRoad, bias: wideBias, seed: 2718, ...foliage }));
  const groups = [...chunked(items, geo, mat, 250), ...chunked(broadleaves, broadleafGeo(paint), mottled(), 250)];
  if (palms) groups.push(...chunked(palmTrees(path, heightAt, inTown, nearRoad, palms), palmGeo(paint), mottled(), 250));
  return cullingGroup('forest', groups);
}

/** Lambert + world-space noise darkening, so broadleaf crowns get dappled light and shade (seamless between trees).
 *  Two octaves of value noise per fragment: a few dozen ALU ops, only where these trees are drawn. */
function mottled({ vertexColors = true } = {}) { // vertexColors off for geometry coloured only per instance
  const mat = new THREE.MeshLambertMaterial({ vertexColors, flatShading: true });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMottle;')
      .replace('#include <project_vertex>', `#include <project_vertex>
  vec4 mw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    mw = instanceMatrix * mw;
  #endif
  vMottle = (modelMatrix * mw).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vMottle;
float mHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float mNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(mHash(i), mHash(i + vec3(1, 0, 0)), f.x), mix(mHash(i + vec3(0, 1, 0)), mHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(mHash(i + vec3(0, 0, 1)), mHash(i + vec3(1, 0, 1)), f.x), mix(mHash(i + vec3(0, 1, 1)), mHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  float mn = 0.65 * mNoise(vMottle * 2.25) + 0.35 * mNoise(vMottle * 6.5);
  diffuseColor.rgb *= mix(0.45, 1.15, mn);`);
  };
  return mat;
}

// Broadleaf trees for the lower slopes (Route 33 between the hairpins): at the verge, leaning out over the road.
function broadleafGeo(paint) {
  const trunk = new THREE.CylinderGeometry(0.16, 0.26, 4.4, 5, 1, true).translate(0, 2.2, 0); // 10 tris
  const blob = (sx, sy, sz, x, y, z) => new THREE.IcosahedronGeometry(1, 0).scale(sx, sy, sz).translate(x, y, z); // 20 tris each
  const g = mergeGeometries([
    paint(trunk.toNonIndexed(), 0x2e241c),
    paint(blob(2.5, 1.5, 2.3, 0, 5.6, 0).toNonIndexed(), 0x35602a),
    paint(blob(1.8, 1.3, 1.9, 0.7, 6.9, -0.4).toNonIndexed(), 0x3d6a2e),
  ]);
  g.computeVertexNormals();
  return g;
}

function broadleaf(path, heightAt, inTown, nearRoad, low, { count = 9000, minRoad = 6, maxRoad = 40, bias = 1.8, seed = 314, hue = 0.25, span = 0.06 } = {}) {
  const r = rng(seed);
  return scatter(path, heightAt, inTown, nearRoad, r, { count, minRoad, maxRoad, bias, ...low }, (x, y, z, o, lat) => {
    const k = 0.8 + r() * 0.45;
    // lean towards the road (towards the light): rotating "up" about the road's forward axis tilts it towards +right.
    // Crowns overhang the verge but their undersides stay ~3 m up, above the chase camera.
    const yaw = new THREE.Quaternion().setFromAxisAngle(UP_Y, r() * Math.PI * 2);
    const fwd = new THREE.Vector3(o.right.z, 0, -o.right.x);
    const toRoad = 1 - THREE.MathUtils.smoothstep(Math.abs(lat), 40, 60); // only verge trees lean out over the road
    const lean = new THREE.Quaternion().setFromAxisAngle(fwd, -Math.sign(lat) * (0.06 + r() * 0.16) * toRoad);
    return {
      m: new THREE.Matrix4().compose(new THREE.Vector3(x, y - 0.2, z), lean.multiply(yaw), new THREE.Vector3(k, k * (0.9 + r() * 0.3), k)),
      c: new THREE.Color().setHSL(hue + r() * span, 0.4 + r() * 0.2, 0.6 + r() * 0.3),
    };
  });
}

// Palms (Rio): a tall bare trunk and two stacked umbrella crowns. Scattered wide on the slopes and along the verges.
function palmGeo(paint) {
  const trunk = new THREE.CylinderGeometry(0.11, 0.2, 7.4, 5, 1, true).translate(0, 3.7, 0);
  const parts = [paint(trunk.toNonIndexed(), 0x6b5a45)];
  // a frond is two flat blades: the first rises and runs out from the crown, the second droops from its tip
  const blade = (len, w, rise, hex) => {
    const g = new THREE.BoxGeometry(w, 0.05, len).translate(0, 0, len / 2);
    return { g, rise, len, hex };
  };
  const FRONDS = 9, up = -0.4, down = 0.7, l1 = 2.1, l2 = 1.9;
  for (let i = 0; i < FRONDS; i++) {
    const yaw = (i / FRONDS) * Math.PI * 2 + (i % 2) * 0.12, lift = (i % 3) * 0.12;   // alternate fronds sit a little higher
    const m1 = new THREE.Matrix4().makeRotationX(up - lift);
    const tip = new THREE.Vector3(0, 0, l1).applyMatrix4(m1);
    const m2 = new THREE.Matrix4().makeRotationX(down - lift).setPosition(tip);
    const place = new THREE.Matrix4().makeTranslation(0, 7.5, 0).multiply(new THREE.Matrix4().makeRotationY(yaw));
    parts.push(paint(blade(l1, 0.85, 0, 0).g.applyMatrix4(m1).applyMatrix4(place).toNonIndexed(), 0x468a38));
    parts.push(paint(blade(l2, 0.55, 0, 0).g.applyMatrix4(m2).applyMatrix4(place).toNonIndexed(), 0x3a7430));
  }
  parts.push(paint(new THREE.IcosahedronGeometry(0.3, 0).translate(0, 7.3, 0).toNonIndexed(), 0x5a4630));   // coconut cluster
  const g = mergeGeometries(parts);
  g.computeVertexNormals();
  return g;
}

function palmTrees(path, heightAt, inTown, nearRoad, count) {
  const r = rng(808);
  return scatter(path, heightAt, inTown, nearRoad, r, { count, minRoad: 6.5, maxRoad: 160, bias: 1.2, maxSlope: 6, palm: true }, (x, y, z) => {
    const k = 0.8 + r() * 0.55;
    return { m: placeAt(r, x, y - 0.2, z, k, k * (0.85 + r() * 0.4), k), c: new THREE.Color().setHSL(0.27 + r() * 0.07, 0.45 + r() * 0.2, 0.65 + r() * 0.25) };
  });
}

/** Roadside undergrowth: solid low-poly bushes and dwarf-bamboo tufts, only drawn near the camera. */
export function buildUndergrowth(path, heightAt, { bushes = 25000, tufts = 50000, buildings = null, near = 160 } = {}) {
  const inTown = townMask(buildings), nearRoad = roadProximity(path), r = rng(7);
  const band = { minRoad: 5, maxRoad: 24, bias: 1.3, maxSlope: 7 }; // 1.5 m beyond the road edge (clear of gutter & rail) out to ~20 m
  const mat = mottled({ vertexColors: false }); // same dappling as the broadleaf crowns
  // same colour pipeline as the trees (hex × tint) so the greens sit together, with a little hue wobble
  const shade = (hex, k) => new THREE.Color(hex).offsetHSL((r() - 0.5) * 0.04, 0, 0).multiplyScalar(k);
  let bushItems = scatter(path, heightAt, inTown, nearRoad, r, { ...band, count: bushes }, (x, y, z) => {
    const k = 0.6 + r() * 1.0;
    return { m: placeAt(r, x, y - 0.15 * k, z, k * (0.8 + r() * 0.5), k * (0.55 + r() * 0.3), k * (0.8 + r() * 0.5)),
      c: shade(0x2a4a26, 0.55 + r() * 0.4) }; // a shade under the tree crowns: their facets face the sky
  });
  let tuftItems = scatter(path, heightAt, inTown, nearRoad, r, { ...band, count: tufts }, (x, y, z) => {
    const k = 0.6 + r() * 0.8, m = placeAt(r, x, y - 0.08, z, k, k * (0.7 + r() * 0.6), k);
    m.multiply(new THREE.Matrix4().makeRotationX((r() - 0.5) * 0.5)); // lean a little, like grass does
    return { m, c: shade(0x3e5a24, 0.6 + r() * 0.45) }; // dwarf bamboo: a touch yellower
  });
  const town = townness(buildings);
  bushItems = thinForTown(bushItems, town, { thin: 0.8, push: 5, minRoad: band.minRoad });
  tuftItems = thinForTown(tuftItems, town, { thin: 0.8, push: 5, minRoad: band.minRoad });
  // lower down, the verge is overgrown right up to the gutter curb and the guardrail posts (own RNG: the summit stays put)
  const r2 = rng(271), verge = { minRoad: 4.6, maxRoad: 12, bias: 1.2, maxSlope: 7, ...lowland(buildings) };
  const pick = (fn) => (...a) => fn(r2, ...a);
  bushItems.push(...scatter(path, heightAt, inTown, nearRoad, r2, { ...verge, minRoad: 5.2, count: 20000 }, pick((rr, x, y, z) => {
    const k = 0.6 + rr() * 0.9;
    return { m: placeAt(rr, x, y - 0.15 * k, z, k * (0.8 + rr() * 0.5), k * (0.55 + rr() * 0.4), k * (0.8 + rr() * 0.5)), c: shade(0x2e5226, 0.6 + rr() * 0.45) };
  })));
  tuftItems.push(...scatter(path, heightAt, inTown, nearRoad, r2, { ...verge, count: 45000 }, pick((rr, x, y, z) => {
    const k = 0.6 + rr() * 0.8, m = placeAt(rr, x, y - 0.08, z, k, k * (0.7 + rr() * 0.6), k);
    m.multiply(new THREE.Matrix4().makeRotationX((rr() - 0.5) * 0.5));
    return { m, c: shade(0x42602a, 0.65 + rr() * 0.45) };
  })));
  return cullingGroup('undergrowth', [
    ...chunked(bushItems, new THREE.IcosahedronGeometry(0.6, 0).translate(0, 0.45, 0), mat, 80, near), // 20 tris
    ...chunked(tuftItems, new THREE.ConeGeometry(0.3, 0.8, 5, 1, true).translate(0, 0.4, 0), mat, 80, near), // 5 tris
  ]);
}

// ---------------------------------------------------------------- buildings

/** (x, z) → is it on or right next to a building? (so trees don't grow through the hotels) */
function townMask(data, pad = 3) {
  if (!data?.buildings?.length) return () => false;
  const CELL = 4, cells = new Set();
  for (const b of data.buildings) {
    const p = b.p;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
    for (let x = Math.floor((x0 - pad) / CELL); x <= Math.floor((x1 + pad) / CELL); x++)
      for (let z = Math.floor((z0 - pad) / CELL); z <= Math.floor((z1 + pad) / CELL); z++) cells.add(`${x},${z}`);
  }
  return (x, z) => cells.has(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
}

// Window texture: an 8×8 grid of bays, one bay per window per storey. The colour map is wall (white, tinted by
// the vertex colour) with a dark pane; the emissive map lights about a third of the panes warm, for night.
const BAYS = 8;
function windowTextures() {
  const N = 512, cell = N / BAYS, r = rng(7);
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = N; return c; };
  const col = mk(), emi = mk(), a = col.getContext('2d'), e = emi.getContext('2d');
  a.fillStyle = '#ffffff'; a.fillRect(0, 0, N, N);
  e.fillStyle = '#000000'; e.fillRect(0, 0, N, N);
  for (let i = 0; i < BAYS; i++) for (let j = 0; j < BAYS; j++) {
    const x = i * cell + cell * 0.25, y = j * cell + cell * 0.26, w = cell * 0.5, h = cell * 0.44;
    a.fillStyle = '#39424f'; a.fillRect(x, y, w, h);
    a.fillStyle = '#5d6877'; a.fillRect(x, y, w, h * 0.18); // a bit of sky in the glass
    const lit = r();
    if (lit < 0.36) {
      e.fillStyle = lit < 0.06 ? '#bfd8ff' : lit < 0.12 ? '#ffd9a0' : '#ffb85c'; // mostly warm, the odd TV
      e.fillRect(x, y, w, h);
      if (r() < 0.5) { e.fillStyle = 'rgba(0,0,0,.45)'; e.fillRect(x + w * (r() < 0.5 ? 0 : 0.55), y, w * 0.45, h); } // half-drawn curtain
    }
  }
  const tex = (c, srgb) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  };
  return { map: tex(col, true), emissiveMap: tex(emi, true) };
}

/**
 * Buildings from tools/build_buildings.py as one merged mesh: extruded footprints with a window bay every ~3.6 m
 * per storey, a plain plinth below the ground floor (hillsides), and flat or hipped roofs.
 */
export function buildBuildings(data, { day = false } = {}) {
  const group = new THREE.Group();
  group.name = 'buildings';
  if (!data?.buildings?.length) return group;
  const FLOOR = data.floor || 3.1, BAY = 3.6;
  const pos = [], uv = [], col = [];
  const PLAIN = [0.02 / BAYS, 0.02 / BAYS]; // a texel of bare wall, for plinths and roofs
  const c = new THREE.Color(), r = rng(31);
  const vert = (x, y, z, u, v, color) => { pos.push(x, y, z); uv.push(u, v); col.push(color.r, color.g, color.b); };
  const quad = (a, b, cc, d) => { for (const q of [a, b, cc, a, cc, d]) vert(...q); };

  for (const bld of data.buildings) {
    const p = bld.p, n = p.length / 2;
    const wall = new THREE.Color(bld.w), roof = new THREE.Color(bld.r);
    const ground = bld.t - bld.f * FLOOR;                  // where the first storey starts
    const plinth = Math.min(ground, bld.t);
    const uo = Math.floor(r() * BAYS), vo = Math.floor(r() * BAYS); // a different lit pattern per building
    let run = 0;
    for (let i = 0; i < n; i++) {
      const x0 = p[i * 2], z0 = p[i * 2 + 1], x1 = p[((i + 1) % n) * 2], z1 = p[((i + 1) % n) * 2 + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      // whole bays only, so windows never get sliced at a corner
      const bays = Math.max(1, Math.round(len / BAY));
      const u0 = (uo + run) / BAYS, u1 = (uo + run + bays) / BAYS;
      run += bays;
      const v0 = vo / BAYS, v1 = (vo + bld.f) / BAYS;
      // storeys (v counts storeys; the texture repeats)
      quad([x0, ground, z0, u0, v0, wall], [x1, ground, z1, u1, v0, wall], [x1, bld.t, z1, u1, v1, wall], [x0, bld.t, z0, u0, v1, wall]);
      // plinth: the bit of wall below the first storey where the street drops away downhill
      if (bld.b < plinth - 0.05) {
        c.copy(wall).multiplyScalar(0.72);
        quad([x0, bld.b, z0, ...PLAIN, c], [x1, bld.b, z1, ...PLAIN, c], [x1, plinth, z1, ...PLAIN, c], [x0, plinth, z0, ...PLAIN, c]);
      }
    }
    // roof
    if (bld.h > 0 && n === 4) {
      // hipped: ridge along the long axis, inset half the short side at each end
      const P = [0, 1, 2, 3].map((k) => new THREE.Vector2(p[k * 2], p[k * 2 + 1]));
      const long = P[0].distanceTo(P[1]) >= P[1].distanceTo(P[2]) ? 0 : 1; // edge 0-1 (and 2-3) are the long sides?
      const [A, B, C, D] = long === 0 ? P : [P[1], P[2], P[3], P[0]];  // A-B and C-D long
      const mAD = A.clone().add(D).multiplyScalar(0.5), mBC = B.clone().add(C).multiplyScalar(0.5);
      const half = A.distanceTo(D) / 2, L = mAD.distanceTo(mBC);
      const t = Math.min(half, L / 2 - 0.01) / L;
      const r1 = mAD.clone().lerp(mBC, t), r2 = mBC.clone().lerp(mAD, t), y1 = bld.t + bld.h;
      const E = (v, y = bld.t) => [v.x, y, v.y, ...PLAIN, roof];
      // eaves overhang a little
      const o = (v, from) => v.clone().sub(from).multiplyScalar(1.06).add(from);
      const ctr = A.clone().add(B).add(C).add(D).multiplyScalar(0.25);
      const [a, b, cc, d] = [A, B, C, D].map((v) => o(v, ctr));
      const ridge1 = E(r1, y1), ridge2 = E(r2, y1);
      quad(E(a), E(b), ridge2, ridge1);       // long side
      quad(E(cc), E(d), ridge1, ridge2);      // other long side
      for (const q of [[E(d), E(a), ridge1], [E(b), E(cc), ridge2]]) for (const v of q) vert(...v); // hips
      // underside of the overhang, so it isn't see-through from below
      for (const q of [[E(a), E(d), E(cc)], [E(a), E(cc), E(b)]]) for (const v of q) vert(...v);
    } else {
      const shape = [];
      for (let i = 0; i < n; i++) shape.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]));
      c.copy(roof);
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(shape, [])) {
        for (const m of [i, k, j]) vert(shape[m].x, bld.t, shape[m].y, ...PLAIN, c); // CCW in x/z faces up as i,k,j
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals(); // non-indexed: flat faces
  const { map, emissiveMap } = windowTextures();
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true, map, emissiveMap, emissive: day ? 0x000000 : 0xffffff, emissiveIntensity: day ? 0 : 1.1,
    side: THREE.DoubleSide, // footprint winding varies; cheaper than fixing every wall
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'buildings';
  group.add(mesh);
  return group;
}

// ---------------------------------------------------------------- bridges

/** Concrete under each deck span in `course.bridges` ([[s0, s1], ...] metres of s): a solid slab the width of the road (it
 *  casts the shadow into the valley), an open-spandrel arch under the middle of the span (a pair of ribs springing from the
 *  ground), and columns from the arch, or straight from the ground where the valley is shallow, up to the deck. */
export function buildBridges(path, course, heightAt) {
  const group = new THREE.Group(); group.name = 'bridges';
  const spans = course.bridges || [];
  if (!spans.length) return group;
  const half = path.half, W = half * 2 + 1.0, SLAB = 1.3, RIB = 1.6, COL = 1.4;
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

// ---------------------------------------------------------------- tunnels

// SQUASH: the arch is an ellipse this much lower than it is wide (a full semicircle over a 9 m road is ~6 m tall and pokes out of thin hills)
const TUN = { WALL: 1.5, EXT: 4, CUT: 14, FRAME: 1.1, DEPTH: 1.4, SQUASH: 0.7 };

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

/** Patch a terrain material so it discards the surface inside each portal's arch-shaped volume (CUT metres into the hill). The
 *  terrain is a 6 m heightfield, so where it climbs over the road it can only make a ramp across the opening; this opens it. */
function cutPortals(mat, portals) {
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
  if (al > -0.5 && al < uPB[i].z) {
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
