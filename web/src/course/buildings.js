// Buildings: OSM footprints from tools/build_buildings.py as one merged mesh, with windows that light at night.
import * as THREE from 'three';
import { rng } from './track.js';

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
