/** Ready-made layer scripts. `el` is the layer the script belongs to. */
export const SNIPPETS: { name: string; hint: string; code: string }[] = [
  { name: 'Reveal on scroll', hint: 'Fades in when it enters the screen', code: `el.style.cssText += 'opacity:0;transform:translateY(16px);transition:opacity .5s,transform .5s';
new IntersectionObserver((entries, io) => {
  if (!entries[0].isIntersecting) return;
  el.style.opacity = 1;
  el.style.transform = 'none';
  io.disconnect();
}).observe(el);` },
  { name: 'Count up', hint: 'Animates the number in this text', code: `const target = parseFloat(el.textContent.replace(/[^\\d.]/g, '')) || 0;
const start = performance.now();
const tick = (now) => {
  const t = Math.min(1, (now - start) / 1200);
  el.textContent = Math.round(target * (1 - Math.pow(1 - t, 3))).toLocaleString();
  if (t < 1) requestAnimationFrame(tick);
};
requestAnimationFrame(tick);` },
  { name: 'Copy on click', hint: 'Copies this layer’s text', code: `el.style.cursor = 'pointer';
el.addEventListener('click', async () => {
  await navigator.clipboard.writeText(el.textContent.trim());
  el.title = 'Copied';
});` },
  { name: 'Tilt on hover', hint: '3D tilt that follows the pointer', code: `el.style.transition = 'transform .15s';
el.addEventListener('pointermove', (e) => {
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
  el.style.transform = \`perspective(800px) rotateX(\${-y * 10}deg) rotateY(\${x * 10}deg)\`;
});
el.addEventListener('pointerleave', () => { el.style.transform = ''; });` },
  { name: 'Parallax', hint: 'Moves slower than the page', code: `const speed = 0.25;
addEventListener('scroll', () => { el.style.transform = \`translateY(\${scrollY * speed}px)\`; }, { passive: true });` },
  { name: 'Countdown', hint: 'Live countdown in this text', code: `const end = Date.now() + 2 * 864e5; // change to your date
const pad = (n) => String(n).padStart(2, '0');
const tick = () => {
  const s = Math.max(0, Math.floor((end - Date.now()) / 1000));
  el.textContent = \`\${Math.floor(s / 86400)}d \${pad(Math.floor(s / 3600) % 24)}:\${pad(Math.floor(s / 60) % 60)}:\${pad(s % 60)}\`;
};
tick();
setInterval(tick, 1000);` },
  { name: 'Toggle next layer', hint: 'Show or hide the following layer', code: `const target = el.nextElementSibling;
el.style.cursor = 'pointer';
el.addEventListener('click', () => { target.hidden = !target.hidden; });` },
  { name: 'Show or hide password', hint: 'For an Input with reveal=true', code: `const field = el.querySelector('input');
el.querySelector('.rk-eye')?.addEventListener('click', () => {
  field.type = field.type === 'password' ? 'text' : 'password';
});` },
  { name: 'Connect wallet', hint: 'Browser wallet (EIP-1193): connect, show address, follow changes', code: `// Asks the visitor's own wallet; no keys ever touch this page.
const show = (a) => { el.textContent = a ? a.slice(0, 6) + '…' + a.slice(-4) : 'Connect wallet'; };
const wallet = window.ethereum;
el.addEventListener('click', async () => {
  if (!wallet) { el.textContent = 'Install a wallet'; return; }
  try {
    el.textContent = 'Confirm in wallet…';
    const [account] = await wallet.request({ method: 'eth_requestAccounts' });
    show(account);
  } catch { show(null); }
});
wallet?.on?.('accountsChanged', ([a]) => show(a));` },
  { name: 'Switch network', hint: 'Asks the wallet to change chain', code: `const chainId = '0x1'; // hex chain id: 0x1 Ethereum, 0x2105 Base, 0x89 Polygon
el.addEventListener('click', () => window.ethereum?.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }));` },
  { name: 'Read wallet balance', hint: 'Shows the native balance', code: `const wallet = window.ethereum;
if (wallet) {
  const [account] = await wallet.request({ method: 'eth_accounts' });
  if (account) {
    const wei = await wallet.request({ method: 'eth_getBalance', params: [account, 'latest'] });
    el.textContent = (Number(BigInt(wei)) / 1e18).toFixed(4);
  }
}`.replace(/^const wallet/, '(async () => {\nconst wallet') + '\n})();' },
];
