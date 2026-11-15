'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Store } = require('../src/db');
const { createApp } = require('../src/app');
const { parseExpiry } = require('../src/expiry');
const { createProductLookup } = require('../src/products');

const TODAY = '2026-11-15';
const parse = (text) => parseExpiry(text, { today: TODAY }).date;

describe('parseExpiry – odczyt daty ważności z tekstu etykiety', () => {
  test('format DD.MM.RRRR ze słowem kluczowym', () => {
    assert.equal(parse('Najlepiej spożyć przed: 12.05.2027'), '2027-05-12');
  });

  test('dwucyfrowy rok i różne separatory', () => {
    assert.equal(parse('Należy spożyć do 03/01/27'), '2027-01-03');
    assert.equal(parse('EXP 03-01-2027'), '2027-01-03');
  });

  test('format ISO', () => {
    assert.equal(parse('best before 2027-02-28'), '2027-02-28');
  });

  test('miesiąc i rok → ostatni dzień miesiąca', () => {
    assert.equal(parse('Najlepiej spożyć przed końcem: 02.2028'), '2028-02-29');
    assert.equal(parse('EXP 05/27'), '2027-05-31');
  });

  test('nazwy miesięcy po polsku i angielsku', () => {
    assert.equal(parse('BB 12 MAJ 2027'), '2027-05-12');
    assert.equal(parse('BEST BEFORE 07 DEC 26'), '2026-12-07');
    assert.equal(parse('ważne do 1 paź 2027'), '2027-10-01');
  });

  test('pomija datę produkcji i wybiera termin ważności', () => {
    const text = 'Data produkcji: 01.10.2026\nNajlepiej spożyć przed: 01.04.2027\nLOT 2611';
    assert.equal(parse(text), '2027-04-01');
    assert.equal(parse('P: 10.11.2026 EXP: 10.12.2026'), '2026-12-10');
  });

  test('bez słowa kluczowego wybiera najpóźniejszą datę', () => {
    assert.equal(parse('10.11.2026   10.03.2027'), '2027-03-10');
  });

  test('typowe pomyłki OCR (O zamiast 0)', () => {
    assert.equal(parse('EXP 1O.O5.2O27'), '2027-05-10');
  });

  test('odrzuca nieprawidłowe daty, ceny i wagi', () => {
    assert.equal(parse('31.02.2027'), null);
    assert.equal(parse('Cena 12.99 zł, masa netto 500 g'), null);
    assert.equal(parse(''), null);
  });
});

describe('API skanowania', () => {
  let server;
  let base;
  let store;
  let offCalls = 0;

  const fakeFetch = async (url) => {
    offCalls += 1;
    const code = url.match(/product\/(\d+)\.json/)[1];
    if (code === '5900000000001') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 1, product: { product_name_pl: 'Mleko 3,2%', brands: 'Łaciate, Mlekpol', quantity: '1 l' } }),
      };
    }
    if (code === '5900000000099') throw new Error('network down');
    return { ok: false, status: 404, json: async () => ({ status: 0 }) };
  };

  before(async () => {
    store = new Store(':memory:');
    const productLookup = createProductLookup(store, { fetchImpl: fakeFetch });
    server = http.createServer(createApp(store, { productLookup }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.close();
    store.close();
  });

  const req = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  test('nieznany kod – podpowiedź z bazy produktów (i cache)', async () => {
    const first = await req('GET', '/api/barcode/5900000000001');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.items, []);
    assert.equal(first.body.product.name, 'Mleko 3,2% (Łaciate)');
    assert.equal(first.body.product.quantity, '1 l');

    await req('GET', '/api/barcode/5900000000001');
    assert.equal(offCalls, 1, 'drugi skan powinien użyć cache');
  });

  test('brak produktu w bazie lub brak sieci – product = null', async () => {
    assert.equal((await req('GET', '/api/barcode/5900000000002')).body.product, null);
    assert.equal((await req('GET', '/api/barcode/5900000000099')).body.product, null);
  });

  test('znany kod zwraca zasób i nie odpytuje bazy produktów', async () => {
    const created = await req('POST', '/api/items', { name: 'Kawa', quantity: 1, barcode: '5901234123457' });
    assert.equal(created.body.barcode, '5901234123457');
    const calls = offCalls;
    const scan = await req('GET', '/api/barcode/5901234123457');
    assert.deepEqual(scan.body.items.map((i) => i.id), [created.body.id]);
    assert.equal(scan.body.product, null);
    assert.equal(offCalls, calls);

    const viaQuery = await req('GET', '/api/barcode?code=5901234123457');
    assert.deepEqual(viaQuery.body.items.map((i) => i.id), [created.body.id]);
    assert.equal((await req('GET', '/api/barcode')).status, 400);

    const search = await req('GET', '/api/items?q=5901234123457');
    assert.equal(search.body.length, 1);
  });

  test('walidacja kodu kreskowego', async () => {
    assert.equal((await req('POST', '/api/items', { name: 'X', barcode: 'ma spacje' })).status, 400);
    assert.equal((await req('GET', '/api/barcode/%E0%A4%A')).status, 400);
    const cleared = await req('POST', '/api/items', { name: 'Y', barcode: '' });
    assert.equal(cleared.body.barcode, null);
  });

  test('POST /api/expiry/parse', async () => {
    const res = await req('POST', '/api/expiry/parse', { text: 'Najlepiej spożyć przed: 12.05.2027' });
    assert.equal(res.status, 200);
    assert.equal(res.body.date, '2027-05-12');
    assert.equal((await req('POST', '/api/expiry/parse', { text: 'brak daty' })).body.date, null);
  });

  test('migracja dodaje kolumnę barcode do starej bazy', () => {
    const old = new Store(':memory:', { seed: false });
    old.db.exec('DROP INDEX idx_items_barcode; ALTER TABLE items DROP COLUMN barcode;');
    old.migrate();
    const cols = old.db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
    assert.ok(cols.includes('barcode'));
    old.close();
  });
});
