// Real-time headless browser check: opens a URL in headless Chrome, waits, evaluates an expression, prints it.
// Unlike --dump-dom/--screenshot (virtual time), timers and audio threads run for real here.
//
//   node tools/cdp-eval.mjs <url> <seconds-to-wait> "<js expression>"
//   node tools/cdp-eval.mjs "http://localhost:4317/?audiotest" 20 "document.querySelector('pre').textContent"
//
// Env: CDP_NO_AUTOPLAY=1  behave like a normal browser (audio blocked until a user gesture)
//      CDP_KEYS="3:Space,6:KeyW"  press keys (trusted, counts as a user gesture) at those seconds
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, waitS = '10', expr = 'document.title'] = process.argv.slice(2);
if (!url) { console.error('usage: node tools/cdp-eval.mjs <url> [seconds] [expression]'); process.exit(2); }
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'cdp-eval-'));
const chrome = spawn('google-chrome', [
  '--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  ...(process.env.CDP_NO_AUTOPLAY ? [] : ['--autoplay-policy=no-user-gesture-required']), '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--window-size=1000,560', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (code) => { chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(code); };

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json(); } catch {}
  }
  if (!target) throw new Error('chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  };
  const send = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const KEYS = { Space: [' ', 32], KeyW: ['w', 87], KeyM: ['m', 77], KeyP: ['p', 80], ArrowUp: ['ArrowUp', 38] };
  const t0 = Date.now();
  for (const spec of (process.env.CDP_KEYS || '').split(',').filter(Boolean)) {
    const [at, code] = spec.split(':');
    await sleep(Math.max(0, +at * 1000 - (Date.now() - t0)));
    const [key, vk] = KEYS[code] || [code, 0];
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk });
  }
  await sleep(Math.max(0, +waitS * 1000 - (Date.now() - t0)));
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(typeof r.result?.result?.value === 'string' ? r.result.result.value : JSON.stringify(r.result?.result?.value ?? r.result));
  const errs = logs.filter((l) => /EXCEPTION|error/i.test(l));
  if (errs.length) console.log('--- page errors ---\n' + errs.join('\n'));
  done(0);
} catch (e) {
  console.error(e);
  done(1);
}
