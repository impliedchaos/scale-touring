// ?audiotest: renders the engine synth offline and checks it numerically (I can't listen; this can).
//   pitch tracking: energy at the firing-frequency harmonics vs. off-harmonic frequencies (dB)
//   wrong-pitch control: same measure at 1.2x the firing frequency (should be much lower)
//   levels: RMS / peak (catch silence or clipping), and render speed vs. realtime
import { EngineVoice, installEngineWorklet } from './sound.js';
import { SOUND_DEFAULTS } from './params.js';

const SR = 48000;
const out = document.createElement('pre');
out.style.cssText = 'color:#cfd3e0;font:13px ui-monospace,monospace;padding:16px';
document.body.appendChild(out);

function goertzel(x, f) {
  const w = (2 * Math.PI * f) / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (x.length * x.length);
}

function harmonicity(x, f0) {
  let on = 0, off = 0;
  for (let k = 1; k <= 6; k++) { on += goertzel(x, k * f0); off += goertzel(x, (k - 1 + 0.375) * f0); }
  return 10 * Math.log10(on / off);
}

const status = (m) => { out.textContent += `${m}\n`; };
async function render(rpm, load, worklet) {
  const ctx = new OfflineAudioContext(1, SR * 1.5, SR);
  status(`render ${rpm} ${worklet ? 'worklet' : 'fallback'}: installing`);
  const ok = worklet ? await installEngineWorklet(ctx) : false;
  status(`  installed=${ok}, rendering`);
  const nb = ctx.createBuffer(1, SR * 2, SR);
  const d = nb.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const v = new EngineVoice(ctx, ctx.destination, nb, { worklet: ok, firings: 2 });
  v.setTimbre({ ...SOUND_DEFAULTS.engine, intake: 0 }); // intake is broadband noise; leave it out of pitch checks
  v.update(rpm, load, 0.016);
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  const ms = performance.now() - t0;
  const x = buf.getChannelData(0).slice(SR * 0.5); // let the control smoothing settle
  let sum = 0, peak = 0;
  for (const s of x) { sum += s * s; peak = Math.max(peak, Math.abs(s)); }
  const f0 = (rpm / 60) * 2;
  return {
    path: ok ? 'worklet' : 'scriptprocessor', rpm, load, f0: +f0.toFixed(1),
    harmonicDb: +harmonicity(x, f0).toFixed(1), wrongPitchDb: +harmonicity(x, f0 * 1.2).toFixed(1),
    rms: +Math.sqrt(sum / x.length).toFixed(3), peak: +peak.toFixed(3), realtimeX: +(1500 / ms).toFixed(1),
  };
}

const rows = [];
for (const worklet of [true, false]) {
  for (const [rpm, load] of [[1000, 0.05], [3000, 1], [6000, 1], [7500, 1], [7000, 0]]) {
    try { rows.push(await render(rpm, load, worklet)); } catch (e) { rows.push({ path: worklet ? 'worklet' : 'scriptprocessor', rpm, error: String(e) }); }
  }
}
out.textContent += 'RESULTS\n' + rows.map((r) => JSON.stringify(r)).join('\n');
console.info('AUDIOTEST', JSON.stringify(rows));
