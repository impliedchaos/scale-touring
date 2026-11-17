// Gamepads (W3C "standard" mapping: Xbox-style positions; the AYN Thor's built-in controller reports this way).
// poll() once per frame: returns the held state (analog where the pad has it) and fires onPress(button) on new presses.
export const BTN = ['A', 'B', 'X', 'Y', 'L1', 'R1', 'L2', 'R2', 'SELECT', 'START', 'L3', 'R3', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME'];
const DEAD = 0.25;
const dz = (v) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));

export class Gamepads {
  constructor(onPress) {
    this.onPress = onPress;
    this.prev = new Map();     // pad index → pressed[] last frame
    this.triggers = new Set(); // pads whose R2/L2 have been used: their stick/D-pad up/down stop being gas/brake
    this.lastUsed = -Infinity; // performance.now() of the last real gamepad input
    this.state = { throttle: 0, brake: 0, steer: 0 };
  }

  poll() {
    const st = this.state;
    st.throttle = st.brake = st.steer = 0;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const b = (i) => pad.buttons[i] || { pressed: false, value: 0 };
      const pressed = pad.buttons.map((x) => x.pressed);
      const before = this.prev.get(pad.index) || [];
      pressed.forEach((on, i) => { if (on && !before[i]) { this.lastUsed = performance.now(); this.onPress(BTN[i] || `B${i}`); } });
      this.prev.set(pad.index, pressed);

      const sx = dz(pad.axes[0] || 0), sy = dz(pad.axes[1] || 0);
      const trig = b(6).value > 0.05 || b(7).value > 0.05;
      if (sx || sy || trig) this.lastUsed = performance.now();
      if (trig) this.triggers.add(pad.index);
      // up/down as gas/brake is for pads without triggers; once R2/L2 are in use, the stick only shoves
      const upDown = !this.triggers.has(pad.index);
      st.throttle = Math.max(st.throttle, b(7).value, upDown && (b(12).pressed || sy < -0.5) ? 1 : 0);
      st.brake = Math.max(st.brake, b(6).value, upDown && (b(13).pressed || sy > 0.5) ? 1 : 0);
      st.steer += sx + (b(15).pressed ? 1 : 0) - (b(14).pressed ? 1 : 0);
    }
    st.steer = Math.max(-1, Math.min(1, st.steer));
    return st;
  }

  /** Was a gamepad the most recently used input? (for on-screen prompts) */
  recentlyUsed(since = Infinity) { return performance.now() - this.lastUsed < since; }
}

/** ?pad: live readout of every connected gamepad, for checking a new device's mapping. */
export function padDebug() {
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;right:8px;bottom:8px;margin:0;padding:8px;background:rgba(0,0,0,.75);color:#9f9;font:11px/1.35 ui-monospace,monospace;z-index:9;pointer-events:none';
  document.body.appendChild(el);
  const draw = () => {
    const pads = [...(navigator.getGamepads?.() || [])].filter(Boolean);
    el.textContent = pads.length ? pads.map((p) =>
      `#${p.index} ${p.id}\nmapping: ${p.mapping || '(none)'}\n` +
      `axes: ${p.axes.map((a) => a.toFixed(2)).join(' ')}\n` +
      `buttons: ${p.buttons.map((x, i) => (x.pressed || x.value > 0.02 ? `${BTN[i] || i}=${x.value.toFixed(2)}` : '')).filter(Boolean).join(' ') || '-'}`,
    ).join('\n\n') : 'no gamepad (press a button)';
    requestAnimationFrame(draw);
  };
  draw();
  addEventListener('keydown', (e) => console.info('keydown', e.code, e.key));
}
