// A small frame-rate counter in the top right corner. Call the returned function once per frame; `on()` says whether
// it should be showing (the options menu toggles it live). The element is only created the first time it's wanted.
export function fpsCounter(on) {
  let el = null, last = performance.now(), n = 0, worst = 0, prev = last;
  return () => {
    if (!on()) { if (el) el.style.display = 'none'; return; }
    if (!el) {
      el = document.createElement('div');
      el.style.cssText = 'position:fixed;top:max(8px,env(safe-area-inset-top));right:max(14px,env(safe-area-inset-right));z-index:50;'
        + 'font:600 12px/1.3 ui-monospace,monospace;color:#2de2e6;background:rgba(18,6,40,.6);padding:2px 6px;border-radius:4px;pointer-events:none;white-space:pre';
      document.body.appendChild(el);
    }
    el.style.display = '';
    const now = performance.now();
    worst = Math.max(worst, now - prev); prev = now; n++;
    if (now - last < 500) return;      // refresh twice a second
    el.textContent = `${Math.round((n * 1000) / (now - last))} fps · ${worst.toFixed(0)} ms max`;
    last = now; n = 0; worst = 0;
  };
}
