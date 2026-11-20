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

test('klucze API: tworzenie, użycie, ograniczenia, usunięcie', async () => {
  const created = await req('POST', '/api/tokens', { name: 'Home Assistant' });
  assert.equal(created.status, 201);
  const key = created.body.token;
  assert.match(key, /^hm_[A-Za-z0-9_-]{40}$/);
  assert.equal(created.body.hint, key.slice(-4));
  assert.equal((await req('POST', '/api/tokens', { name: '' })).status, 400);

  const list = (await req('GET', '/api/tokens')).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].token, undefined, 'klucz pokazuje się tylko raz');

  const withKey = (method, p, body) => app.raw(method, p, { body, token: key });
  assert.equal((await withKey('GET', '/api/auth/me')).body.login, 'admin');
  assert.equal((await withKey('GET', '/api/stats')).status, 200);
  // Klucz nie zarządza kontami ani kluczami.
  assert.equal((await withKey('GET', '/api/tokens')).status, 403);
  assert.equal((await withKey('POST', '/api/users', { name: 'X', login: 'xxxx', password: 'haslo12345' })).status, 403);
  assert.equal((await withKey('POST', '/api/auth/password', { current_password: 'tajnehaslo', new_password: 'nowehaslo1' })).status, 403);
  assert.equal((await withKey('PUT', '/api/settings/embed', { origins: [] })).status, 403);
  assert.ok((await req('GET', '/api/tokens')).body[0].last_used_at);

  assert.equal((await app.raw('GET', '/api/stats', { token: 'hm_zly' })).status, 401);
  assert.equal((await req('DELETE', `/api/tokens/${created.body.id}`)).status, 204);
  assert.equal((await withKey('GET', '/api/stats')).status, 401);
});

test('osadzanie: lista adresów i nagłówek frame-ancestors', async () => {
  const before = await fetch(`${app.base}/`);
  assert.equal(before.headers.get('content-security-policy'), "frame-ancestors 'self'");

  assert.equal((await req('PUT', '/api/settings/embed', { origins: ['ftp://x'] })).status, 400);
  assert.equal((await req('PUT', '/api/settings/embed', { origins: ['http://ha.local:8123/lovelace'] })).status, 400);
  const saved = await req('PUT', '/api/settings/embed', { origins: ['http://192.168.1.10:8123/', 'https://ha.example.pl', 'https://ha.example.pl'] });
  assert.deepEqual(saved.body.origins, ['http://192.168.1.10:8123', 'https://ha.example.pl']);
  assert.deepEqual((await req('GET', '/api/settings/embed')).body.origins, saved.body.origins);

  const after = await fetch(`${app.base}/index.html`);
  assert.equal(after.headers.get('content-security-policy'), "frame-ancestors 'self' http://192.168.1.10:8123 https://ha.example.pl");
  const css = await fetch(`${app.base}/styles.css`);
  assert.equal(css.headers.get('content-security-policy'), null);
});

test('podsumowanie dla czujników', async () => {
  await req('POST', '/api/items', { name: 'Mleko', quantity: 1, min_quantity: 2, unit: 'l', expires_at: addDays(today(), -1) });
  await req('POST', '/api/items', { name: 'Jogurt', quantity: 3, expires_at: addDays(today(), 2) });
  await req('POST', '/api/medicines', { name: 'Syrop', quantity: 10, unit: 'ml', expires_at: addDays(today(), -3) });
  await req('POST', '/api/events', { title: 'Kino', starts_on: today(), start_time: '23:59' });
  await req('POST', '/api/events', { title: 'Sekret', starts_on: addDays(today(), 1), visibility: 'private' });

  const s = (await req('GET', '/api/integration/summary')).body;
  assert.equal(s.stats.low_stock, 1);
  assert.equal(s.stats.expired, 1);
  assert.equal(s.stats.med_expired, 1);
  assert.equal(s.stats.events_today, 1);
  assert.deepEqual(s.shopping.map((i) => i.name), ['Mleko']);
  assert.deepEqual(s.expired_items.map((i) => i.name), ['Mleko']);
  assert.deepEqual(s.expiring_items.map((i) => i.name), ['Jogurt']);
  assert.deepEqual(s.medicines.expired.map((m) => m.name), ['Syrop']);
  assert.equal(s.events_today[0].title, 'Kino');
  assert.equal(s.next_event.title, 'Kino');
  assert.equal((await app.raw('GET', '/api/integration/summary')).status, 401);
});
