'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { today, addDays } = require('../src/db');

let app;
const req = (...a) => app.req(...a);
before(async () => {
  app = await startApp({ productLookup: async () => null });
});
after(() => app.close());

const d = (n) => addDays(today(), n);

test('partie: dokładanie z różnymi datami i zużycie od najkrótszego terminu (FIFO)', async () => {
  const { body: item } = await req('POST', '/api/items', { name: 'Jogurt', quantity: 2, expires_at: d(10), price: 2 });
  assert.equal(item.batches.length, 1);

  await req('POST', `/api/items/${item.id}/adjust`, { delta: 3, expires_at: d(3) });
  let cur = (await req('POST', `/api/items/${item.id}/adjust`, { delta: 1, expires_at: d(20) })).body;
  assert.equal(cur.quantity, 6);
  assert.equal(cur.expires_at, d(3), 'termin produktu = najbliższy termin partii');
  assert.deepEqual(cur.batches.map((b) => [b.expires_at, b.quantity]), [[d(3), 3], [d(10), 2], [d(20), 1]]);

  // Ta sama data łączy się z istniejącą partią.
  cur = (await req('POST', `/api/items/${item.id}/adjust`, { delta: 1, expires_at: d(10) })).body;
  assert.equal(cur.batches.length, 3);

  cur = (await req('POST', `/api/items/${item.id}/adjust`, { delta: -4 })).body;
  assert.deepEqual(cur.batches.map((b) => [b.expires_at, b.quantity]), [[d(10), 2], [d(20), 1]]);
  assert.equal(cur.expires_at, d(10));

  // Zdjęcie z wybranej partii.
  cur = (await req('POST', `/api/items/${item.id}/adjust`, { delta: -1, batch_id: cur.batches[1].id })).body;
  assert.deepEqual(cur.batches.map((b) => [b.expires_at, b.quantity]), [[d(10), 2]]);

  assert.equal((await req('POST', `/api/items/${item.id}/adjust`, { delta: -5 })).status, 400);
});

test('edycja partii i wyrzucenie całej partii', async () => {
  const { body: item } = await req('POST', '/api/items', { name: 'Ser', quantity: 1, expires_at: d(5), price: 10 });
  const added = (await req('POST', `/api/items/${item.id}/adjust`, { delta: 2, expires_at: d(1) })).body;
  const soon = added.batches.find((b) => b.expires_at === d(1));

  let cur = (await req('PATCH', `/api/batches/${soon.id}`, { expires_at: d(2), quantity: 3 })).body;
  assert.equal(cur.quantity, 4);
  assert.equal(cur.expires_at, d(2));

  cur = (await req('DELETE', `/api/batches/${soon.id}?reason=wasted`)).body;
  assert.equal(cur.quantity, 1);
  const hist = (await req('GET', `/api/items/${item.id}/history`)).body;
  assert.equal(hist[0].reason, 'wasted');
  assert.equal(hist[0].amount, 30, 'wartość wyrzuconego = ilość × cena');
  assert.equal((await req('DELETE', '/api/batches/999999')).status, 404);
});

test('edycja w formularzu: zmiana ilości i daty przy jednej partii', async () => {
  const { body: item } = await req('POST', '/api/items', { name: 'Mąka', quantity: 2, unit: 'kg', expires_at: d(100) });
  let cur = (await req('PUT', `/api/items/${item.id}`, { ...item, quantity: 5, expires_at: d(90) })).body;
  assert.equal(cur.quantity, 5);
  assert.deepEqual(cur.batches.map((b) => [b.expires_at, b.quantity]), [[d(90), 5]]);
  cur = (await req('PUT', `/api/items/${item.id}`, { ...cur, quantity: 1 })).body;
  assert.equal(cur.quantity, 1);
  cur = (await req('PUT', `/api/items/${item.id}`, { ...cur, quantity: 0 })).body;
  assert.equal(cur.quantity, 0);
  assert.equal(cur.batches.length, 0);
});

test('szybkie zużycie skanerem i cofnięcie', async () => {
  const { body: a } = await req('POST', '/api/items', { name: 'Mleko A', quantity: 1, barcode: '5900000000111', expires_at: d(9) });
  const { body: b } = await req('POST', '/api/items', { name: 'Mleko B', quantity: 2, barcode: '5900000000111', expires_at: d(2) });

  const first = await req('POST', '/api/consume', { barcode: '5900000000111' });
  assert.equal(first.status, 200);
  assert.equal(first.body.item.id, b.id, 'najpierw produkt z najkrótszym terminem');
  assert.equal(first.body.item.quantity, 1);
  assert.equal(first.body.history_ids.length, 1);

  const undo = await req('POST', `/api/history/${first.body.history_ids[0]}/undo`);
  assert.equal(undo.body.quantity, 2);
  assert.equal(undo.body.expires_at, d(2));

  await req('POST', '/api/consume', { barcode: '5900000000111', reason: 'wasted' });
  await req('POST', '/api/consume', { barcode: '5900000000111' });
  const third = await req('POST', '/api/consume', { barcode: '5900000000111' });
  assert.equal(third.body.item.id, a.id);
  assert.match((await req('POST', '/api/consume', { barcode: '5900000000111' })).body.error, /brak na stanie/);
  assert.equal((await req('POST', '/api/consume', { barcode: '0000000000000' })).status, 404);
});

test('wydatki i marnowanie w raportach', async () => {
  const base = (await req('GET', '/api/stats')).body;
  const { body: item } = await req('POST', '/api/items', { name: 'Masło', quantity: 1, price: 8 });
  // Stan początkowy nie jest wydatkiem; zakup jest.
  await req('POST', `/api/items/${item.id}/adjust`, { delta: 2, total: 15 });
  let cur = (await req('GET', `/api/items/${item.id}`)).body;
  assert.equal(cur.price, 7.5, 'cena jednostkowa z ostatniego zakupu');
  await req('POST', `/api/items/${item.id}/adjust`, { delta: -1, reason: 'wasted' });

  const stats = (await req('GET', '/api/stats')).body;
  assert.equal(stats.spent_month - base.spent_month, 15);
  assert.equal(stats.wasted_month - base.wasted_month, 7.5);

  const rep = (await req('GET', '/api/reports?months=3')).body;
  assert.equal(rep.monthly.length, 3);
  assert.equal(rep.monthly.at(-1).spent, stats.spent_month);
  assert.ok(rep.wasted_items.some((w) => w.name === 'Masło' && w.amount === 7.5));
  assert.ok(rep.by_user.some((u) => u.name === 'Admin'));
});

test('eksport i import zachowują partie', async () => {
  const exported = (await req('GET', '/api/export')).body;
  assert.equal(exported.version, 3);
  const before = (await req('GET', '/api/items')).body;
  const imp = await req('POST', '/api/import', exported);
  assert.equal(imp.status, 200);
  const after = (await req('GET', '/api/items')).body;
  assert.deepEqual(after.map((i) => [i.name, i.quantity, i.expires_at]), before.map((i) => [i.name, i.quantity, i.expires_at]));
});
