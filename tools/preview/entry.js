'use strict';
/*
 * Podgląd Home-Manager w przeglądarce: prawdziwy kod serwera (src/db.js, src/app.js…)
 * na PostgreSQL w WebAssembly (PGlite). Żądania fetch('/api/…') strony trafiają do tego serwera
 * zamiast do sieci. Dane żyją w pamięci karty – znikają po odświeżeniu.
 */
const pgShim = require('pg');
const fs = require('node:fs');
const { Store } = require('../../src/db.js');
const { createApp } = require('../../src/app.js');
const auth = require('../../src/auth.js');
const { seedMedicines } = require('./demo/medicines.js');
const { seedCalendar } = require('./demo/calendar.js');

const DEMO = window.__DEMO__;
let token = null;
let handler = null;
const docUrls = new Map();
let resolveReady;
const ready = new Promise((r) => { resolveReady = r; });

const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const addDays = (n) => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Wywołuje handler serwera Node z udawanymi obiektami req/res. */
function callServer(method, url, headers, body) {
  return new Promise((resolve) => {
    const listeners = {};
    const req = {
      method, url, headers,
      socket: { remoteAddress: '127.0.0.1' },
      on(ev, cb) {
        listeners[ev] = cb;
        if (ev === 'end') {
          queueMicrotask(() => {
            if (body && body.length) listeners.data?.(body);
            cb();
          });
        }
        return req;
      },
      resume() {}, destroy() {},
    };
    const outHeaders = {};
    const res = {
      headersSent: false,
      setHeader(k, v) { outHeaders[k.toLowerCase()] = v; },
      writeHead(status, h = {}) {
        res.statusCode = status;
        for (const [k, v] of Object.entries(h)) outHeaders[k.toLowerCase()] = v;
        res.headersSent = true;
      },
      end(payload) {
        const status = res.statusCode ?? 200;
        const h = new Headers();
        for (const [k, v] of Object.entries(outHeaders)) if (k !== 'set-cookie') h.set(k, String(v));
        const noBody = status === 204 || status === 304;
        resolve(new Response(noBody ? null : (payload ?? ''), { status, headers: h }));
      },
    };
    handler(req, res);
  });
}

async function refreshDocUrls() {
  const { rows } = await store.q('SELECT id, file, mime FROM documents');
  for (const r of rows) {
    if (docUrls.has(r.id)) continue;
    const data = fs.__files.get(`/data/uploads/${r.file}`);
    if (data) docUrls.set(r.id, URL.createObjectURL(new Blob([data], { type: r.mime })));
  }
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const href = typeof input === 'string' ? input : input.url;
  const u = new URL(href, location.href);
  const i = u.pathname.indexOf('/api/');
  if (i < 0 || (typeof input === 'string' && /^https?:/.test(input) && u.origin !== location.origin)) return realFetch(input, init);
  await ready;
  const path = u.pathname.slice(i) + u.search;
  const method = (init.method || 'GET').toUpperCase();
  const headers = { host: 'podglad' };
  for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
  if (token && !headers.authorization) headers.authorization = `Bearer ${token}`;
  let body = null;
  if (init.body != null) {
    body = typeof init.body === 'string'
      ? Buffer.from(init.body, 'utf8')
      : Buffer.from(await new Response(init.body).arrayBuffer());
  }
  const res = await callServer(method, path, headers, body);
  if (/^\/api\/auth\/(login|setup)$/.test(u.pathname.slice(i)) && res.ok) {
    token = (await res.clone().json()).token;
  } else if (u.pathname.slice(i) === '/api/auth/logout') {
    token = null;
  }
  if (/^\/api\/(equipment|documents)/.test(path)) await refreshDocUrls();
  return res;
};
window.__docUrl = (id) => docUrls.get(Number(id)) ?? '';

let store;

async function seed() {
  const hashes = DEMO.hashes;
  const dawid = await store.createUser({ name: 'Dawid', login: 'dawid', role: 'admin' }, hashes.dawid);
  const kasia = await store.createUser({ name: 'Kasia', login: 'kasia' }, hashes.kasia);
  const as = (u) => ({ userId: u.id });

  // Produkty z prawdziwymi zdjęciami z Open Food Facts.
  const prices = [8.99, 3.29, 4.49, 2.79, 12.99, 5.49, 3.99, 6.99, 14.99, 9.99];
  const items = [];
  for (const [n, it] of DEMO.items.entries()) {
    const created = await store.createItem({
      name: it.name, category_id: it.category_id, location_id: it.location_id, quantity: it.quantity,
      unit: it.unit, min_quantity: it.min_quantity, price: it.price ?? prices[n % prices.length],
      expires_at: it.expires_at, notes: it.notes, barcode: it.barcode,
    }, as(dawid));
    if (it.image) await store.q('UPDATE items SET image = $1 WHERE id = $2', [it.image, created.id]);
    items.push(created);
  }

  // Jogurt z trzema partiami o różnych terminach.
  const yog = await store.createItem({ name: 'Jogurt naturalny', category_id: 1, location_id: 1, quantity: 2, unit: 'szt.', price: 2.49, expires_at: addDays(2) }, as(dawid));
  await store.adjustQuantity(yog.id, 3, { expires_at: addDays(9), total: 7.47, userId: kasia.id });
  await store.adjustQuantity(yog.id, 2, { expires_at: addDays(21), total: 4.98, userId: dawid.id });
  items.push(yog);

  // Paragony z ostatnich miesięcy – dane do wykresu wydatków.
  const food = items.filter((i) => i.category_id === 1);
  const shops = ['Biedronka', 'Lidl', 'Kaufland', 'Biedronka', 'Lidl', 'Żabka'];
  for (let m = 5; m >= 1; m--) {
    for (let r = 0; r < 3; r++) {
      const lines = items.map((it, k) => {
        const qty = 1 + ((k + m + r) % 3);
        const factor = 0.9 + ((k * 7 + m * 3 + r) % 5) * 0.05;
        return { name: it.name, quantity: qty, total: Math.round(it.price * qty * factor * 100) / 100, item_id: it.id };
      }).filter((_, k) => (k + m + r) % 3 !== 0);
      await store.applyReceipt({ shop: shops[(m + r) % shops.length], date: addDays(-30 * m + 3 + r * 9), lines }, as((m + r) % 2 ? dawid : kasia));
    }
  }

  // Zmarnowane produkty (także w poprzednich miesiącach).
  const wasted = [[food[0], 1, 0], [food[1 % food.length], 1, -35], [yog, 1, 0], [food[2 % food.length], 1, -64], [food[0], 1, -95]];
  for (const [it, q, days] of wasted) {
    const cur = await store.getItem(it.id);
    if (cur.quantity < q) await store.adjustQuantity(it.id, q, { reason: 'correction' });
    const r = await store.adjustQuantity(it.id, -q, { reason: 'wasted', userId: kasia.id, withHistory: true });
    if (days) await store.q(`UPDATE history SET created_at = now() + make_interval(days => $1) WHERE id = ANY($2)`, [days, r.history_ids]);
  }
  await store.adjustQuantity(items[0].id, -1, { reason: 'used', userId: kasia.id }).catch(() => {});

  // Sprzęty z dokumentami.
  const pralka = await store.createEquipment({
    name: 'Pralka', brand: 'Bosch', model: 'Serie 6 WAU28', serial_number: 'FD9801-0412', location_id: 3,
    purchase_date: addDays(-700), price: 2199, shop: 'Media Expert', warranty_until: addDays(30), next_service_at: addDays(6),
    notes: 'Czyszczenie filtra pompy co 3 miesiące.',
  });
  await store.createEquipment({ name: 'Telewizor', brand: 'LG', model: 'OLED55C3', location_id: null, purchase_date: addDays(-345), price: 4299, shop: 'RTV Euro AGD', warranty_until: addDays(20) });
  await store.createEquipment({ name: 'Kocioł gazowy', brand: 'Vaillant', model: 'ecoTEC plus', location_id: 5, purchase_date: addDays(-1500), next_service_at: addDays(-3), notes: 'Przegląd raz w roku – serwis: 600 100 200' });
  await store.createEquipment({ name: 'Wiertarka udarowa', brand: 'Makita', model: 'HP1631', location_id: 4, purchase_date: addDays(-200), price: 389, warranty_until: addDays(530) });

  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 60>>stream\nBT /F1 18 Tf 20 60 Td (Karta gwarancyjna - Pralka) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const save = async (eqId, buf, kind, title, name, mime) => {
    const file = `${crypto.randomUUID().replace(/-/g, '')}.${mime === 'application/pdf' ? 'pdf' : 'png'}`;
    await fs.promises.writeFile(`/data/uploads/${file}`, buf);
    await store.addDocument(eqId, { kind, title, file, originalName: name, mime, size: buf.length, userId: dawid.id });
  };
  await save(pralka.id, pdf, 'warranty', 'Karta gwarancyjna', 'gwarancja-pralka.pdf', 'application/pdf');
  await save(pralka.id, pdf, 'receipt', 'Paragon z Media Expert', 'paragon-pralka.pdf', 'application/pdf');
  if (DEMO.photo) {
    const png = Buffer.from(DEMO.photo, 'base64');
    await save(pralka.id, png, 'photo', '', 'pralka.png', 'image/png');
  }

  await seedMedicines(store, { addDays, users: [dawid, kasia] });
  await seedCalendar(store, { addDays, users: [dawid, kasia] });

  // Zalogowany jako Dawid.
  token = auth.newToken();
  await store.createSession(dawid.id, auth.tokenHash(token));
}

window.__startPreview = async (PGlite) => {
  const db = await PGlite.create();
  pgShim.__setDb(db);
  store = await Store.open({ connectionString: 'pglite' });
  handler = createApp(store, { imagesDir: '/data/images', uploadsDir: '/data/uploads' });
  await seed();
  await refreshDocUrls();
  resolveReady();
};
window.__previewFailed = (err) => {
  const el = document.getElementById('preview-loading');
  if (el) el.innerHTML = `<strong>Nie udało się uruchomić podglądu.</strong><br>${String(err?.message || err)}`;
};
