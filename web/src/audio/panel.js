// ?audio: live sound tuning panel. Sliders for every synth parameter, audition buttons, and "Copy settings"
// to paste back into SOUND_DEFAULTS (params.js). Tweaks also persist locally in this browser.
import { SOUND_SCHEMA, saveParams, resetParams } from './params.js';

export function openSoundPanel(sound, { onNeedAudio } = {}) {
  const P = sound.p;
  const el = document.createElement('div');
  el.id = 'soundpanel';
  el.innerHTML = `
    <style>
      #soundpanel { position: fixed; top: 0; right: 0; bottom: 0; width: min(320px, 92vw); overflow-y: auto; z-index: 50;
        background: rgba(8,10,20,.93); color: #dfe3f0; font: 12px/1.3 system-ui, sans-serif; padding: 10px 12px 40px;
        box-sizing: border-box; border-left: 1px solid #3a4266; }
      #soundpanel h4 { margin: 14px 0 6px; font-size: 11px; letter-spacing: .14em; color: #ffd23a; text-transform: uppercase; }
      #soundpanel label { display: grid; grid-template-columns: 74px 1fr 52px; gap: 6px; align-items: center; margin: 3px 0; }
      #soundpanel input[type=range] { width: 100%; }
      #soundpanel output { text-align: right; font: 11px ui-monospace, monospace; color: #b8bdd0; }
      #soundpanel .btns { display: flex; flex-wrap: wrap; gap: 5px; }
      #soundpanel button { background: #1b2036; color: #eef0f8; border: 1px solid #4a5280; border-radius: 4px; padding: 4px 8px; font: inherit; cursor: pointer; }
      #soundpanel button:hover { background: #262d4a; }
      #soundpanel .top { display: flex; justify-content: space-between; align-items: center; }
      #soundpanel textarea { width: 100%; height: 90px; margin-top: 6px; background: #0d1020; color: #b8f0b8; border: 1px solid #3a4266; font: 10px ui-monospace, monospace; }
      #soundpanel .note { color: #8a90a8; margin-top: 4px; }
    </style>
    <div class="top"><b>SOUND TUNING</b><button data-x="hide">hide</button></div>
    <div class="note">Drive or idle on the mountain and tweak by ear. Changes are live and saved in this browser.</div>
    <h4>Audition</h4>
    <div class="btns">
      <button data-play="rev">rev sweep</button>
      <button data-hold="screech">hold: screech</button><button data-hold="grind">hold: grind</button>
      ${['whoosh', 'warp', 'land', 'gust', 'popups', 'clunk', 'clang', 'crash', 'ghost', 'bov', 'sputter'].map((n) => `<button data-play="${n}">${n}</button>`).join('')}
    </div>
    <div class="groups"></div>
    <h4>Save</h4>
    <div class="btns"><button data-x="copy">copy settings</button><button data-x="reset">reset to defaults</button></div>
    <textarea readonly placeholder="settings JSON appears here"></textarea>
    <div class="note">Paste the JSON to Claude (or over SOUND_DEFAULTS in src/audio/params.js) to make it permanent.</div>`;
  document.body.appendChild(el);

  const groups = el.querySelector('.groups');
  const inputs = [];
  for (const [label, key, sliders] of SOUND_SCHEMA) {
    const h = document.createElement('h4');
    h.textContent = label;
    groups.appendChild(h);
    for (const [name, min, max, step] of sliders) {
      const row = document.createElement('label');
      row.innerHTML = `<span>${name}</span><input type="range" min="${min}" max="${max}" step="${step}"><output></output>`;
      const input = row.querySelector('input'), out = row.querySelector('output');
      const show = () => (out.textContent = (+input.value).toFixed(step < 0.01 ? 4 : step < 1 ? 2 : 0));
      input.value = P[key][name];
      show();
      input.addEventListener('input', () => {
        P[key][name] = +input.value;
        show();
        if (sound.ready) sound.applyParams();
        saveParams(P);
      });
      input.addEventListener('change', () => input.blur()); // give the arrow keys back to the car
      inputs.push([input, key, name, show]);
      groups.appendChild(row);
    }
  }

  const ensure = async () => { if (!sound.ready) await onNeedAudio?.(); sound.resume(); };
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    b.blur();
    if (b.dataset.x === 'hide') { el.style.display = 'none'; return; }
    if (b.dataset.x === 'copy') {
      const json = JSON.stringify(P, null, 2);
      el.querySelector('textarea').value = json;
      el.querySelector('textarea').select();
      try { await navigator.clipboard.writeText(json); b.textContent = 'copied!'; } catch { b.textContent = 'select + copy below'; }
      setTimeout(() => (b.textContent = 'copy settings'), 1500);
      return;
    }
    if (b.dataset.x === 'reset') {
      resetParams(P);
      for (const [input, key, name, show] of inputs) { input.value = P[key][name]; show(); }
      if (sound.ready) sound.applyParams();
      return;
    }
    await ensure();
    if (b.dataset.play === 'rev') sound.test = { kind: 'rev', t: 0 };
    else if (b.dataset.play) sound.play(b.dataset.play);
  });
  for (const b of el.querySelectorAll('[data-hold]')) {
    const k = b.dataset.hold;
    const on = async () => { await ensure(); sound.hold[k] = true; };
    const off = () => (sound.hold[k] = false);
    b.addEventListener('pointerdown', on);
    b.addEventListener('pointerup', off);
    b.addEventListener('pointerleave', off);
  }
  // toggle with backtick
  addEventListener('keydown', (e) => { if (e.code === 'Backquote') el.style.display = el.style.display === 'none' ? '' : 'none'; });
  return el;
}
