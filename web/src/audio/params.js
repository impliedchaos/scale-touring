// Sound tuning: defaults, slider ranges for the ?audio panel, and local persistence of tweaks.
// To make tuned values permanent: use the panel's "Copy settings" and paste the JSON over SOUND_DEFAULTS.
export const SOUND_DEFAULTS = {
  mix: { master: 0.8, music: 0.55, sfx: 0.9 },
  engine: {
    volume: 0.55, tone: 900, toneOpen: 2600, grit: 2.2, body: 5,
    decay: 0.0055, resonance: 190, resTrack: 0.55, rough: 0.12, jitter: 0.015, noise: 0.35, uneven: 0.25,
    intake: 0.25, pops: 0.6,
  },
  // rival engine: overrides on top of `engine`, plus turbo whistle
  rival: { volume: 0.8, resonance: 260, decay: 0.0045, grit: 1.8, tone: 1200, uneven: 0.12, turbo: 0.05 },
  screech: { volume: 0.35, pitch: 1300, q: 18, wobble: 0.08, scrub: 0.25 },
  grind: { volume: 0.4, pitch: 2100, ring: 25, rumble: 0.5, crackle: 0.5 },
  wind: { volume: 0.25 },
  fx: { volume: 0.8 },
};

// [group label, params key, [[name, min, max, step], ...]]
export const SOUND_SCHEMA = [
  ['Mix', 'mix', [['master', 0, 1, 0.01], ['music', 0, 1, 0.01], ['sfx', 0, 1.5, 0.01]]],
  ['Engine (86)', 'engine', [
    ['volume', 0, 1.5, 0.01], ['tone', 200, 3000, 10], ['toneOpen', 0, 6000, 10], ['grit', 0.5, 8, 0.1], ['body', -12, 12, 0.5],
    ['decay', 0.001, 0.02, 0.0005], ['resonance', 60, 600, 5], ['resTrack', 0, 1, 0.05], ['rough', 0, 0.5, 0.01],
    ['jitter', 0, 0.08, 0.002], ['noise', 0, 1.5, 0.05], ['uneven', 0, 0.8, 0.02], ['intake', 0, 1, 0.02], ['pops', 0, 1, 0.05]]],
  ['Rival engine', 'rival', [
    ['volume', 0, 1.5, 0.01], ['tone', 200, 3000, 10], ['grit', 0.5, 8, 0.1], ['decay', 0.001, 0.02, 0.0005],
    ['resonance', 60, 600, 5], ['uneven', 0, 0.8, 0.02], ['turbo', 0, 0.3, 0.005]]],
  ['Tire screech', 'screech', [['volume', 0, 1.5, 0.01], ['pitch', 400, 3000, 10], ['q', 2, 40, 0.5], ['wobble', 0, 0.3, 0.005], ['scrub', 0, 1, 0.02]]],
  ['Guardrail grind', 'grind', [['volume', 0, 1.5, 0.01], ['pitch', 600, 5000, 10], ['ring', 2, 60, 1], ['rumble', 0, 1.5, 0.02], ['crackle', 0, 1, 0.02]]],
  ['Wind', 'wind', [['volume', 0, 1, 0.01]]],
  ['One-shots', 'fx', [['volume', 0, 1.5, 0.01]]],
];

const KEY = 'gma-sound-params';
const clone = (o) => JSON.parse(JSON.stringify(o));

/** Defaults overlaid with any locally saved tweaks (per-browser convenience; never required). */
export function loadParams() {
  const p = clone(SOUND_DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) for (const g in p) Object.assign(p[g], saved[g] || {});
  } catch { /* storage blocked: defaults it is */ }
  return p;
}

export function saveParams(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export function resetParams(p) {
  const d = clone(SOUND_DEFAULTS);
  for (const g in d) Object.assign(p[g], d[g]);
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
