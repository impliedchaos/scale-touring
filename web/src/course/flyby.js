// The fly-by (the default page): a drone flies over the course, a car drifts down the road and back up.
// Esc opens the options menu. Other keys: Space pause · [ ] pace · H hide the text · R restart.  Pad: START menu · A pause · L1/R1 pace · Y text.
// Options (course/options.js) come from the menu (remembered), and the URL overrides them for tests and screenshots:
//      ?site=rio|hk another place (tools/build_site.py) · ?day · ?weather=clear|wet|rain|fog|wetfog · ?uphill (start at the bottom)
//      ?car=<id>|none the car to chase (default ae86; none = the drone just flies the road) · ?tiltshift=0|1|2 miniature look off · blurred by screen height (estimated) · by scene depth (bare = 2)
//      ?shadows=0|1|2 off · headlights and the moon's, coarse · plus the moon's sharp near the camera (bare ?shadows = 2)
//      ?fps frame-rate counter
// Test-only:  ?s=<metres> start position · ?speed=<m/s> drone speed with no car · ?still freezes (for screenshots)
//      ?menu opens the options menu
//      ?log exposes window.__flyby (car, drone, tilt, camera, path, renderer, scene, s)
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createWorld } from '../game/world.js';
import { Gamepads } from '../game/gamepad.js';
import { WEATHER } from '../game/weather.js';
import { BootlegCar, Drone, droneLook } from './showcase.js';
import { fpsCounter } from '../game/fps.js';
import { TiltShift } from './tiltshift.js';
import { DRIVERS } from './drivers.js';
import { loadOptions, saveOptions, applyAndReload, PLACES, PACES, LIVE } from './options.js';
import { Menu } from './menu.js';
import { FlyAudio } from './audio.js';

const params = new URLSearchParams(location.search);
const opt = loadOptions(params);
const world = await createWorld({
  site: opt.site || null,               // another place (tools/build_site.py), same fly-by
  day: opt.day, weather: opt.weather,
  undergrowth: false,                  // the drone's too high for ground shrubs to matter
  forest: { wideBroadleaf: 10000 },    // and high enough to see the broadleaf woods spread out like the conifers
  shadows: opt.shadows > 0,
});
const { renderer, scene, camera, path, heightAt, day, weather, shadows, course } = world;
const title = course.title || ['ROUTE 33', 'MT. HARUNA'], from = course.startName || 'the summit'; // other places name themselves in course.json
const shadowLevel = opt.shadows;
world.moonShadow?.set(shadowLevel);
droneLook(scene, camera, { day, weather });

const hud = document.getElementById('hud');
const callout = document.getElementById('callout');
const still = params.has('still');
const uphill = opt.uphill;
const dir = uphill ? -1 : 1;
const startS = params.has('s') ? +params.get('s') : uphill ? Math.min(path.finish + 150, path.length) : 0;
let s = startS;
const baseSpeed = +(params.get('speed') || 42); // m/s along the road (~150 km/h): about three minutes top to bottom
let paused = false, titleT = 0;

// the car to chase (the drone follows it instead of flying at `baseSpeed`)
const cars = await fetch('models/cars.json').then((r) => r.json());
const carId = cars[opt.car] ? opt.car : null;
let car = null;
if (carId) {
  const gltf = await new GLTFLoader().loadAsync(`models/${carId}.glb`);
  const drv = DRIVERS[carId]; // each car drives with its own tuning and lane habit
  car = new BootlegCar({ path, scene, weather, day, gltf, spec: cars[carId], shadow: opt.shadows > 0, s: uphill && !params.has('s') ? path.finish : s, dir,
    tuning: drv?.tuning, lane: drv?.lane });
  car.rig.castShadows();
  car.rig.setShadow(shadowLevel >= 1);
}
const tilt = opt.tilt ? new TiltShift(renderer, scene, camera, { byDepth: opt.tilt === 2 }) : null;
// tilt-shift: a long lens from the usual drone path (like real miniature-look photos). With a car it keeps the car dead
// centre; without, it looks less far up the road so what it's looking at fits the narrower frame
const ZOOM_FOV = 30, LOOK_AHEAD = 0.4;
if (tilt) { camera.fov = ZOOM_FOV; camera.updateProjectionMatrix(); }
const drone = new Drone(path, heightAt, camera, { lookAhead: tilt ? LOOK_AHEAD : 1 });
const audio = new FlyAudio({ opt, car, carId, spec: cars[carId], weather });
const carFocus = new THREE.Vector3(), carCentre = new THREE.Vector3();
if (params.has('log')) window.__flyby = { audio, car, drone, tilt, camera, path, renderer, scene, moonShadow: world.moonShadow, get s() { return car ? car.s : s; }, set s(v) { if (car) car.s = v; else s = v; } }; // poke at it from tests / devtools

// ---------------------------------------------------------------- text
const fmtKm = (m) => `${(m / 1000).toFixed(2)} km`;
function drawText(dt) {
  titleT += dt;
  const show = opt.text && titleT < 6 && !menu.open;
  callout.style.opacity = show ? (still ? 1 : Math.min(1, titleT, 6 - titleT)) : 0;
  if (show) callout.innerHTML = `${title[0]}<small>${title[1]}${uphill ? ' · UPHILL' : ''} · ${day ? 'BY DAY' : 'BY NIGHT'}${weather.label ? ' · ' + weather.label : ''}</small>`;
  hud.style.display = opt.text ? '' : 'none';
  if (!opt.text) return;
  const toGo = Math.max(path.finish - s, 0);
  hud.innerHTML = `${fmtKm(Math.min(s, path.finish))} from ${from} · ${fmtKm(toGo)} to the finish · `
    + `road ${drone.road.pos ? drone.road.pos.y.toFixed(0) : '–'} m · camera ${(drone.cam.y - heightAt(drone.cam.x, drone.cam.z)).toFixed(0)} m up<br>`
    + `<b>Esc</b> options · <b>Space</b> ${paused ? 'resume' : 'pause'} · <b>[ ]</b> `
    + (car ? `pace ×${opt.pace} · ${(car.speed * 3.6).toFixed(0)} km/h` : `speed ${(baseSpeed * opt.pace * 3.6).toFixed(0)} km/h`);
}

// ---------------------------------------------------------------- input & menu
const restart = () => {
  s = startS; titleT = 0;
  drone.reset();
  car?.restart(uphill && !params.has('s') ? path.finish : startS, dir);
};
const stepPace = (d) => { opt.pace = PACES[Math.min(Math.max(PACES.indexOf(opt.pace) + d, 0), PACES.length - 1)]; menu.render(); saveLive(); };
const act = {
  pause: () => { paused = !paused; },
  faster: () => stepPace(+1),
  slower: () => stepPace(-1),
  text: () => { opt.text = !opt.text; saveLive(); },
  restart,
};
const onOff = [[true, 'On'], [false, 'Off']];
const menu = new Menu({
  settings: opt,
  rows: [
    { key: 'site', label: 'Place', values: PLACES.map((p) => [p.id, p.label]) },
    { key: 'day', label: 'Time of day', values: [[false, 'Night'], [true, 'Day']] },
    { key: 'weather', label: 'Weather', values: Object.entries(WEATHER).map(([k, w]) => [k, w.label ? w.label[0] + w.label.slice(1).toLowerCase() : 'Clear']) },
    { key: 'car', label: 'Car', values: [['', 'None (drone only)'], ...Object.values(cars).map((c) => [c.id, c.name])] },
    { key: 'uphill', label: 'Starting direction', values: [[false, 'Downhill'], [true, 'Uphill']] },
    { key: 'tilt', label: 'Tilt-shift', values: [[0, '0 - Off'], [1, '1 - Estimated'], [2, '2 - Depth map']] },
    { key: 'shadows', label: 'Shadows', values: [[0, '0 - Off'], [1, '1 - Headlights and moon'], [2, '2 - Sharp']] },
    { key: 'pace', label: 'Pace', values: PACES.map((p) => [p, `×${p}`]) },
    { key: 'engine', label: 'Engine sound', values: onOff },
    { key: 'music', label: 'Music', values: onOff },
    { key: 'text', label: 'Text overlay', values: onOff },
    { key: 'fps', label: 'Frame rate', values: onOff },
  ],
  onApply: (staged) => applyAndReload(staged),
  onLive: () => { saveLive(); audio.sync(); },
});
// live options are remembered as soon as they change (the staged ones wait for Apply)
function saveLive() {
  const saved = loadOptions(new URLSearchParams());
  for (const k of LIVE) saved[k] = opt[k];
  saveOptions(saved);
}
if (params.has('menu')) menu.toggle(true); // (screenshots)
document.getElementById('menubtn').addEventListener('click', () => menu.toggle());
const KEYS = { Space: 'pause', BracketRight: 'faster', BracketLeft: 'slower', KeyH: 'text', KeyR: 'restart' };
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (menu.key(e)) { e.preventDefault(); return; }
  if (KEYS[e.code]) { e.preventDefault(); act[KEYS[e.code]](); }
});
const PAD = { A: 'pause', R1: 'faster', L1: 'slower', Y: 'text' };
const pads = new Gamepads((btn) => { if (!menu.pad(btn) && PAD[btn]) act[PAD[btn]](); });

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
const fps = fpsCounter(() => opt.fps);
renderer.setAnimationLoop(() => {
  fps();
  const dt = Math.min(clock.getDelta(), 0.1);
  pads.poll();
  const run = !paused && !still;
  const pace = opt.pace;
  if (car) {
    car.update(run ? dt * pace : 0, camera, renderer, scene.fog);
    s = car.s;
  } else if (run) {
    s += dir * baseSpeed * pace * dt;
    if (uphill ? s < 0 : s > path.finish + 150) restart(); // past the end: back to the start
  }
  drone.aim(s, car ? car.camDir() : dir, still ? 0 : car ? dt * pace : dt, still, tilt && car ? carCentre.copy(car.rig.pos).setY(car.rig.pos.y + 0.7) : null);
  audio.update(run && car ? dt * pace : 0, camera, paused || still);
  weather.update(still ? 0 : dt, camera);
  world.moonShadow?.follow(camera, drone.focus);
  drawText(still ? 0 : dt);
  if (tilt) { // sharp on the car (or the road it's looking at); full effect from ~110 m up, none skimming below ~30 m
    const subject = car ? carFocus.copy(car.rig.pos).setY(car.rig.pos.y + 0.7) : drone.focus;
    tilt.render(subject, THREE.MathUtils.smoothstep(drone.cam.y - subject.y, 30, 110), still ? 1 : dt);
  } else renderer.render(scene, camera);
});
