// ?garage: turntable viewer for every car in models/cars.json. ←/→ (or D-pad/L1/R1) switch cars. Each car is a real
// CarRig, so P switches the lights (headlights with their beams, tail lights; the 86's pop-ups) on every car, B the
// brake lights, N between night and the bright studio.
// Debug params: ?car=<id> · ?cam=side|front|rear|top|closeup|hood|mirror|spoiler · ?pop (start with the lights on) · ?brake (start braking: brake lights, discs heating) · ?day (studio) · ?still · ?popangle=<rad> · ?campos=x,y,z&look=x,y,z · ?twosided (draw both faces: shows up inside-out triangles)
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Gamepads } from './game/gamepad.js';
import { CarRig } from './game/car.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);
const hud = document.getElementById('hud');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x141826);
scene.fog = new THREE.Fog(0x141826, 12, 30);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 200);
camera.position.set(-5.5, 2.4, -5.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.6, 0);
controls.enableDamping = true;

const sky = new THREE.HemisphereLight(0xbfd4ff, 0x30281e, 1.2);
scene.add(sky);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-4, 8, -3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.03;
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 });
scene.add(sun);

const ground = new THREE.Mesh(new THREE.CircleGeometry(12, 48), new THREE.MeshStandardMaterial({ color: 0x2a2e38, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const params = new URLSearchParams(location.search);
const CAMS = {
  closeup: [[-2.6, 1.0, -2.2], [0, 0.7, -1.6]],
  hood: [[-1.5, 1.7, -3.3], [0.4, 0.68, -1.8]], // the AE86's pop-ups, from above the front corner
  mirror: [[-1.9, 1.25, -1.4], [-0.8, 0.9, -0.3]], // the left door mirror, from ahead of it
  spoiler: [[-1.5, 1.25, 2.9], [-0.65, 0.9, 1.95]], // the left end of the rear wing, from behind
  side: [[-7, 1.2, 0]], front: [[0, 1.4, -7]], rear: [[0, 1.4, 7]], top: [[0, 9, 0.01]],
};
const cam = CAMS[params.get('cam')];
if (cam) { camera.position.set(...cam[0]); if (cam[1]) controls.target.set(...cam[1]); }
const vec = (k) => params.get(k)?.split(',').map(Number);
if (vec('campos')) camera.position.set(...vec('campos'));
if (vec('look')) controls.target.set(...vec('look'));

const cars = await fetch('models/cars.json').then((r) => r.json());
const ids = Object.keys(cars);
let index = Math.max(0, ids.indexOf(params.get('car') || 'ae86'));
let rig = null;
let lightsOn = params.has('pop'), braking = params.has('brake'), night = !params.has('day'), spinning = !params.has('still');
const loader = new GLTFLoader();
const loaded = new Map(); // id → Promise<gltf scene>, so flicking back and forth doesn't refetch

function load(id) {
  if (!loaded.has(id)) {
    loaded.set(id, loader.loadAsync(cars[id].file).then((gltf) => {
      if (params.has('twosided')) gltf.scene.traverse((o) => { if (o.isMesh) o.material.side = THREE.DoubleSide; });
      const r = new CarRig(id, gltf, cars[id], { scene, beams: 0.045, shadow: true });
      if (params.has('popangle')) r.popupDown = +params.get('popangle');
      r.castShadows();
      r.setShadow(true);
      r.poseBasis(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
      if (r.popups) r.popups.rotation.x = lightsOn ? 0 : r.popupDown;
      return r;
    }));
  }
  return loaded.get(id);
}

async function show(i) {
  index = (i + ids.length) % ids.length;
  const id = ids[index], spec = cars[id];
  drawHud();
  const next = await load(id);
  if (ids[index] !== id) return; // switched again while this one was loading
  if (rig) scene.remove(rig.root);
  rig = next;
  rig.setSky(!night);
  scene.add(rig.root);
  drawHud();
  load(ids[(index + 1) % ids.length]); // warm up the next one
  window.car = rig.root; window.rig = rig; // handy for poking at in devtools
}

function drawHud() {
  const spec = cars[ids[index]];
  if (!spec) return;
  hud.innerHTML = `<b style="font-size:18px">${spec.name}</b> <span style="opacity:.6">${index + 1}/${ids.length}</span><br>`
    + `<span style="opacity:.6;font-size:11px">${spec.credit}</span><br>`
    + `<b>←/→</b> car · drag to orbit · <b>P</b> lights ${lightsOn ? 'on' : 'off'} · <b>B</b> brakes · <b>N</b> ${night ? 'night' : 'studio'} · <b>Space</b> spin wheels`;
}

const act = {
  prev: () => show(index - 1),
  next: () => show(index + 1),
  pop: () => { lightsOn = !lightsOn; drawHud(); },
  brake: () => { braking = !braking; },
  night: () => { night = !night; setNight(); drawHud(); },
  spin: () => { spinning = !spinning; },
};
const KEYS = { ArrowLeft: 'prev', KeyA: 'prev', ArrowRight: 'next', KeyD: 'next', KeyP: 'pop', KeyB: 'brake', KeyN: 'night', Space: 'spin' };
addEventListener('keydown', (e) => { if (KEYS[e.code]) { e.preventDefault(); act[KEYS[e.code]](); } });
const PAD = { LEFT: 'prev', L1: 'prev', RIGHT: 'next', R1: 'next', X: 'pop', B: 'brake', Y: 'night', A: 'spin' };
const pads = new Gamepads((b) => PAD[b] && act[PAD[b]]());

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// night: a dim moonlit garage, so the lights show; studio: bright, for looking at the models
function setNight() {
  sky.intensity = night ? 0.15 : 1.2;
  sun.intensity = night ? 0.35 : 2.2;
  scene.background.set(night ? 0x07090f : 0x141826);
  scene.fog.color.copy(scene.background);
  rig?.setSky(!night);
}
setNight();

await show(index);
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  pads.poll();
  rig.popupsUp = rig.lightsOn = lightsOn;
  rig.braking = braking;
  rig.animate(dt, spinning ? 6 * rig.spec.wheel_radius : 0); // wheels roll forward at 6 rad/s
  if (braking) rig.discHeat = Math.min(1.1, rig.discHeat + dt * 1.5); // B also heats the brake discs (if it has any)
  controls.update();
  renderer.render(scene, camera);
});
