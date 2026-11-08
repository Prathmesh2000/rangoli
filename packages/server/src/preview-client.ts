/** Script + toolbar injected into the live preview page (not the editor). */
export const PREVIEW_CLIENT = `
<style>
.rangoli-bar{position:fixed;top:12px;right:12px;z-index:2147483647;display:flex;gap:4px;align-items:center;padding:4px;border-radius:8px;
  background:rgba(20,22,26,.86);color:#e8eaed;font:500 12px/1 ui-sans-serif,system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)}
.rangoli-bar button{all:unset;cursor:pointer;padding:6px 10px;border-radius:6px}
.rangoli-bar button:hover{background:rgba(255,255,255,.12)}
.rangoli-bar button[aria-pressed="true"]{background:rgba(255,255,255,.2)}
.rangoli-bar .sel{padding:0 8px;opacity:.75;font-family:ui-monospace,monospace}
.rangoli-bar .dot{width:8px;height:8px;border-radius:50%;background:#3fb950;margin:0 6px}
.rangoli-bar .dot.off{background:#d29922}
[data-rid].rangoli-selected{outline:2px solid #2f81f7!important;outline-offset:1px}
[data-rid].rangoli-hover{outline:1px dashed #2f81f7!important;outline-offset:1px}
</style>
<div class="rangoli-bar" role="toolbar" aria-label="Rangoli preview">
  <span class="dot" title="live"></span>
  <button data-mode="light">Light</button><button data-mode="dark">Dark</button>
  <span class="sel" aria-live="polite"></span>
</div>
<script>
(() => {
  const html = document.documentElement, bar = document.querySelector('.rangoli-bar');
  const sel = bar.querySelector('.sel'), dot = bar.querySelector('.dot');
  const params = new URLSearchParams(location.search);
  const setMode = (m) => {
    if (m === 'light') html.removeAttribute('data-mode'); else html.setAttribute('data-mode', m);
    bar.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    params.set('mode', m); history.replaceState(null, '', '?' + params);
  };
  setMode(params.get('mode') || 'light');
  bar.addEventListener('click', e => { const m = e.target.dataset && e.target.dataset.mode; if (m) setMode(m); });
  let selected = (params.get('sel') || '').split(',').filter(Boolean);
  const paint = () => {
    document.querySelectorAll('.rangoli-selected').forEach(el => el.classList.remove('rangoli-selected'));
    selected.forEach(id => { const el = document.querySelector('[data-rid="' + id + '"]'); if (el) el.classList.add('rangoli-selected'); });
    sel.textContent = selected.length ? selected.map(s => '#' + s).join(' ') : 'click to select';
  };
  paint();
  document.addEventListener('mouseover', e => { const el = e.target.closest('[data-rid]'); document.querySelectorAll('.rangoli-hover').forEach(x => x.classList.remove('rangoli-hover')); if (el) el.classList.add('rangoli-hover'); });
  document.addEventListener('click', e => {
    if (e.target.closest('.rangoli-bar')) return;
    const el = e.target.closest('[data-rid]');
    e.preventDefault();
    const id = el ? el.dataset.rid : null;
    if (!id) selected = []; else if (e.shiftKey) selected = selected.includes(id) ? selected.filter(s => s !== id) : [...selected, id]; else selected = [id];
    params.set('sel', selected.join(',')); history.replaceState(null, '', '?' + params);
    paint();
    fetch('/select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: selected }) });
  }, true);
  const es = new EventSource('/events');
  es.onopen = () => dot.classList.remove('off');
  es.onerror = () => dot.classList.add('off');
  es.addEventListener('change', () => location.reload());
})();
</script>`;
