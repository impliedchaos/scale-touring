// Course loading and the road's centreline: TrackPath, terrain height lookup and the shared helpers the builders use.
// Data comes from tools/build_track.py and tools/build_site.py (see web/public/track/<site>/course.json).
// Frame: metres, x east, z south, y elevation. Driving "right" = forward × up.
// The meshes are built in road.js, terrain.js, vegetation.js, buildings.js and structures.js.
import * as THREE from 'three';

export async function loadCourse(base) {
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

/** (x, z) → within `min` metres of any leg of the road? Spatial hash over the centreline points. */
// `min` is a clearance from the course's centreline; side roads get the same clearance from their edge.
export function roadProximity(path, { sideRoads = true } = {}) {
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
