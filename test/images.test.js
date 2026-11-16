'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openTestStore, closeTestStore } = require('./helpers');
const { createApp } = require('../src/app');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0xff, 0xd9]);
const PRODUCTS = {
  '5900000000008': { name: 'Mleko', image_url: 'https://images.openfoodfacts.org/images/products/590/000/000/0008/front_pl.400.jpg' },
  '5900000000015': { name: 'Podejrzany', image_url: 'https://evil.example.com/x.jpg' },
  '5900000000022': { name: 'Bez zdjęcia', image_url: null },
};

let server, base, store, dir;
const downloads = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-img-'));
  store = await openTestStore();
  const productLookup = async (code) => PRODUCTS[code] ?? null;
  const imageFetch = async (url) => {
    downloads.push(url);
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => JPEG };
  };
  server = http.createServer(createApp(store, { productLookup, imagesDir: dir, imageFetch }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await closeTestStore(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

test('nowy produkt z kodem dostaje zdjęcie w tle i jest ono serwowane', async () => {
  const { body: item } = await req('POST', '/api/items', { name: 'Mleko', barcode: '5900000000008' });
  const withImage = await waitFor(async () => (await req('GET', `/api/items/${item.id}`)).body.image);
  assert.equal(withImage, '5900000000008.jpg');
  const img = await fetch(`${base}/images/${withImage}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), JPEG);
});

test('druga pozycja z tym samym kodem dostaje to samo zdjęcie', async () => {
  const before = downloads.length;
  const { body: item } = await req('POST', '/api/items', { name: 'Mleko (lodówka 2)', barcode: '5900000000008' });
  const res = await req('POST', `/api/items/${item.id}/image`);
  assert.equal(res.body.found, true);
  assert.equal(res.body.item.image, '5900000000008.jpg');
  assert.ok(downloads.length >= before);
});

test('zdjęcia spoza Open Food Facts są odrzucane, brak zdjęcia nie jest błędem', async () => {
  const before = downloads.length;
  const { body: a } = await req('POST', '/api/items', { name: 'X', barcode: '5900000000015' });
  const r1 = await req('POST', `/api/items/${a.id}/image`);
  assert.equal(r1.body.found, false);
  assert.equal(downloads.filter((u) => u.includes('evil')).length, 0);
  const { body: b } = await req('POST', '/api/items', { name: 'Y', barcode: '5900000000022' });
  assert.equal((await req('POST', `/api/items/${b.id}/image`)).body.found, false);
  assert.equal(downloads.length, before);
});

test('pobieranie zdjęcia bez kodu kreskowego zwraca błąd 400', async () => {
  const { body: item } = await req('POST', '/api/items', { name: 'Bez kodu' });
  assert.equal((await req('POST', `/api/items/${item.id}/image`)).status, 400);
});

test('usuwanie zdjęcia i uzupełnianie brakujących', async () => {
  const { body: item } = await req('POST', '/api/items', { name: 'Mleko 3', barcode: '5900000000008' });
  await waitFor(async () => (await req('GET', `/api/items/${item.id}`)).body.image);
  const removed = await req('DELETE', `/api/items/${item.id}/image`);
  assert.equal(removed.body.image, null);
  const fill = await req('POST', '/api/images/fill');
  assert.equal(fill.status, 200);
  assert.ok(fill.body.found >= 1);
  assert.equal((await req('GET', `/api/items/${item.id}`)).body.image, '5900000000008.jpg');
});

test('klient nie może ustawić dowolnej nazwy pliku ani wyjść poza katalog zdjęć', async () => {
  const { body: item } = await req('POST', '/api/items', { name: 'Z', image: '../../etc/passwd' });
  assert.equal(item.image, null);
  assert.equal((await fetch(`${base}/images/..%2F..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/images/nie-ma.jpg`)).status, 404);
});
