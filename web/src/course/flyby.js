// The fly-by (the default page): a drone flies over the course, a car drifts down the road and back up.
// Esc opens the options menu, which pauses everything. Other keys: Space camera view · [ ] pace · H hide the text · R restart.  Pad: START menu · A camera · L1/R1 pace · Y text.
// Options (course/options.js) come from the menu (remembered), and the URL overrides them for tests and screenshots:
//      ?site=rio|hk|bigsur another place (tools/build_site.py) · ?day · ?weather=clear|wet|rain|fog|wetfog · ?uphill (start at the bottom)
//      ?car=<id>|none the car to chase (default rx7; none = the drone just flies the road) · ?view=drone|wide|chase|hood|trackside the camera · ?undergrowth=0 no ground cover · ?tiltshift=0|1|2 the miniature blur off · blurred by screen height (estimated) · by scene depth (bare = 2)
//      ?shadows=0|1|2 off · headlights and the moon's, coarse · plus the moon's sharp near the camera (bare ?shadows = 2)
//      ?fps frame-rate counter · ?engine=<0..1> ?music=<0..1> volume (bare = full) · ?song=<file in music/playlist.json>
// Test-only:  ?s=<metres> start position · ?speed=<m/s> drone speed with no car · ?still freezes (for screenshots)
//      ?menu opens the options menu
//      ?log exposes window.__flyby (car, cameras, tilt, camera, path, renderer, scene, s)
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createWorld } from '../game/world.js';
import { Gamepads } from '../game/gamepad.js';
import { WEATHER } from '../game/weather.js';
import { BootlegCar, droneLook } from './showcase.js';
import { CameraRig } from './cameras.js';
import { fpsCounter } from '../game/fps.js';
import { TiltShift } from './tiltshift.js';
import { DRIVERS } from './drivers.js';
import { loadOptions, saveOptions, PLACES, PACES, VIEWS, LIVE, URL_KEYS } from './options.js';
import { Menu } from './menu.js';
import { FlyAudio } from './audio.js';

const params = new URLSearchParams(location.search);
const opt = loadOptions(params);
const cars = await fetch('models/cars.json').then((r) => r.json());
const playlist = await fetch('music/playlist.json').then((r) => (r.ok ? r.json() : [])).catch(() => []);

const hud = document.getElementById('hud');
const callout = document.getElementById('callout');
const still = params.has('still');
const baseSpeed = +(params.get('speed') || 42); // m/s along the road (~150 km/h): about three minutes top to bottom
const audio = new FlyAudio({ opt, car: null, carId: null, spec: null, weather: { rain: 0, wet: 0 } }); // lives across world swaps: the music carries on
const roadAt = {};

// Everything below `start()` builds is per world, and is thrown away and rebuilt when a WORLD option is applied (`swap`), with no page reload.
let world, renderer, scene, camera, path, heightAt, day, weather, course, title, from, shadowLevel, uphill, dir, startS, s, carId, car, tilt, cameras;
let legs = 0, lastDir = 1; // auto-cycle: one leg is a pass from one end to the other; two make a full run
let titleT = 0, swapping = false, queued = false, applied = null; // applied: the options the current world was built from

async function start() {
  world = await createWorld({
    site: opt.site || null,               // another place (tools/build_site.py), same fly-by
    day: opt.day, weather: opt.weather,
    undergrowth: true,                   // ground cover streamed in around the camera, shrinking away with distance (no popping)
    forest: { wideBroadleaf: 10000 },    // and high enough to see the broadleaf woods spread out like the conifers
    shadows: opt.shadows > 0,
  });
  ({ renderer, scene, camera, path, heightAt, day, weather, course } = world);
  title = course.title || ['ROUTE 33', 'MT. HARUNA']; from = course.startName || 'the summit'; // other places name themselves in course.json
  shadowLevel = opt.shadows;
  world.moonShadow?.set(shadowLevel);
  droneLook(scene, camera, { day, weather });

  uphill = opt.uphill;
  dir = uphill ? -1 : 1;
  startS = params.has('s') ? +params.get('s') : uphill ? Math.min(path.finish + 150, path.length) : 0;
  s = startS;
  titleT = 0;

  // the car to chase (the drone follows it instead of flying at `baseSpeed`)
  applied = { ...opt };
  legs = 0; lastDir = dir;
  carId = cars[opt.car] ? opt.car : null;
  car = null;
  if (carId) {
    const gltf = await new GLTFLoader().loadAsync(`models/${carId}.glb`);
    const drv = DRIVERS[carId]; // each car drives with its own tuning and lane habit
    car = new BootlegCar({ path, scene, weather, day, gltf, spec: cars[carId], shadow: opt.shadows > 0, s: uphill && !params.has('s') ? path.finish : s, dir,
      tuning: drv?.tuning, lane: drv?.lane });
    car.rig.castShadows();
    car.rig.setShadow(shadowLevel >= 1);
  }
  cameras = new CameraRig({ camera, path, heightAt, car });
  scene.userData.focus = cameras.focus;  // what the ground cover stays grown around
  applyView();
  applyTilt();
  applyUndergrowth();
  audio.rebind({ car, carId, spec: cars[carId], weather });
  if (params.has('log')) window.__flyby = { audio, swap, applyTilt, applyView, cameras, opt, car, tilt, camera, path, renderer, scene, moonShadow: world.moonShadow, get s() { return car ? car.s : s; }, set s(v) { if (car) car.s = v; else s = v; } }; // poke at it from tests / devtools
  renderer.setAnimationLoop(frame);
}

/** The camera view in opt.view (a view that needs a car falls back to the drone without one: the option follows). */
function applyView() {
  const id = cameras.set(opt.view);
  if (id !== opt.view) { opt.view = id; menu.render(); }
  tilt?.reset();
}

/** Ground cover is live: the world always has it, the option just shows or hides it (hidden, it builds nothing either). */
function applyUndergrowth() {
  const g = scene.getObjectByName('undergrowth');
  if (g) g.visible = opt.undergrowth;
}

/** Tilt-shift is live and is only the blur: the blur pass and its depth mode, nothing about the camera. */
function applyTilt() {
  if (opt.tilt && tilt) tilt.byDepth = opt.tilt === 2;
  else if (opt.tilt) tilt = new TiltShift(renderer, scene, camera, { byDepth: opt.tilt === 2 });
  else { tilt?.dispose(); tilt = null; }
  if (window.__flyby) window.__flyby.tilt = tilt;
}

/** Rebuild the world from the current options, in place: drop the current one (and free its GPU memory), build the new one.
 *  The audio context and the music are kept, so a song carries on through the change. Changes made while it's busy
 *  are picked up when it's done; on failure, the previous world comes back. */
async function swap() {
  if (swapping) { queued = true; return; }
  swapping = true;
  const url = new URL(location.href); // the address no longer overrides the choices just made
  for (const k of URL_KEYS) url.searchParams.delete(k);
  history.replaceState(null, '', url);
  const load = async () => {
    saveWorld();
    renderer?.setAnimationLoop(null);
    tilt?.dispose(); tilt = null;
    world?.dispose(); world = null;
    callout.style.opacity = 1;
    callout.innerHTML = `LOADING<small>${(PLACES.find((p) => p.id === opt.site) || {}).label || ''}</small>`;
    hud.style.display = 'none';
    await new Promise((r) => requestAnimationFrame(() => r())); // let the message paint before the heavy build blocks the page
    await start();
  };
  try {
    do { queued = false; await load(); } while (queued);
  } catch (err) {
    console.error('could not load that place, going back', err);
    Object.assign(opt, applied); menu.staged = { ...opt }; menu.render(); saveWorld();
    try { await load(); } catch (e2) { console.error(e2); callout.innerHTML = 'COULD NOT LOAD<small>reload the page</small>'; }
  }
  swapping = false;
}

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
    + `road ${path.sample(Math.min(Math.max(s, 0), path.length), 0, roadAt).pos.y.toFixed(0)} m · camera ${(camera.position.y - heightAt(camera.position.x, camera.position.z)).toFixed(0)} m up<br>`
    + `<b>Esc</b> options (pauses) · <b>Space</b> camera: ${VIEWS.find((v) => v.id === opt.view).label} · <b>[ ]</b> `
    + (car ? `pace ×${opt.pace} · ${(car.speed * 3.6).toFixed(0)} km/h` : `speed ${(baseSpeed * opt.pace * 3.6).toFixed(0)} km/h`);
}

// ---------------------------------------------------------------- input & menu
/** Auto-cycle: on to the next place in the menu's list (wrapping), as if it had been picked there. */
function cycleNext() {
  const i = PLACES.findIndex((p) => p.id === opt.site);
  opt.site = PLACES[(i + 1) % PLACES.length].id;
  menu.staged.site = opt.site; menu.render();
  legs = 0;
  swap();
}
const restart = () => {
  s = startS; titleT = 0;
  cameras.reset();
  car?.restart(uphill && !params.has('s') ? path.finish : startS, dir);
};
const stepPace = (d) => { opt.pace = PACES[Math.min(Math.max(PACES.indexOf(opt.pace) + d, 0), PACES.length - 1)]; menu.render(); saveLive(); };
const act = {
  view: () => { opt.view = cameras.next(); applyView(); menu.render(); saveLive(); },
  faster: () => stepPace(+1),
  slower: () => stepPace(-1),
  text: () => { opt.text = !opt.text; saveLive(); },
  restart: () => { if (!swapping) restart(); },
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
    { key: 'view', label: 'Camera', values: VIEWS.map((v) => [v.id, v.label]) },
    { key: 'tilt', label: 'Tilt-shift', values: [[0, '0 - Off'], [1, '1 - Estimated'], [2, '2 - Depth map']] },
    { key: 'undergrowth', label: 'Ground cover', values: onOff },
    { key: 'shadows', label: 'Shadows', values: [[0, '0 - Off'], [1, '1 - Headlights and moon'], [2, '2 - Sharp']] },
    { key: 'pace', label: 'Pace', values: PACES.map((p) => [p, `×${p}`]) },
    { key: 'engine', label: 'Engine volume', slider: true },
    { key: 'music', label: 'Music volume', slider: true },
    ...(playlist.length ? [{ key: 'song', label: 'Song', values: [['', 'Playlist order'], ...playlist.map((t) => [t.file, t.title])] }] : []),
    { key: 'cycle', label: 'Auto-cycle places', values: onOff },
    { key: 'text', label: 'Text overlay', values: onOff },
    { key: 'fps', label: 'Frame rate', values: onOff },
  ],
  onWorld: () => swap(),
  onLive: (key) => { saveLive(); audio.sync(); if (key === 'tilt') applyTilt(); else if (key === 'undergrowth') applyUndergrowth(); else if (key === 'view') applyView(); },
});
// options are remembered as soon as they change
function saveLive() {
  const saved = loadOptions(new URLSearchParams());
  for (const k of LIVE) saved[k] = opt[k];
  saveOptions(saved);
}
function saveWorld() { saveOptions({ ...opt }); }
if (params.has('menu')) menu.toggle(true); // (screenshots)
document.getElementById('menubtn').addEventListener('click', () => menu.toggle());
const KEYS = { Space: 'view', BracketRight: 'faster', BracketLeft: 'slower', KeyH: 'text', KeyR: 'restart' };
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (menu.key(e)) { e.preventDefault(); return; }
  if (KEYS[e.code]) { e.preventDefault(); act[KEYS[e.code]](); }
});
const PAD = { A: 'view', R1: 'faster', L1: 'slower', Y: 'text' };
const pads = new Gamepads((btn) => { if (!menu.pad(btn) && PAD[btn]) act[PAD[btn]](); });

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
const fps = fpsCounter(() => opt.fps);
function frame() {
  fps();
  const dt = Math.min(clock.getDelta(), 0.1);
  pads.poll();
  const paused = menu.open;           // the menu pauses everything: the car, the weather, the camera, the sound effects
  const run = !paused && !still;
  const pace = opt.pace;
  if (car) {
    car.update(run ? dt * pace : 0, camera, renderer, scene.fog);
    s = car.s;
    if (car.dir !== lastDir) { // it has turned round at an end
      lastDir = car.dir;
      if (++legs >= 2 && opt.cycle && !swapping && !params.has('s')) cycleNext(); // up and down (or down and up) done
    }
  } else if (run) {
    s += dir * baseSpeed * pace * dt;
    if (uphill ? s < 0 : s > path.finish + 150) { // past the end: back to the start (or on, if cycling: the drone makes one pass)
      if (opt.cycle && !swapping && !params.has('s')) cycleNext(); else restart();
    }
  }
  cameras.update(s, car ? car.camDir() : dir, run ? (car ? dt * pace : dt) : 0, still);
  audio.update(run && car ? dt * pace : 0, camera, paused || still);
  weather.update(run ? dt : 0, camera);
  world.moonShadow?.follow(camera, cameras.focus);
  drawText(run ? dt : 0);
  if (tilt) { // sharp on the car (or the road it's looking at); full effect from ~110 m up, none skimming below ~30 m
    tilt.render(cameras.subject, THREE.MathUtils.smoothstep(camera.position.y - cameras.subject.y, 30, 110), still ? 1 : dt);
  } else renderer.render(scene, camera);
}

await start();
