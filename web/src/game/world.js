// Renderer, scene, lighting and the mountain. Shared by the fly-by (and anything else that needs the course).
import * as THREE from 'three';
import { applyWeather } from './weather.js';
import { loadCourse, TrackPath, makeHeightAt, buildRoad, buildGuardrails, gutterFlags, buildGutters, buildTerrain, buildForest, buildUndergrowth, buildBuildings, buildBridges, buildTunnels, tunnelPortals } from '../course/track.js';

// `shadows`: get the scene ready for headlight shadows (see castShadows below). Free until a car's shadow spot is
// switched on (CarRig setShadow): three.js only draws shadow maps for lights that cast them.
export async function createWorld({ site = null, day = false, weather = 'clear', undergrowth = true, forest = {}, shadows = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const sky = day ? 0x9cc3e6 : 0x0a0620;
  scene.background = new THREE.Color(sky);
  scene.fog = new THREE.FogExp2(sky, day ? 0.0012 : 0.0045);
  const hemi = new THREE.HemisphereLight(day ? 0xdfeaff : 0x34426a, day ? 0x3a3020 : 0x0b0b12, day ? 1.6 : 0.9);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(day ? 0xfff4e0 : 0x9fb0ff, day ? 2.6 : 0.5);
  moon.position.set(-0.4, 1, 0.6).multiplyScalar(1000);
  scene.add(moon);

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.3, 6000);
  const onResize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  };
  addEventListener('resize', onResize);

  const course = await loadCourse(site ? `track/${site}/` : 'track/');
  const path = new TrackPath(course);
  const heightAt = makeHeightAt(course);
  const road = buildRoad(path);
  const gutters = gutterFlags(path, course, heightAt);
  scene.add(buildTerrain(course, tunnelPortals(path, course)), road, buildBridges(path, course, heightAt), buildTunnels(path, course), buildGuardrails(path, course), buildGutters(path, gutters),
  buildForest(path, heightAt, { ...forest, ...course.forest, buildings: course.buildings }), buildBuildings(course.buildings, { day: day }));
  if (course.sea != null) { // sea level (course.json `sea`, metres): a flat translucent sheet over the whole terrain; the DEM's bay lies below it
    const { nx, nz, x0, z0, cell } = course.terrain;
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(nx * cell, nz * cell).rotateX(-Math.PI / 2), seaMaterial(day));
    sea.position.set(x0 + nx * cell / 2, course.sea, z0 + nz * cell / 2);
    sea.name = 'sea';
    sea.renderOrder = 1; // after the opaque world, so the shallows show the sand through it
    scene.add(sea);
  }
  if (undergrowth) scene.add(buildUndergrowth(path, heightAt, { buildings: course.buildings }));
  if (shadows) castShadows(renderer, scene);

  const idxAt = (s) => Math.round(THREE.MathUtils.clamp(s / path.step, 0, path.n - 1));
  /** Is there a guardrail on `side` (-1 left, +1 right) at distance s? */
  const railAt = (side, s) => (side < 0 ? course.rail_left : course.rail_right)[idxAt(s)] === '1';
  /** Is there a drainage gutter on `side` at distance s? */
  const gutterAt = (side, s) => (side < 0 ? gutters.left : gutters.right)[idxAt(s)] === 1;

  const wx = applyWeather({ scene, renderer, road, day, kind: weather });
  const terrain = scene.getObjectByName('terrain');
  const moonShadow = shadows ? new MoonShadow(scene, moon, hemi, { day, overcast: !!(wx.fog || wx.rain), renderer, course, terrain }) : null;
  /** Throw the whole world away (swapping place without reloading the page): GPU memory, the canvas and its GL context. */
  const dispose = () => {
    removeEventListener('resize', onResize);
    renderer.setAnimationLoop(null);
    const seen = new Set();
    scene.traverse((o) => {
      o.geometry?.dispose();
      o.shadow?.map?.dispose();
      for (const m of [].concat(o.material || [])) {
        for (const v of Object.values(m)) if (v?.isTexture && !seen.has(v)) { seen.add(v); v.dispose(); }
        m.dispose();
      }
    });
    moonShadow?._rt?.dispose();
    scene.clear();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  return { renderer, scene, camera, course, path, heightAt, railAt, gutterAt, day, weather: wx, shadows, moonShadow, dispose };
}

// Moon shadows come from two maps: a coarse one of the whole mountain, drawn once (nothing it shades ever moves), and
// at the higher setting a sharp one in a square that follows the camera (`MoonShadow.R`), which fades out towards
// the edge of its square. The darker of the two wins, so near things get crisp shadows and everything else still
// gets one. Patched into three's lighting chunk: the moon (directional light 0) holds the whole-mountain map, and the
// sharp square belongs to a twin that gives no light of its own (light 1, sorted after the moon because it's added
// to the scene later). Has to happen before any material compiles.
const SHADOW_LINE = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
const S1 = 'directionalLightShadows[ 1 ]';
THREE.ShaderChunk.lights_fragment_begin = THREE.ShaderChunk.lights_fragment_begin.replace(SHADOW_LINE, `
		#if NUM_DIR_LIGHT_SHADOWS > 1 && UNROLLED_LOOP_INDEX == 0
		if ( directLight.visible && receiveShadow ) {
			float moonWhole = getShadow( directionalShadowMap[ 0 ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ 0 ] );
			float moonNear = mix( getShadow( directionalShadowMap[ 1 ], ${S1}.shadowMapSize, ${S1}.shadowIntensity, ${S1}.shadowBias, ${S1}.shadowRadius, vDirectionalShadowCoord[ 1 ] ), 1.0,
				smoothstep( 0.3, 0.48, max( abs( vDirectionalShadowCoord[ 1 ].x - 0.5 ), abs( vDirectionalShadowCoord[ 1 ].y - 0.5 ) ) ) );
			directLight.color *= min( moonWhole, moonNear );
		}
		#elif NUM_DIR_LIGHT_SHADOWS > 1 && UNROLLED_LOOP_INDEX == 1
		// the sharp square's own light gives no light: nothing to shade
		#else
		${SHADOW_LINE}
		#endif`);
if (!THREE.ShaderChunk.lights_fragment_begin.includes('moonWhole')) console.warn('moon shadows: three.js lighting chunk changed, not patched');

/** Shadows from the moon. set(1): the whole mountain, coarse (about a metre a texel), drawn once when switched on; the
 *  ground casts in it too, so ridges shade the valleys behind them. Costs one texture read per pixel after that.
 *  set(2): plus a sharp square that follows the camera (centred where you're looking), redrawn every frame, for the
 *  cars and anything close. At night the moon is turned up and the sky light down while either is on, or they'd be
 *  too faint to see. Overcast nights (fog, rain) have no moon to cast them. */
class MoonShadow {
  static R = 100;          // half the sharp square, m
  static MAP = 2048;       // its shadow map texels across (~10 cm each)
  static WHOLE_MAP = 4096; // the whole mountain's (about a metre each)
  constructor(scene, moon, hemi, { day, overcast, renderer, course, terrain }) {
    this.moon = moon; this.hemi = hemi; this.day = day; this.overcast = overcast;
    this.scene = scene; this.renderer = renderer;
    this.dir = moon.position.clone().normalize();
    this.level = 0;
    this._c = new THREE.Vector3(); this._f = new THREE.Vector3();

    // The ground casts only into the whole-mountain map, so only while that's drawn (see _bake): it's one big mesh,
    // and drawing it into the sharp square and the headlights every frame would cost more than the rest of the scene.
    // It's a single sheet with no back, so it casts from its front (three's default is the back faces).
    this.terrain = terrain;
    terrain.material.shadowSide = THREE.FrontSide;
    this._wholeMountain(course);
    this.bake = false;

    // the sharp square: a light that gives no light, aimed like the moon, moved along with the camera
    const { R, MAP } = MoonShadow;
    const near = this.near = new THREE.DirectionalLight(0xffffff, 0);
    const cam = near.shadow.camera;
    Object.assign(cam, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 1200 });
    cam.updateProjectionMatrix();
    near.shadow.mapSize.set(MAP, MAP);
    near.shadow.bias = -0.0005;
    near.shadow.normalBias = 0.05;
    scene.add(near, near.target);
    // light-space axes, for snapping the square to whole texels (or the shadows shimmer as it moves)
    this.ax = new THREE.Vector3().crossVectors(this.dir, new THREE.Vector3(0, 0, 1)).normalize();
    this.ay = new THREE.Vector3().crossVectors(this.ax, this.dir).normalize();
    this.texel = (2 * R) / MAP;
  }

  /** Aim the moon at the middle of the mountain from far off and fit its shadow camera round all of it. */
  _wholeMountain(course) {
    const { moon } = this;
    const { nx, nz, x0, z0, cell } = course.terrain;
    let y0 = Infinity, y1 = -Infinity;
    for (const h of course.heights) { if (h < y0) y0 = h; if (h > y1) y1 = h; }
    y1 += 60; // trees and buildings on the top
    const x1 = x0 + (nx - 1) * cell, z1 = z0 + (nz - 1) * cell;
    const mid = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    moon.target.position.copy(mid);
    moon.position.copy(mid).addScaledVector(this.dir, 5000); // same direction, so the light doesn't change
    this.scene.add(moon.target);
    moon.updateMatrixWorld(); moon.target.updateMatrixWorld();
    const sh = moon.shadow, cam = sh.camera;
    sh.updateMatrices(moon); // aims its camera, so the mountain's corners can be measured in it
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = lo.clone().negate(), v = new THREE.Vector3();
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) {
      v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
      lo.min(v); hi.max(v);
    }
    Object.assign(cam, { left: lo.x, right: hi.x, bottom: lo.y, top: hi.y, near: -hi.z - 10, far: -lo.z + 10 });
    cam.updateProjectionMatrix();
    const size = Math.min(MoonShadow.WHOLE_MAP, this.renderer.capabilities.maxTextureSize);
    sh.mapSize.set(size, size);
    sh.bias = -0.0004;
    sh.normalBias = 1.2;
    sh.autoUpdate = false; // drawn once (bake), then left alone
  }

  get available() { return !this.overcast; }
  /** 0 none · 1 the whole mountain · 2 plus the sharp square near the camera. */
  set(level) {
    level = this.overcast ? 0 : level;
    if (level === this.level) return;
    const was = this.level > 0, on = level > 0;
    this.level = level;
    this.moon.castShadow = on;
    this.near.castShadow = level >= 2;
    if (on && !this.baked) this.bake = this.baked = true; // once: three keeps the map while it's switched off
    if (this.day || on === was) return;
    // scaled rather than set, so it stacks with whatever else has turned the lights up or down (the drone does)
    this.moon.intensity *= on ? 2.6 : 1 / 2.6;
    this.hemi.intensity *= on ? 0.65 : 1 / 0.65;
  }

  /** Draw the whole-mountain map: one render with every vegetation chunk showing (they normally hide past the fog). */
  _bake(camera) {
    const { scene, renderer } = this;
    const before = scene.onBeforeRender;
    scene.onBeforeRender = function (...args) {
      before.apply(this, args);
      scene.traverse((o) => { if (o.parent?.userData.hooked) o.visible = true; });
    };
    this.moon.shadow.needsUpdate = true;
    this.terrain.castShadow = true;
    this._rt ||= new THREE.WebGLRenderTarget(1, 1);
    const target = renderer.getRenderTarget();
    renderer.setRenderTarget(this._rt);
    const t0 = performance.now();
    renderer.render(scene, camera);
    renderer.setRenderTarget(target);
    scene.onBeforeRender = before;
    this.terrain.castShadow = false;
    this.bakeMs = performance.now() - t0;
  }

  /** Call before render. The square sits on `focus` if given (where a drone's looking), else a bit ahead of the camera. */
  follow(camera, focus = null) {
    if (this.bake) { this.bake = false; this._bake(camera); }
    if (this.level < 2) return;
    const c = this._c;
    if (focus) c.copy(focus);
    else {
      const f = camera.getWorldDirection(this._f); f.y = 0;
      if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
      c.copy(camera.position).addScaledVector(f.normalize(), MoonShadow.R * 0.55);
    }
    // snap across the light to the texel grid; along the light it doesn't matter
    const t = this.texel, a = Math.round(c.dot(this.ax) / t) * t, b = Math.round(c.dot(this.ay) / t) * t, d = c.dot(this.dir);
    c.copy(this.ax).multiplyScalar(a).addScaledVector(this.ay, b).addScaledVector(this.dir, d);
    this.near.target.position.copy(c);
    this.near.position.copy(c).addScaledVector(this.dir, 600);
  }
}

/** Who casts and who receives. Trees, rails and buildings cast (the trees also shade each other); the ground only
 *  receives, and the undergrowth too: there's lots of it and it's low, so casting isn't worth a shadow pass. */
function castShadows(renderer, scene) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const CAST = new Set(['forest', 'guardrails', 'buildings', 'bridges']);
  for (const top of scene.children) {
    const cast = CAST.has(top.name);
    top.traverse((o) => {
      if (!o.isMesh) return;
      o.receiveShadow = true;
      o.castShadow = cast;
    });
  }
}


// The sea: translucent (more so looking straight down, glassier at a grazing angle), shiny, and its normal is a sum of
// travelling sine waves, so the moon / sun glints and breaks up as the water moves. Waves are in the normal only; the sheet stays flat.
function seaMaterial(day) {
  const mat = new THREE.MeshPhongMaterial({
    color: day ? 0x2f9298 : 0x0d3a42, specular: day ? 0xffffff : 0x9db8ff, shininess: 90,
    emissive: day ? 0x000000 : 0x03101a, transparent: true, opacity: 0.8, depthWrite: false,
  });
  const time = { value: 0 };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.seaTime = time;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSea;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vSea = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vSea;
uniform float seaTime;
// slope of a few crossing waves: amplitude, wavelength (m), direction (rad), speed (rad/s)
vec2 wave(vec2 p, float a, float len, float dir, float sp) {
  float k = 6.2831853 / len;
  vec2 d = vec2(cos(dir), sin(dir));
  return d * a * k * cos(dot(p, d) * k + seaTime * sp);
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  {
    vec2 p = vSea.xz, g = vec2(0.0);
    g += wave(p, 0.55, 52.0, 0.4, 0.8) + wave(p, 0.38, 29.0, 1.9, 1.1) + wave(p, 0.16, 15.0, -0.9, 1.5) + wave(p, 0.05, 8.0, 2.7, 2.0);
    vec3 nw = normalize(vec3(-g.x, 1.0, -g.y));
    normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
    float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
    diffuseColor.a = mix(0.45, 0.92, fres);
  }`);
  };
  const t0 = performance.now();
  mat.onBeforeRender = () => { time.value = (performance.now() - t0) / 1000; };
  return mat;
}
