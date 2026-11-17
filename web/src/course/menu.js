// The options menu (Esc, or the ☰ button). Rows are either choices (←/→ or click to change) or actions (Enter or click).
// LIVE options apply as you change them; WORLD options are staged, and an "Apply" row appears to reload with them.
// Keyboard: ↑↓ row · ←→ change · Enter · Esc close/back.  Gamepad: D-pad · A · B · START opens.
import { creditsHtml } from '../game/credits.js';
import { LIVE } from './options.js';

export class Menu {
  /** `rows`: [{ key, label, values: [[value, label], ...] }]; `settings`: the live options object (mutated for LIVE keys);
   *  `onApply(staged)`: reload with the staged WORLD options; `onLive(key)`: a LIVE option changed. */
  constructor({ rows, settings, onApply, onLive }) {
    Object.assign(this, { rows, settings, onApply, onLive, open: false, sel: 0, showCredits: false, drop: null });
    this.staged = { ...settings };
    this.el = document.createElement('div');
    this.el.id = 'menu';
    this.el.innerHTML = '<div class="panel"><h2>OPTIONS</h2><ul class="rows"></ul><div class="hint"></div><div class="credits"></div></div>';
    this.ul = this.el.querySelector('ul.rows');
    this.hint = this.el.querySelector('.hint');
    this.credits = this.el.querySelector('.credits');
    this.credits.innerHTML = creditsHtml();
    this.el.querySelector('.panel').addEventListener('scroll', () => { if (this.drop) { this.drop = null; this.render(); } });
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.toggle(false); });
    document.body.appendChild(this.el);
    this.ul.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!li) return;
      if (this.drop && +li.dataset.i === this.drop.i) { this.drop = null; this.render(); return; } // its own row again: close
      this.drop = null;
      this.sel = +li.dataset.i;
      this.activate(+1, true);
    });
  }

  get dirty() { return this.rows.some((r) => !LIVE.includes(r.key) && this.staged[r.key] !== this.settings[r.key]); }

  /** The rows as they're listed: the choices, then Credits, Apply (only when something's staged) and Resume. */
  items() {
    const items = this.rows.map((r) => ({ ...r, kind: 'choice' }));
    items.push({ kind: 'credits', label: 'Credits' });
    if (this.dirty) items.push({ kind: 'apply', label: 'Apply changes (reloads)' });
    items.push({ kind: 'resume', label: 'Resume' });
    return items;
  }

  toggle(on = !this.open) {
    if (on === this.open) return;
    this.open = on;
    this.showCredits = false; this.drop = null;
    if (on) { this.staged = { ...this.settings }; this.sel = 0; }
    this.el.classList.toggle('open', on);
    this.render();
  }

  render() {
    this.el.classList.toggle('credits-open', this.showCredits);
    const items = this.items();
    this.sel = Math.min(this.sel, items.length - 1);
    this.ul.innerHTML = items.map((it, i) => {
      let v = '';
      if (it.kind === 'choice') {
        const cur = it.values.find(([val]) => val === this.staged[it.key]);
        const changed = !LIVE.includes(it.key) && this.staged[it.key] !== this.settings[it.key];
        const name = cur ? cur[1] : String(this.staged[it.key]);
        v = `<span class="v${changed ? ' changed' : ''}">${name} <i>${this.drop?.i === i ? '▴' : this.select(it) ? '▾' : '‹›'}</i></span>`;
      }
      return `<li data-i="${i}" class="${i === this.sel ? 'sel ' : ''}kind-${it.kind}"><span class="k">${it.label}</span>${v}</li>`;
    }).join('');
    this.renderDrop();
    this.hint.innerHTML = this.showCredits ? '<span class="kb">Esc back</span><span class="gp">B back</span>'
      : this.drop ? '<span class="kb">↑ ↓ choose · Enter select · Esc cancel</span><span class="gp">D-pad choose · A select · B cancel</span>'
      : '<span class="kb">↑ ↓ choose · ← → change · Enter select · Esc close</span><span class="gp">D-pad choose · A select · B close</span>';
  }

  /** The open drop-down floats above everything (fixed, outside the scrolling panel) next to its row, below it or
   *  above if there's more room there, so a long list never stretches the menu. */
  renderDrop() {
    this.dropEl?.remove();
    this.dropEl = null;
    if (!this.drop) return;
    const it = this.items()[this.drop.i], row = this.ul.querySelector(`li[data-i="${this.drop.i}"]`);
    if (!row) return;
    const el = this.dropEl = document.createElement('div');
    el.className = 'drop';
    el.innerHTML = it.values.map(([val, label], o) =>
      `<div class="opt${o === this.drop.o ? ' hot' : ''}${val === this.staged[it.key] ? ' cur' : ''}" data-o="${o}">${label}</div>`).join('');
    el.addEventListener('click', (e) => { const o = e.target.closest('.opt'); if (o) { e.stopPropagation(); this.pick(+o.dataset.o); } });
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.appendChild(el);
    const r = row.getBoundingClientRect(), vh = innerHeight, gap = 4, below = vh - r.bottom - 12, above = r.top - 12;
    const up = below < Math.min(el.scrollHeight, 220) && above > below;
    el.style.maxHeight = `${Math.max(80, up ? above : below)}px`;
    el.style.minWidth = `${Math.min(r.width, 260)}px`;
    el.style.right = `${Math.max(8, innerWidth - r.right)}px`;
    if (up) el.style.bottom = `${vh - r.top + gap}px`; else el.style.top = `${r.bottom + gap}px`;
    el.querySelector('.opt.hot')?.scrollIntoView({ block: 'nearest' });
  }

  /** Choices with more than two values pick from a drop-down; on/off ones just flip. */
  select(it) { return it.values.length > 2; }

  /** Set a choice (LIVE ones take effect at once), and close any drop-down. */
  set(it, value) {
    this.staged[it.key] = value;
    if (LIVE.includes(it.key)) { this.settings[it.key] = value; this.onLive(it.key); }
    this.drop = null;
  }

  /** Choose option `o` of the open drop-down. */
  pick(o) {
    const it = this.items()[this.drop.i];
    this.set(it, it.values[o][0]);
    this.render();
  }

  /** Step the selected choice by `d` (wraps), or with `open` open its drop-down; or run the selected action (d = 0 or +1). */
  activate(d, open = false) {
    const it = this.items()[this.sel];
    if (!it) return;
    if (it.kind === 'choice') {
      if (!d) return;
      const i = it.values.findIndex(([v]) => v === this.staged[it.key]);
      if (this.select(it) && open) { this.drop = { i: this.sel, o: Math.max(i, 0) }; this.render(); return; } // Enter / click opens it
      this.set(it, it.values[(i + d + it.values.length) % it.values.length][0]);
    } else if (d < 0) return;
    else if (it.kind === 'credits') this.showCredits = true;
    else if (it.kind === 'apply') { this.onApply(this.staged); return; }
    else if (it.kind === 'resume') { this.toggle(false); return; }
    this.render();
  }

  back() { if (this.drop) { this.drop = null; this.render(); } else if (this.showCredits) { this.showCredits = false; this.render(); } else this.toggle(false); }

  /** Returns true if the key was the menu's (so the fly-by shouldn't act on it). */
  key(e) {
    if (e.code === 'Escape') { this.open ? this.back() : this.toggle(true); return true; }
    if (!this.open) return false;
    const n = this.items().length;
    if (this.showCredits) return true;
    if (this.drop) { // the drop-down has the keys while it's open
      const m = this.items()[this.drop.i].values.length;
      if (e.code === 'ArrowDown') this.drop.o = (this.drop.o + 1) % m;
      else if (e.code === 'ArrowUp') this.drop.o = (this.drop.o + m - 1) % m;
      else if (e.code === 'Enter' || e.code === 'Space') { this.pick(this.drop.o); return true; }
      else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') this.drop = null;
      this.render();
      return true;
    }
    if (e.code === 'ArrowDown') this.sel = (this.sel + 1) % n;
    else if (e.code === 'ArrowUp') this.sel = (this.sel + n - 1) % n;
    else if (e.code === 'ArrowRight') this.activate(+1);
    else if (e.code === 'ArrowLeft') this.activate(-1);
    else if (e.code === 'Enter' || e.code === 'Space') this.activate(+1, true);
    else return true; // swallow everything else while it's open
    this.render();
    return true;
  }

  pad(btn) {
    if (btn === 'START') { this.open ? this.toggle(false) : this.toggle(true); return true; }
    if (!this.open) return false;
    if (btn === 'B') this.back();
    else if (!this.showCredits) this.key({ code: { UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight', A: 'Enter' }[btn] });
    return true;
  }
}
