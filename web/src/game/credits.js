// In-game credits, rendered from the repo's CREDITS.md (imported at build time, so the two can't drift apart).
// Handles the subset CREDITS.md uses: "## " headings, paragraphs, "- " bullets with indented continuation lines,
// and bare URLs (auto-linked).
import creditsMd from '../../../CREDITS.md?raw';

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+[^\s<.,)]/g,
  (u) => `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\//, '')}</a>`);

export function creditsHtml(md = creditsMd) {
  const out = [];
  let para = null, list = null;
  const flush = () => {
    if (para) out.push(`<p>${linkify(para.join(' '))}</p>`);
    if (list) out.push(`<ul>${list.map((li) => `<li>${linkify(li)}</li>`).join('')}</ul>`);
    para = list = null;
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    if (/^# /.test(line)) { flush(); continue; }                     // document title: the card has its own
    if (/^## /.test(line)) { flush(); out.push(`<h3>${esc(line.slice(3))}</h3>`); continue; }
    if (/^- /.test(line)) { if (para) flush(); (list ||= []).push(line.slice(2)); continue; }
    if (/^\s+\S/.test(line) && list) { list[list.length - 1] += ' ' + line.trim(); continue; }
    if (list) flush();
    (para ||= []).push(line.trim());
  }
  flush();
  return out.join('');
}
