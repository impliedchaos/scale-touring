// Buildings: OSM footprints from tools/build_buildings.py as one merged mesh, with windows that light at night.
import * as THREE from 'three';
import { rng } from './track.js';

// Window texture: an 8×8 grid of bays, one bay per window per storey. The colour map is wall (white, tinted by
// the vertex colour) with a dark pane; the emissive map lights about a third of the panes warm, for night.
const BAYS = 8;
// `style` picks the pane layout (data.style.windows): the default sash window, wide sliding-glass bands (Japan), a narrow window
// between shutters (the Alps), or a small deep-set one in a pale frame (the south-west).
const PANES = {
  default: { x: 0.25, y: 0.26, w: 0.5, h: 0.44 },
  bands: { x: 0.08, y: 0.3, w: 0.84, h: 0.3 },
  shutters: { x: 0.33, y: 0.22, w: 0.34, h: 0.5 },
  deep: { x: 0.33, y: 0.3, w: 0.34, h: 0.34 },
};
function windowTextures(style = 'default') {
  const N = 512, cell = N / BAYS, r = rng(7), P = PANES[style] || PANES.default;
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = N; return c; };
  const col = mk(), emi = mk(), a = col.getContext('2d'), e = emi.getContext('2d');
  a.fillStyle = '#ffffff'; a.fillRect(0, 0, N, N);
  e.fillStyle = '#000000'; e.fillRect(0, 0, N, N);
  for (let i = 0; i < BAYS; i++) for (let j = 0; j < BAYS; j++) {
    const x = i * cell + cell * P.x, y = j * cell + cell * P.y, w = cell * P.w, h = cell * P.h;
    if (style === 'shutters') {   // a leaf each side, in the weathered brown of the timber
      a.fillStyle = '#7a5538';
      a.fillRect(x - w * 0.42, y, w * 0.4, h); a.fillRect(x + w * 1.02, y, w * 0.4, h);
    } else if (style === 'deep') { // a pale painted frame round the opening
      a.fillStyle = '#a9d8cf'; const m = cell * 0.035; a.fillRect(x - m, y - m, w + m * 2, h + m * 2);
    }
    a.fillStyle = '#39424f'; a.fillRect(x, y, w, h);
    a.fillStyle = '#5d6877'; a.fillRect(x, y, w, h * 0.18); // a bit of sky in the glass
    if (style === 'bands') { a.fillStyle = '#8a929c'; for (const t of [1 / 3, 2 / 3]) a.fillRect(x + w * t - 1, y, 2, h); }
    if (style === 'deep') { a.fillStyle = 'rgba(0,0,0,.35)'; a.fillRect(x, y, w, h * 0.3); }   // the reveal's shadow
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
 * per storey, a plain plinth below the ground floor (hillsides), and flat, parapeted, hipped or gabled roofs. A building's
 * `k` is its roof kind (0 flat, 1 hipped, 2 gabled, 3 flat with a parapet; without one, hipped when it has a rise), `q` the
 * rectangle the roof covers, `u` the wall colour above `sp` metres, and `v` asks for beam ends along the roofline.
 */
export function buildBuildings(data, { day = false } = {}) {
  const group = new THREE.Group();
  group.name = 'buildings';
  if (!data?.buildings?.length) return group;
  const FLOOR = data.floor || 3.1, BAY = 3.6;
  const pos = [], uv = [], col = [];
  const PLAIN = [0.02 / BAYS, 0.02 / BAYS]; // a texel of bare wall, for plinths and roofs
  const c = new THREE.Color(), r = rng(31), VIGA = new THREE.Color('#5a3d2a');
  const vert = (x, y, z, u, v, color) => { pos.push(x, y, z); uv.push(u, v); col.push(color.r, color.g, color.b); };
  const quad = (a, b, cc, d) => { for (const q of [a, b, cc, a, cc, d]) vert(...q); };

  const ST = data.style || {}, EAVE = ST.eave, PARAPET = ST.parapet ?? 0.4;

  for (const bld of data.buildings) {
    const p = bld.p, n = p.length / 2;
    const wall = new THREE.Color(bld.w), roof = new THREE.Color(bld.r), upper = bld.u ? new THREE.Color(bld.u) : wall;
    const ground = bld.t - bld.f * FLOOR;                  // where the first storey starts
    const plinth = Math.min(ground, bld.t);
    const uo = Math.floor(r() * BAYS), vo = Math.floor(r() * BAYS); // a different lit pattern per building
    const kind = bld.k ?? (bld.h > 0 ? 1 : 0);
    const split = bld.u ? ground + bld.sp : null;           // two-tone: the wall changes material here
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
      if (split === null) {
        quad([x0, ground, z0, u0, v0, wall], [x1, ground, z1, u1, v0, wall], [x1, bld.t, z1, u1, v1, wall], [x0, bld.t, z0, u0, v1, wall]);
      } else {
        const vs = v0 + (bld.sp / FLOOR) / BAYS;
        quad([x0, ground, z0, u0, v0, wall], [x1, ground, z1, u1, v0, wall], [x1, split, z1, u1, vs, wall], [x0, split, z0, u0, vs, wall]);
        quad([x0, split, z0, u0, vs, upper], [x1, split, z1, u1, vs, upper], [x1, bld.t, z1, u1, v1, upper], [x0, bld.t, z0, u0, v1, upper]);
      }
      // plinth: the bit of wall below the first storey where the street drops away downhill
      if (bld.b < plinth - 0.05) {
        c.copy(wall).multiplyScalar(0.72);
        quad([x0, bld.b, z0, ...PLAIN, c], [x1, bld.b, z1, ...PLAIN, c], [x1, plinth, z1, ...PLAIN, c], [x0, plinth, z0, ...PLAIN, c]);
      }
      if (kind === 3) {   // parapet: the wall carries on up past the roof (seen from inside as well, the material is double-sided)
        c.copy(upper).multiplyScalar(0.94);
        quad([x0, bld.t, z0, ...PLAIN, c], [x1, bld.t, z1, ...PLAIN, c], [x1, bld.t + PARAPET, z1, ...PLAIN, c], [x0, bld.t + PARAPET, z0, ...PLAIN, c]);
      }
      if (bld.v && len > 5) {   // vigas: the roof beams' round ends sticking out of the wall, every 1.3 m just under the parapet
        const nx = (z1 - z0) / len, nz = -(x1 - x0) / len, tx = (x1 - x0) / len, tz = (z1 - z0) / len;   // outward (the footprints run CCW) and along
        for (let d = 0.9; d < len - 0.6; d += 1.3) {
          const bx = x0 + tx * d, bz = z0 + tz * d, y0 = bld.t - 0.38, y1 = bld.t - 0.2, hw = 0.07, out = 0.4;
          const A = (a, y, o) => [bx + tx * a + nx * o, y, bz + tz * a + nz * o, ...PLAIN, VIGA];
          quad(A(-hw, y1, 0), A(hw, y1, 0), A(hw, y1, out), A(-hw, y1, out));         // top
          quad(A(-hw, y0, out), A(hw, y0, out), A(hw, y0, 0), A(-hw, y0, 0));         // underside
          quad(A(-hw, y0, 0), A(-hw, y0, out), A(-hw, y1, out), A(-hw, y1, 0));       // sides
          quad(A(hw, y0, out), A(hw, y0, 0), A(hw, y1, 0), A(hw, y1, out));
          quad(A(-hw, y0, out), A(hw, y0, out), A(hw, y1, out), A(-hw, y1, out));     // the end
        }
      }
    }
    // roof
    const corners = bld.q ? [0, 1, 2, 3].map((k) => new THREE.Vector2(bld.q[k * 2], bld.q[k * 2 + 1])) : n === 4 ? [0, 1, 2, 3].map((k) => new THREE.Vector2(p[k * 2], p[k * 2 + 1])) : null;
    if (kind === 2 && corners && bld.h > 0) {
      // gabled: ridge along the long side (corners run A-B long), the gable ends are wall up to the ridge, the eaves overhang
      const [A, B, C, D] = corners;
      const u = B.clone().sub(A), w = D.clone().sub(A), lu = u.length(), lw = w.length();
      u.divideScalar(lu); w.divideScalar(lw);
      const eave = EAVE ?? 0.5, gable = eave * 0.5, slope = bld.h / (lw / 2), y1 = bld.t + bld.h, ye = bld.t - slope * eave;
      const P = (x, z, y, col = roof) => [x, y, z, ...PLAIN, col];
      const at = (base, a, b) => base.clone().addScaledVector(u, a).addScaledVector(w, b);
      const A2 = at(A, -gable, -eave), B2 = at(B, gable, -eave), C2 = at(C, gable, eave), D2 = at(D, -gable, eave);
      const m1 = at(A, -gable, lw / 2), m2 = at(B, gable, lw / 2);
      quad(P(A2.x, A2.y, ye), P(B2.x, B2.y, ye), P(m2.x, m2.y, y1), P(m1.x, m1.y, y1));
      quad(P(C2.x, C2.y, ye), P(D2.x, D2.y, ye), P(m1.x, m1.y, y1), P(m2.x, m2.y, y1));
      const g1 = at(A, 0, lw / 2), g2 = at(B, 0, lw / 2);                      // the triangular gable ends
      for (const [a, b, top] of [[D, A, g1], [B, C, g2]]) for (const v of [P(a.x, a.y, bld.t, upper), P(b.x, b.y, bld.t, upper), P(top.x, top.y, y1, upper)]) vert(...v);
    } else if (kind === 1 && corners && bld.h > 0) {
      // hipped: ridge along the long axis, inset half the short side at each end
      const long = corners[0].distanceTo(corners[1]) >= corners[1].distanceTo(corners[2]) ? 0 : 1; // edge 0-1 (and 2-3) are the long sides?
      const [A, B, C, D] = long === 0 ? corners : [corners[1], corners[2], corners[3], corners[0]];  // A-B and C-D long
      const mAD = A.clone().add(D).multiplyScalar(0.5), mBC = B.clone().add(C).multiplyScalar(0.5);
      const half = A.distanceTo(D) / 2, L = mAD.distanceTo(mBC);
      const t = Math.min(half, L / 2 - 0.01) / L;
      const r1 = mAD.clone().lerp(mBC, t), r2 = mBC.clone().lerp(mAD, t), y1 = bld.t + bld.h;
      const E = (v, y = bld.t) => [v.x, y, v.y, ...PLAIN, roof];
      // eaves overhang a little
      const ctr = A.clone().add(B).add(C).add(D).multiplyScalar(0.25);
      const o = (v) => EAVE ? v.clone().add(v.clone().sub(ctr).normalize().multiplyScalar(EAVE * 1.2)) : v.clone().sub(ctr).multiplyScalar(1.06).add(ctr);
      const [a, b, cc, d] = [A, B, C, D].map(o);
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
  const { map, emissiveMap } = windowTextures(ST.windows);
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true, map, emissiveMap, emissive: day ? 0x000000 : 0xffffff, emissiveIntensity: day ? 0 : 1.1,
    side: THREE.DoubleSide, // footprint winding varies; cheaper than fixing every wall
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'buildings';
  group.add(mesh);
  return group;
}
