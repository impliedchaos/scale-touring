// The fly-by's options: defaults, then what the menu saved (localStorage), then whatever the URL says (the URL wins, so
// test links and screenshots stay exact). A flag is on when present and not 0/false/off/no/none: `?day`, `?tiltshift=0`.
//
// LIVE options change while it flies; the rest (WORLD) rebuild the scene, so the menu stages them and reloads.
import { WEATHER } from '../game/weather.js';

// Per-place titles live in course.json (tools/build_site.py); this is only the list to choose from.
export const PLACES = [
  { id: '', label: 'Mt. Haruna, Japan' },
  { id: 'rio', label: 'Rio de Janeiro' },
  { id: 'hk', label: 'Hong Kong' },
];
export const PACES = [0.25, 0.5, 1, 2, 4, 8];

export const DEFAULTS = {
  site: '', day: false, weather: 'clear', car: 'ae86', tilt: true, shadows: 0, uphill: false, // WORLD
  pace: 1, text: true, fps: false,                                                              // LIVE
};
export const LIVE = ['pace', 'text', 'fps'];

const KEY = 'touring-options';
const OFF = new Set(['0', 'false', 'off', 'no', 'none']);
// URL parameter behind each option, for stripping them off the address when the menu reloads the page
export const URL_KEYS = ['site', 'day', 'weather', 'car', 'tiltshift', 'shadows', 'uphill', 'fps'];

const flag = (params, name) => { const v = params.get(name); return v !== null && !OFF.has(v); };

export function loadOptions(params) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* storage blocked or corrupt: defaults */ }
  const o = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (typeof saved[k] === typeof DEFAULTS[k]) o[k] = saved[k];

  if (params.has('site')) o.site = params.get('site') || '';
  if (params.has('day')) o.day = flag(params, 'day');
  if (WEATHER[params.get('weather')]) o.weather = params.get('weather');
  if (params.has('car')) o.car = flag(params, 'car') ? params.get('car') || 'ae86' : '';
  if (params.has('tiltshift')) o.tilt = flag(params, 'tiltshift');
  if (params.has('shadows')) o.shadows = flag(params, 'shadows') ? Math.min(Math.max(Math.round(+(params.get('shadows') || 2)) || 0, 0), 2) : 0;
  if (params.has('uphill')) o.uphill = flag(params, 'uphill');
  if (params.has('fps')) o.fps = flag(params, 'fps');

  if (!PLACES.some((p) => p.id === o.site) && !params.has('site')) o.site = '';
  if (!PACES.includes(o.pace)) o.pace = 1;
  return o;
}

export function saveOptions(o) {
  try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* not remembered; fine */ }
}

/** Save, drop the option parameters from the address (they'd override the new choices), and reload. */
export function applyAndReload(o) {
  saveOptions(o);
  const url = new URL(location.href);
  for (const k of URL_KEYS) url.searchParams.delete(k);
  location.replace(url);
}
