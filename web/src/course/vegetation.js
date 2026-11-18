// Vegetation: the forest (conifers, broadleaf, palms) and the roadside undergrowth, instanced in fog-culled chunks.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng, roadProximity } from './track.js';

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
export function buildForest(path, heightAt, { count = 14000, young = 6000, minRoad = 10, maxRoad = 320, wideBroadleaf = 0, wideBias = 1.6, roadsideBroadleaf = 9000, palms = 0, foliage = null, buildings = null, sparse: sparseSpec = null, snow = null } = {}) {
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
  const mat = snowy(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), snow, true);

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
  const groups = [...chunked(items, geo, mat, 250), ...chunked(broadleaves, broadleafGeo(paint), snowy(mottled(), snow, false), 250)];
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

/** Snow on tree crowns above the site's snow line (`ground.snow`, the same line the terrain uses, ragged the same way).
 *  Conifers (`conifer`) hold more toward the top of the crown and none on the trunk; other crowns get an even dusting.
 *  Patched in after the mottling so the snow isn't darkened by it. */
function snowy(mat, S, conifer) {
  if (!S) return mat;
  const prev = mat.onBeforeCompile, f = (n) => Number(n).toFixed(3), c = new THREE.Color(S.color || '#eef2f6');
  mat.onBeforeCompile = (sh) => {
    prev?.(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vSnow;')
      .replace('#include <project_vertex>', `#include <project_vertex>
  vec4 snw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    snw = instanceMatrix * snw;
  #endif
  vSnow = vec4((modelMatrix * snw).xyz, transformed.y);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vSnow;
float sH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sH(i), sH(i + vec2(1, 0)), f.x), mix(sH(i + vec2(0, 1)), sH(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
  {
    float line = ${f(S.above)} + (sN(vSnow.xz / 160.0) - 0.5) * ${f(S.band)};
    float amt = smoothstep(line, line + ${f(S.band * 0.5)}, vSnow.y);
    ${conifer ? 'float cover = smoothstep(1.7, 2.6, vSnow.w) * mix(0.3, 0.8, smoothstep(2.5, 6.5, vSnow.w));' : 'float cover = 0.5;'}
    float clump = 0.75 + 0.25 * sN(vSnow.xz * 1.3 + vSnow.y * 0.7);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${f(c.r)}, ${f(c.g)}, ${f(c.b)}), clamp(amt * cover * clump, 0.0, 1.0));
  }`);
  };
  mat.customProgramCacheKey = () => `snow${conifer ? 'c' : 'b'}${f(S.above)}${f(S.band)}${prev ? 'm' : ''}`;
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

/** Ground cover: solid low-poly bushes and dwarf-bamboo tufts over the whole terrain, thicker beside the road, and only
 *  ever built around the camera. The world is cut into `cell`-metre squares; the ones near the camera are generated on
 *  demand (the same plants every time: each square seeds its own RNG) and dropped again once the camera has left. Every
 *  plant also shrinks into the ground with its distance from the camera, so what's at the edge of the ring is already
 *  gone before a square is built or dropped, and nothing pops. It picks up snow like the trees (`snow` = `ground.snow`). */
export function buildUndergrowth(path, heightAt, { buildings = null, snow = null, colors = null, cell = 64, reach = 170 } = {}) {
  const inTown = townMask(buildings), nearRoad = roadProximity(path), town = townness(buildings);
  const bushHex = colors?.bush || 0x2a4a26, tuftHex = colors?.tuft || 0x3e5a24;     // `ground.bush` / `ground.tuft` in course.json: tumbleweeds in the desert
  const thin = colors?.brush ?? 1;                                                       // `ground.brush` in course.json: 0..1, sparser in the desert
  const BOOST = 3, DENSITY = { bush: 0.06, tuft: 0.15 };   // per m² away from the road; BOOST× within 20 m of it
  const fade = { value: new THREE.Vector2(100, reach) };
  const mat = fadeWithDistance(snowy(mottled({ vertexColors: false }), snow, false), fade); // same dappling as the broadleaf crowns
  const bushGeo = new THREE.IcosahedronGeometry(0.6, 0).translate(0, 0.45, 0);              // 20 tris
  const tuftGeo = new THREE.ConeGeometry(0.3, 0.8, 5, 1, true).translate(0, 0.4, 0);        // 5 tris
  const group = new THREE.Group();
  group.name = 'undergrowth';
  const cells = new Map();                                                                  // "i,j" → THREE.Group (maybe empty)

  const build = (ci, cj) => {
    const r = rng(Math.imul(ci, 73856093) ^ Math.imul(cj, 19349663) ^ 0x7f4a), g = new THREE.Group();
    // same colour pipeline as the trees (hex × tint) so the greens sit together, with a little hue wobble
    const shade = (hex, k) => new THREE.Color(hex).offsetHSL((r() - 0.5) * 0.04, 0, 0).multiplyScalar(k);
    for (const kind of ['bush', 'tuft']) {
      const bush = kind === 'bush', maxSlope = bush ? 7 : 9, list = [];
      for (let n = Math.round(cell * cell * DENSITY[kind] * BOOST * thin); n > 0; n--) {
        const x = (ci + r()) * cell, z = (cj + r()) * cell, boost = r() * BOOST;            // (always drawn, so a square stays the same)
        const h = heightAt(x, z);
        let keep = 1;
        if (sparse && h < sparse.below) continue;                                           // the coastal plain / the sea
        if (snow) keep -= 0.85 * THREE.MathUtils.smoothstep(h, snow.above + snow.band * 0.3, snow.above + snow.band); // buried higher up
        if (r() >= keep) continue;
        if (nearRoad(x, z, 5.2) || inTown(x, z)) continue;                                  // 1.5 m beyond the road edge: clear of gutter & rail
        if (boost > 1 && !nearRoad(x, z, 20)) continue;                                     // away from the road: a third of the tries
        if (buildings && r() < 0.8 * town(x, z)) continue;                                  // thinner towards town
        if (Math.abs(heightAt(x + 2, z) - heightAt(x - 2, z)) + Math.abs(heightAt(x, z + 2) - heightAt(x, z - 2)) > maxSlope) continue;
        if (bush) {
          const k = 0.6 + r() * 1.0;
          list.push({ m: placeAt(r, x, h - 0.15 * k, z, k * (0.8 + r() * 0.5), k * (0.55 + r() * 0.3), k * (0.8 + r() * 0.5)), c: shade(bushHex, 0.55 + r() * 0.4) }); // a shade under the tree crowns: their facets face the sky
        } else {
          const k = 0.6 + r() * 0.8, m = placeAt(r, x, h - 0.08, z, k, k * (0.7 + r() * 0.6), k);
          m.multiply(new THREE.Matrix4().makeRotationX((r() - 0.5) * 0.5));                 // lean a little, like grass does
          list.push({ m, c: shade(tuftHex, 0.6 + r() * 0.45) });                           // dwarf bamboo: a touch yellower
        }
      }
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(bush ? bushGeo : tuftGeo, mat, list.length);
      list.forEach((it, i) => { mesh.setMatrixAt(i, it.m); mesh.setColorAt(i, it.c); });
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true;                                                            // cells come after castShadows has run
      g.add(mesh);
    }
    return g;
  };

  let first = true;
  const update = (camera, fogCut) => {
    const end = THREE.MathUtils.clamp(fogCut, 50, reach), cx = camera.position.x, cz = camera.position.z;
    fade.value.set(end * 0.6, end);
    const range = end + cell * 0.7;                                                         // squares from here on are already fully shrunk
    const want = [];
    for (let i = Math.floor((cx - range) / cell); i <= Math.floor((cx + range) / cell); i++) {
      for (let j = Math.floor((cz - range) / cell); j <= Math.floor((cz + range) / cell); j++) {
        const d = Math.hypot((i + 0.5) * cell - cx, (j + 0.5) * cell - cz);
        if (d < range && !cells.has(`${i},${j}`)) want.push({ i, j, d });
      }
    }
    want.sort((a, b) => a.d - b.d);
    const budget = first ? Infinity : want.length > 12 ? 8 : 3;                             // all at once the first time, then a few a frame
    for (const { i, j } of want.slice(0, budget)) {
      const g = build(i, j);
      cells.set(`${i},${j}`, g);
      group.add(g);
    }
    first = false;
    for (const [k, g] of cells) {                                                           // let go of squares well behind us
      const [i, j] = k.split(',').map(Number);
      if (Math.hypot((i + 0.5) * cell - cx, (j + 0.5) * cell - cz) > range + cell * 1.5) {
        group.remove(g);
        g.children.forEach((m) => m.dispose?.());
        cells.delete(k);
      }
    }
  };
  // drive it from the scene's onBeforeRender (before three.js decides what to draw), chained like cullingGroup
  group.addEventListener('added', () => {
    const scene = group.parent;
    if (!scene?.isScene || group.userData.hooked) return;
    group.userData.hooked = true;
    const before = scene.onBeforeRender;
    scene.onBeforeRender = function (renderer, sc, camera, target) {
      before.call(this, renderer, sc, camera, target);
      const fog = sc.fog;
      update(camera, fog?.isFogExp2 ? FOG_GONE / fog.density : fog?.isFog ? fog.far : reach);
    };
  });
  return group;
}

/** Instances shrink into the ground between `fade.value.x` and `.y` metres from the camera (across the ground, not up). */
function fadeWithDistance(mat, fade) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh) => {
    prev?.(sh);
    sh.uniforms.uFade = fade;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uFade;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  #ifdef USE_INSTANCING
    transformed *= 1.0 - smoothstep(uFade.x, uFade.y, distance((modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xz, cameraPosition.xz));
  #endif`);
  };
  const key = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => `${key.call(mat)}fade`;
  return mat;
}

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
