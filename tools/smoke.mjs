// Smoke check: loads every place in PLACES in headless Chrome and fails on anything that goes wrong on the way.
// The first place comes from the URL, the rest are swapped in on the same page the way the menu and auto-cycle do it
// (old world disposed, new one built), so both paths are covered. Doesn't judge the picture; screenshots still do that.
//
//   cd web && npm run build && npx vite preview --port 4180 --strictPort &
//   node tools/smoke.mjs http://localhost:4180/
//
// Fails (exit 1) on: an uncaught exception, a console.error, a request that 404s or fails, a place that doesn't finish
// building within the timeout, or a scene with no terrain or road.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLACES } from '../web/src/course/options.js';

const base = process.argv[2] || 'http://localhost:4173/';
const TIMEOUT_S = 120; // swiftshader is slow; Rio and Hong Kong take the longest
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'smoke-'));
const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--mute-audio', '--window-size=1000,560', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (code) => { chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(code); };

let problems = []; // what went wrong while the current place was loading
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json(); } catch {}
}
if (!target) { console.error('smoke: chrome did not start'); done(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data), p = msg.params;
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text));
  if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') problems.push('console.error: ' + p.args.map((a) => a.value ?? a.description).join(' '));
  // (the site has no favicon; the browser asks for one regardless)
  if (msg.method === 'Network.responseReceived' && p.response.status >= 400 && !p.response.url.endsWith('/favicon.ico')) problems.push(`HTTP ${p.response.status}: ${p.response.url}`);
  if (msg.method === 'Network.loadingFailed' && !p.canceled) problems.push(`request failed (${p.errorText}): ${p.requestId}`);
};
const send = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

/** Wait for `start()` to publish a new world (window.__flyby is replaced at the end of every build), then check it. */
async function settle(prev) {
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_S * 1000) {
    const state = await evaluate(`(() => { const f = window.__flyby; if (!f || f === window.__smokePrev) return null;
      return { terrain: !!f.scene.getObjectByName('terrain'), road: !!f.scene.getObjectByName('road'), car: !!f.car, len: f.path.length }; })()`);
    if (state) {
      if (!state.terrain) problems.push('no terrain mesh');
      if (!state.road) problems.push('no road mesh');
      return { ...state, secs: (Date.now() - t0) / 1000 };
    }
    await sleep(500);
  }
  problems.push(`did not finish building in ${TIMEOUT_S} s` + (prev ? ` (after ${prev})` : ''));
  return null;
}

await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
let failed = 0;
for (const [k, place] of PLACES.entries()) {
  problems = [];
  if (k === 0) {
    await send('Page.navigate', { url: `${base}?site=${place.id}&log&cycle=0&still` });
  } else {
    // the menu's path: change the option, then rebuild in place
    await evaluate(`window.__smokePrev = window.__flyby; Object.assign(window.__flyby.opt, { site: ${JSON.stringify(place.id)} }); window.__flyby.swap(); true`);
  }
  const state = await settle(k ? PLACES[k - 1].id : null);
  const site = await evaluate('window.__flyby && window.__flyby.opt.site');
  if (state && site !== place.id) problems.push(`built ${site} instead`);
  const head = `${place.id.padEnd(9)} ${state ? `${state.secs.toFixed(1).padStart(5)} s, ${Math.round(state.len)} m of road${state.car ? '' : ', no car'}` : ''}`;
  if (problems.length) { failed++; console.log(`FAIL ${head}\n  ${problems.join('\n  ')}`); }
  else console.log(`ok   ${head}`);
}
console.log(failed ? `smoke: ${failed} of ${PLACES.length} places failed` : `smoke: all ${PLACES.length} places load`);
done(failed ? 1 : 0);
