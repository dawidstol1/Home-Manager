'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { parseReceipt } = require('../src/receipt');
const { startApp } = require('./helpers');

const RECEIPT = `JERONIMO MARTINS POLSKA S.A.
Biedronka nr 1234
NIP 779-10-11-327
2026-11-14                nr wydr.123456
PARAGON FISKALNY
Mleko UHT 3,2% 1L      C   2 x3,29   6,58C
Chleb Tostowy 500g     C   1 x4,99   4,99C
Banany luz             C 0,756 x5,99  4,53C
Rabat                               -1,00C
MASŁO EXTRA 200G
  1 * 8,99 = 8,99 C
Jogurt naturalny 4,99 A
SPRZEDAŻ OPODATKOWANA C    25,09
SUMA PLN                    29,08
Karta 29,08`;

describe('parseReceipt – odczyt paragonu', () => {
  test('pozycje, ilości, rabaty, suma, sklep i data', () => {
    const r = parseReceipt(RECEIPT);
    assert.equal(r.shop, 'Biedronka');
    assert.equal(r.date, '2026-11-14');
    assert.equal(r.total, 29.08);
    assert.deepEqual(r.lines.map((l) => [l.name, l.quantity, l.total]), [
      ['Mleko UHT 3,2% 1L', 2, 6.58],
      ['Chleb Tostowy 500g', 1, 4.99],
      ['Banany luz', 0.756, 3.53],
      ['MASŁO EXTRA 200G', 1, 8.99],
      ['Jogurt naturalny', 1, 4.99],
    ]);
    assert.equal(r.lines_total, r.total);
  });

  test('pomyłki OCR w liczbach i inne układy', () => {
    const r = parseReceipt('PARAGON FISKALNY\nWoda mineralna 1,5L 6 * 1,2O 7,2O A\nSer zolty plastry 1 szt x 6,49 6,49 C\nSUMA 13,69');
    assert.deepEqual(r.lines.map((l) => [l.name, l.quantity, l.unit_price, l.total]), [
      ['Woda mineralna 1,5L', 6, 1.2, 7.2],
      ['Ser zolty plastry', 1, 6.49, 6.49],
    ]);
  });

  test('pusty lub nieczytelny tekst', () => {
    assert.deepEqual(parseReceipt('').lines, []);
    assert.deepEqual(parseReceipt('zupełnie nie paragon').lines, []);
  });
});

describe('API paragonów', () => {
  let app;
  const req = (...a) => app.req(...a);
  before(async () => {
    app = await startApp({ productLookup: async () => null });
  });
  after(() => app.close());

  test('dopasowanie do produktów, zapis zakupów i zapamiętanie dopasowań', async () => {
    const { body: milk } = await req('POST', '/api/items', { name: 'Mleko 3,2% (Łaciate)', quantity: 1 });
    const { body: bread } = await req('POST', '/api/items', { name: 'Chleb tostowy', quantity: 0 });

    const parsed = (await req('POST', '/api/receipts/parse', { text: RECEIPT })).body;
    const byName = Object.fromEntries(parsed.lines.map((l) => [l.name, l.match]));
    assert.equal(byName['Mleko UHT 3,2% 1L'].item_id, milk.id);
    assert.equal(byName['Chleb Tostowy 500g'].item_id, bread.id);
    assert.equal(byName['Jogurt naturalny'], null);

    const lines = [
      { name: 'Mleko UHT 3,2% 1L', quantity: 2, total: 6.58, item_id: milk.id },
      { name: 'Chleb Tostowy 500g', quantity: 1, total: 4.99, item_id: bread.id },
      { name: 'Jogurt naturalny', quantity: 1, total: 4.99, create: { name: 'Jogurt naturalny', unit: 'szt.' } },
    ];
    const saved = await req('POST', '/api/receipts', { shop: 'Biedronka', date: '2026-11-14', total: 16.56, lines });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.created, 1);

    const m = (await req('GET', `/api/items/${milk.id}`)).body;
    assert.equal(m.quantity, 3);
    assert.equal(m.price, 3.29);
    const receipt = (await req('GET', `/api/receipts/${saved.body.receipt_id}`)).body;
    assert.equal(receipt.lines.length, 3);
    assert.equal(receipt.purchased_on, '2026-11-14');

    // Wydatek trafia do miesiąca z daty paragonu.
    const hist = (await req('GET', `/api/items/${milk.id}/history`)).body;
    assert.equal(hist[0].amount, 6.58);
    assert.match(hist[0].created_at, /^2026-11-14/);

    // Następny paragon: nowy jogurt rozpoznany dzięki zapamiętanemu dopasowaniu.
    const again = (await req('POST', '/api/receipts/parse', { text: RECEIPT })).body;
    const yog = again.lines.find((l) => l.name === 'Jogurt naturalny');
    assert.equal(yog.match.remembered, true);

    assert.equal((await req('GET', '/api/receipts')).body.length, 1);
  });

  test('walidacja zapisu paragonu', async () => {
    assert.equal((await req('POST', '/api/receipts', { lines: [] })).status, 400);
    assert.equal((await req('POST', '/api/receipts', { lines: [{ name: 'X', quantity: 1 }] })).status, 400);
    assert.equal((await req('POST', '/api/receipts', { date: '14.11.2026', lines: [{ name: 'X', create: { name: 'X' } }] })).status, 400);
  });
});
