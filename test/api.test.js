'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { addDays, today } = require('../src/db');
const { startApp } = require('./helpers');

let app;
let base;
const req = (...args) => app.req(...args);

before(async () => {
  app = await startApp();
  base = app.base;
});

after(() => app.close());

test('domyślne kategorie i lokalizacje są utworzone', async () => {
  const cats = await req('GET', '/api/categories');
  const locs = await req('GET', '/api/locations');
  assert.equal(cats.status, 200);
  assert.ok(cats.body.some((c) => c.name === 'Żywność'));
  assert.ok(locs.body.some((l) => l.name === 'Kuchnia'));
});

test('CRUD zasobu', async () => {
  const cats = (await req('GET', '/api/categories')).body;
  const created = await req('POST', '/api/items', {
    name: 'Mąka', quantity: 2, unit: 'kg', min_quantity: 1, price: 3.5, category_id: cats[0].id,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'Mąka');
  assert.equal(created.body.category, cats[0].name);

  const id = created.body.id;
  const updated = await req('PATCH', `/api/items/${id}`, { notes: 'pszenna' });
  assert.equal(updated.body.notes, 'pszenna');
  assert.equal(updated.body.quantity, 2);

  assert.equal((await req('DELETE', `/api/items/${id}`)).status, 204);
  assert.equal((await req('GET', `/api/items/${id}`)).status, 404);
});

test('walidacja danych wejściowych', async () => {
  assert.equal((await req('POST', '/api/items', { name: '' })).status, 400);
  assert.equal((await req('POST', '/api/items', { name: 'X', quantity: -1 })).status, 400);
  assert.equal((await req('POST', '/api/items', { name: 'X', expires_at: '15.11.2026' })).status, 400);
  const bad = await fetch(`${base}/api/items`, { method: 'POST', body: '{nie json', headers: { Authorization: `Bearer ${app.token}` } });
  assert.equal(bad.status, 400);
});

test('zmiana stanu zapisuje historię i nie pozwala zejść poniżej zera', async () => {
  const { body: item } = await req('POST', '/api/items', { name: 'Mydło', quantity: 3 });
  const dec = await req('POST', `/api/items/${item.id}/adjust`, { delta: -2 });
  assert.equal(dec.body.quantity, 1);
  const tooMuch = await req('POST', `/api/items/${item.id}/adjust`, { delta: -5 });
  assert.equal(tooMuch.status, 400);
  const hist = await req('GET', `/api/items/${item.id}/history`);
  assert.deepEqual(hist.body.map((h) => h.delta), [-2, 3]);
});

test('niski stan trafia na listę zakupów', async () => {
  const { body: item } = await req('POST', '/api/items', { name: 'Papier toaletowy', quantity: 1, min_quantity: 4, unit: 'rolka' });
  const list = (await req('GET', '/api/shopping-list')).body;
  const entry = list.find((i) => i.id === item.id);
  assert.ok(entry);
  assert.equal(entry.to_buy, 7);

  const low = (await req('GET', '/api/items?status=low')).body;
  assert.ok(low.some((i) => i.id === item.id));
});

test('statystyki i filtry terminów ważności', async () => {
  const { body: expired } = await req('POST', '/api/items', { name: 'Jogurt', quantity: 1, expires_at: addDays(today(), -1) });
  const { body: soon } = await req('POST', '/api/items', { name: 'Mleko', quantity: 1, expires_at: addDays(today(), 3) });
  const { body: later } = await req('POST', '/api/items', { name: 'Ryż', quantity: 1, expires_at: addDays(today(), 300) });

  const expiring = (await req('GET', '/api/items?status=expiring')).body.map((i) => i.id);
  assert.ok(expiring.includes(expired.id) && expiring.includes(soon.id) && !expiring.includes(later.id));

  const exp = (await req('GET', '/api/items?status=expired')).body.map((i) => i.id);
  assert.deepEqual(exp, [expired.id]);

  const stats = (await req('GET', '/api/stats')).body;
  assert.equal(stats.expired, 1);
  assert.equal(stats.expiring_soon, 1);
  assert.ok(stats.total_items >= 3);
});

test('wyszukiwanie po nazwie', async () => {
  const res = (await req('GET', '/api/items?q=mlek')).body;
  assert.deepEqual(res.map((i) => i.name), ['Mleko']);
});

test('słowniki: dodawanie, duplikaty, usuwanie', async () => {
  const added = await req('POST', '/api/locations', { name: 'Strych' });
  assert.equal(added.status, 201);
  assert.equal((await req('POST', '/api/locations', { name: 'strych' })).status, 400);
  assert.equal((await req('DELETE', `/api/locations/${added.body.id}`)).status, 204);
});

test('eksport i import danych', async () => {
  const exported = (await req('GET', '/api/export')).body;
  const count = exported.items.length;
  assert.ok(count > 0);
  await req('POST', '/api/items', { name: 'Tymczasowy' });
  const imp = await req('POST', '/api/import', exported);
  assert.equal(imp.status, 200);
  const items = (await req('GET', '/api/items')).body;
  assert.equal(items.length, count);
  assert.ok(!items.some((i) => i.name === 'Tymczasowy'));
});

test('pliki statyczne i ochrona przed path traversal', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Manager zasobów domowych/);
  const trav = await fetch(`${base}/..%2Fpackage.json`);
  assert.notEqual(trav.status, 200);
});
