// The terrain mesh: faceted heightfield with per-site ground tints, and the tunnel portals cut out of it.
import * as THREE from 'three';
import { rng } from './track.js';
import { cutPortals } from './structures.js';

export function buildTerrain(course, portals = []) {
  const { nx, nz, x0, z0, cell } = course.terrain;
  const H = course.heights;
  const cells = (nx - 1) * (nz - 1);
  const pos = new Float32Array(cells * 18), col = new Float32Array(cells * 18);
  const r = rng(42);
  const G = course.ground || null;                      // per-site scrub / rock tints (fly-over sites); Japan has none
  const gScrub = G && new THREE.Color(G.scrub), gRock = G && new THREE.Color(G.rock), gGreen = G && new THREE.Color(G.green), gSand = G?.sand && new THREE.Color(G.sand), gSnow = G?.snow && new THREE.Color(G.snow.color || '#eef2f6');
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
      if (gSnow) {                                      // snow above a ragged line, clinging to gentle slopes and mostly shed by steep rock
        const S = G.snow, line = S.above + (vnoise(cx / 160, cz / 160) - 0.5) * S.band;
        const hold = 0.15 + 0.85 * THREE.MathUtils.clamp((flat - S.flat) / 0.25, 0, 1);
        c.lerp(gSnow, THREE.MathUtils.smoothstep(h, line, line + S.band * 0.5) * hold);
      }
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
