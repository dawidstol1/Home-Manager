// Składa podgląd (Artifact): interfejs z public/ + serwer w przeglądarce (server-bundle.js) + PGlite dołączony do strony.
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..', '..') + '/';
const D = __dirname;
const read = (p) => fs.readFileSync(p, 'utf8');
const PGLITE = process.argv[2] || './pglite/pglite.js';
const OUT = process.argv[3] || path.join(D, 'out');

(async () => {
  process.chdir(R);
  const { hashPassword } = require(R + 'src/auth.js');
  const html = read(R + 'public/index.html');
  const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'))
    .replace(/<script src="[^"]+"><\/script>\s*/g, '');

  // Fonty z Google Fonts (Artifact nie serwuje plików .woff2); motyw jasny/ciemny jest już w CSS.
  let css = read(R + 'public/styles.css').replace(/@font-face \{[\s\S]*?\}\n/g, '');
  css += '\n:root { --font: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --font-display: "Plus Jakarta Sans", "Inter", system-ui, sans-serif; }\n';

  let app = read(R + 'public/app.js').replace(/\/images\/\$\{/g, 'images/${');
  const docLine = app.match(/const docUrl = .*\n/)[0];
  app = app.replace(docLine, 'const docUrl = (id) => window.__docUrl(id);\n');
  app = app.replace(/if \('serviceWorker' in navigator[\s\S]*$/, '');
  // Motyw „jak w systemie” zostawia data-theme ustawiony przez stronę, w której osadzony jest podgląd.
  app = app.replace('else delete document.documentElement.dataset.theme;', '');
  const scanner = read(R + 'public/scanner.js').replace("'vendor/zxing.min.js'", "'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js'");

  const old = JSON.parse(read(path.join(D, 'demo', 'data.json')));
  const demo = {
    items: old.items,
    hashes: { dawid: await hashPassword('haslo1234'), kasia: await hashPassword('kasia12345') },
  };

  const out = `<title>Home-Manager</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400..800&family=Plus+Jakarta+Sans:wght@500..800&display=swap">
<style>
${css}
body { background: var(--bg); }
.demo-note { margin: 0 max(16px, env(safe-area-inset-right, 0px)) 12px max(16px, env(safe-area-inset-left, 0px)); padding: 10px 14px;
  border-radius: 14px; background: var(--primary-soft); color: var(--text); font-size: .88rem; }
@media (min-width: 901px) { .demo-note { margin: 0 32px 12px; } }
#preview-loading { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; background: var(--bg); color: var(--text);
  text-align: center; padding: 24px; font-size: 1rem; }
#preview-loading .spin { width: 36px; height: 36px; border-radius: 50%; border: 4px solid var(--border); border-top-color: var(--primary);
  animation: spin 1s linear infinite; margin: 0 auto 12px; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
<div id="preview-loading"><div><div class="spin"></div>Uruchamiam podgląd – baza PostgreSQL startuje w przeglądarce…<div id="preview-step" style="margin-top:8px;opacity:.7;font-size:.9rem"></div></div></div>
${body.replace('<main>', '<p class="demo-note"><strong>Podgląd na żywo.</strong> Działa tu prawdziwy kod serwera z bazą PostgreSQL uruchomioną w przeglądarce. Zalogowano jako <b>Dawid</b> (hasło <code>haslo1234</code>); drugie konto: <b>kasia</b> / <code>kasia12345</code>. Zmiany znikną po odświeżeniu strony.</p>\n  <main>')}
<script>window.__DEMO__ = ${JSON.stringify(demo)};</script>
<script>${read(path.join(D, 'server-bundle.js'))}</script>
<script>${scanner}</script>
<script>${app}</script>
<script type="module">
// Każdy krok startu widać na ekranie – jeśli coś się zatrzyma, wiadomo gdzie.
const status = (t) => { const el = document.getElementById('preview-step'); if (el) el.textContent = t; };
const fail = (e) => { console.error(e); window.__previewFailed(e); };
window.addEventListener('error', (e) => { if (document.getElementById('preview-loading')) fail(e.error || e.message); });
window.addEventListener('unhandledrejection', (e) => { if (document.getElementById('preview-loading')) fail(e.reason); });
const timer = setTimeout(() => fail(new Error('Start trwa zbyt długo. Ostatni krok: ' + (document.getElementById('preview-step')?.textContent || '?'))), 45000);
const get = async (name) => {
  const res = await fetch(name);
  if (!res.ok) throw new Error('Nie udało się pobrać ' + name + ' (' + res.status + ')');
  return res;
};
// Pliki danych PostgreSQL: gzip zapisany jako base64 w pliku tekstowym.
const unpackText = async (name) => {
  const b64 = (await (await get(name)).text()).trim();
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
};
try {
  status('1/4 Wczytywanie silnika bazy…');
  const { PGlite } = await import('${PGLITE}');
  status('2/4 Pobieranie plików bazy (ok. 12 MB)…');
  const [wasm, initdb, data] = await Promise.all([
    get('pglite/pglite.wasm').then((r) => r.arrayBuffer()),
    get('pglite/initdb.wasm').then((r) => r.arrayBuffer()),
    unpackText('pglite/pglite-data.txt'),
  ]);
  status('3/4 Uruchamianie PostgreSQL…');
  const opts = {
    wasmModule: await WebAssembly.compile(wasm),
    initdbWasmModule: await WebAssembly.compile(initdb),
    fsBundle: new Blob([data]),
  };
  status('4/4 Tworzenie tabel i danych przykładowych…');
  await window.__startPreview({ create: () => PGlite.create(opts) });
  clearTimeout(timer);
  document.getElementById('preview-loading').remove();
} catch (e) {
  clearTimeout(timer);
  fail(e);
}
</script>
`;
  fs.mkdirSync(path.join(OUT, 'images'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'index.html'), out);
  for (const f of fs.readdirSync(path.join(D, 'demo', 'images'))) {
    fs.copyFileSync(path.join(D, 'demo', 'images', f), path.join(OUT, 'images', f));
  }
  fs.mkdirSync(path.join(OUT, 'pglite'), { recursive: true });
  const zlib = require('zlib');
  const dist = path.join(D, 'node_modules/@electric-sql/pglite/dist');
  fs.copyFileSync(path.join(D, 'pglite-bundle.js'), path.join(OUT, 'pglite', 'pglite.js'));
  for (const f of ['pglite.wasm', 'initdb.wasm']) fs.copyFileSync(path.join(dist, f), path.join(OUT, 'pglite', f));
  fs.writeFileSync(path.join(OUT, 'pglite', 'pglite-data.txt'), zlib.gzipSync(fs.readFileSync(path.join(dist, 'pglite.data')), { level: 9 }).toString('base64'));
  console.log('ok', (out.length / 1024).toFixed(0), 'KB');
})();
