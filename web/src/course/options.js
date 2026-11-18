// The fly-by's options: defaults, then what the menu saved (localStorage), then whatever the URL says (the URL wins, so
// test links and screenshots stay exact). A flag is on when present and not 0/false/off/no/none: `?day`, `?tiltshift=0`.
//
// LIVE options change while it flies; the rest (WORLD) rebuild the scene, so the menu stages them and reloads.
import { WEATHER } from '../game/weather.js';

// Per-place titles live in course.json (tools/build_site.py); this is only the list to choose from.
export const PLACES = [
  { id: 'harasu', label: 'Mt. Haruna, Japan' },
  { id: 'rio', label: 'Rio de Janeiro' },
  { id: 'hk', label: 'Hong Kong' },
  { id: 'bigsur', label: 'Big Sur, California' },
  { id: 'amalfi', label: 'Amalfi Coast, Italy' },
  { id: 'nagasaki', label: 'Nagasaki, Japan' },
  { id: 'monaco', label: 'Monaco' },
  { id: 'abq', label: 'Sandia Crest, New Mexico' },
  { id: 'ah', label: "L'Alpe d'Huez, France" },
];
export const PACES = [0.25, 0.5, 1, 2, 4, 8];

export const DEFAULTS = {
  site: 'rio', day: false, weather: 'clear', car: 'rx7', shadows: 2, uphill: true,  // WORLD
  tilt: 2, pace: 1, text: true, fps: false, engine: 0, music: 0, song: '', cycle: true,  // LIVE (engine, music: volume 0..1, 0 = off; song: a file in music/playlist.json, '' = the playlist's order)
};
export const LIVE = ['tilt', 'pace', 'text', 'fps', 'engine', 'music', 'song', 'cycle'];

const KEY = 'touring-options';
const OFF = new Set(['0', 'false', 'off', 'no', 'none']);
// URL parameter behind each option, for stripping them off the address once the menu has changed a choice
export const URL_KEYS = ['site', 'day', 'weather', 'car', 'tiltshift', 'shadows', 'uphill', 'fps', 'engine', 'music', 'song', 'cycle'];

const flag = (params, name) => { const v = params.get(name); return v !== null && !OFF.has(v); };

/** A volume parameter: 0..1 (or 0..100 as a percentage); a bare flag means full volume, off/0/false means silent. */
function volume(params, name) {
  const v = params.get(name);
  if (v === null || OFF.has(v)) return 0;
  const n = v === '' ? 1 : +v;
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(n > 1 ? n / 100 : n, 0), 1);
}

export function loadOptions(params) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* storage blocked or corrupt: defaults */ }
  const o = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (typeof saved[k] === typeof DEFAULTS[k]) o[k] = saved[k];

  if (params.has('site')) o.site = params.get('site') || 'harasu';
  if (params.has('day')) o.day = flag(params, 'day');
  if (WEATHER[params.get('weather')]) o.weather = params.get('weather');
  if (params.has('car')) o.car = flag(params, 'car') ? params.get('car') || 'rx7' : '';
  if (params.has('tiltshift')) o.tilt = flag(params, 'tiltshift') ? Math.min(Math.max(Math.round(+(params.get('tiltshift') || 2)) || 0, 0), 2) : 0;
  if (params.has('shadows')) o.shadows = flag(params, 'shadows') ? Math.min(Math.max(Math.round(+(params.get('shadows') || 2)) || 0, 0), 2) : 0;
  if (params.has('uphill')) o.uphill = flag(params, 'uphill');
  if (params.has('fps')) o.fps = flag(params, 'fps');
  if (params.has('engine')) o.engine = volume(params, 'engine');
  if (params.has('music')) o.music = volume(params, 'music');
  if (params.has('cycle')) o.cycle = flag(params, 'cycle');
  if (params.has('song')) o.song = params.get('song') || '';

  if (!PLACES.some((p) => p.id === o.site) && !params.has('site')) o.site = DEFAULTS.site;
  if (!PACES.includes(o.pace)) o.pace = 1;
  return o;
}

export function saveOptions(o) {
  try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* not remembered; fine */ }
}

