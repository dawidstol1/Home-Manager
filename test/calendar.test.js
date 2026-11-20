'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { today, addDays } = require('../src/db');

let app;
let kasia;
const req = (...a) => app.req(...a);
const asKasia = (method, p, body) => app.raw(method, p, { body, token: kasia.token });

before(async () => {
  app = await startApp({ productLookup: async () => null });
  await req('POST', '/api/users', { name: 'Kasia', login: 'kasia', password: 'kasia12345' });
  const login = await app.raw('POST', '/api/auth/login', { body: { login: 'kasia', password: 'kasia12345' } });
  kasia = { token: login.body.token, id: login.body.user.id };
});
after(() => app.close());

test('kalendarz: dodanie, walidacja, edycja, usunięcie', async () => {
  const created = await req('POST', '/api/events', {
    title: 'Dentysta – Zosia', starts_on: '2026-12-03', start_time: '9:30', end_time: '10:15', category: 'health',
    for_users: [kasia.id], notes: 'ul. Długa 5',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.start_time, '09:30');
  assert.equal(created.body.visibility, 'shared');
  assert.deepEqual(created.body.for_users, [kasia.id]);
  assert.equal(created.body.owner_name, 'Admin');

  assert.equal((await req('POST', '/api/events', { title: '', starts_on: '2026-12-03' })).status, 400);
  assert.equal((await req('POST', '/api/events', { title: 'X' })).status, 400);
  assert.equal((await req('POST', '/api/events', { title: 'X', starts_on: '2026-12-03', start_time: '25:00' })).status, 400);
  assert.equal((await req('POST', '/api/events', { title: 'X', starts_on: '2026-12-03', ends_on: '2026-12-01' })).status, 400);
  assert.equal((await req('POST', '/api/events', { title: 'X', starts_on: '2026-12-03', start_time: '10:00', end_time: '09:00' })).status, 400);

  const upd = await req('PATCH', `/api/events/${created.body.id}`, { start_time: '11:00', end_time: null });
  assert.equal(upd.body.start_time, '11:00');
  assert.equal(upd.body.end_time, null);

  const list = (await req('GET', '/api/events?from=2026-12-01&to=2026-12-31')).body;
  assert.ok(list.some((e) => e.id === created.body.id && e.date === '2026-12-03'));

  assert.equal((await req('DELETE', `/api/events/${created.body.id}`)).status, 204);
  assert.equal((await req('GET', `/api/events/${created.body.id}`)).status, 404);
});

test('kalendarz: wpisy prywatne widzi tylko autor, wspólne – wszyscy', async () => {
  const priv = (await asKasia('POST', '/api/events', { title: 'Prezent dla Dawida', starts_on: '2026-12-10', visibility: 'private' })).body;
  const shared = (await asKasia('POST', '/api/events', { title: 'Wigilia u babci', starts_on: '2026-12-24', category: 'family' })).body;

  const adminView = (await req('GET', '/api/events?from=2026-12-01&to=2026-12-31')).body;
  assert.ok(!adminView.some((e) => e.id === priv.id));
  assert.ok(adminView.some((e) => e.id === shared.id));
  assert.equal((await req('GET', `/api/events/${priv.id}`)).status, 404);
  assert.equal((await req('PATCH', `/api/events/${priv.id}`, { title: 'X' })).status, 404);
  assert.equal((await req('DELETE', `/api/events/${priv.id}`)).status, 404);

  const kasiaView = (await asKasia('GET', '/api/events?from=2026-12-01&to=2026-12-31')).body;
  assert.ok(kasiaView.some((e) => e.id === priv.id));

  // Wspólny wpis może poprawić każdy, ale prywatnym zrobić go może tylko autor.
  assert.equal((await req('PATCH', `/api/events/${shared.id}`, { notes: 'Barszcz robi Dawid' })).status, 200);
  assert.equal((await req('PATCH', `/api/events/${shared.id}`, { visibility: 'private' })).status, 400);

  const mine = (await asKasia('GET', '/api/events?from=2026-12-01&to=2026-12-31&mine=1')).body;
  assert.ok(mine.every((e) => e.owner_id === kasia.id));
});

test('kalendarz: powtarzanie co tydzień, co miesiąc (31.), co rok (29 lutego), do daty', async () => {
  const weekly = (await req('POST', '/api/events', { title: 'Wywóz śmieci', starts_on: '2026-11-02', repeat: 'weekly', category: 'home' })).body;
  const dec = (await req('GET', '/api/events?from=2026-12-01&to=2026-12-31')).body.filter((e) => e.id === weekly.id).map((e) => e.date);
  assert.deepEqual(dec, ['2026-12-07', '2026-12-14', '2026-12-21', '2026-12-28']);

  const monthly = (await req('POST', '/api/events', { title: 'Czynsz', starts_on: '2026-01-31', repeat: 'monthly', repeat_until: '2026-05-31' })).body;
  const m = (await req('GET', '/api/events?from=2026-01-01&to=2026-12-31')).body.filter((e) => e.id === monthly.id).map((e) => e.date);
  assert.deepEqual(m, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);

  const bday = (await req('POST', '/api/events', { title: 'Urodziny Leona', starts_on: '2024-02-29', repeat: 'yearly', category: 'birthday' })).body;
  const inYear = async (yr) => (await req('GET', `/api/events?from=${yr}-01-01&to=${yr}-12-31`)).body.filter((e) => e.id === bday.id).map((e) => e.date);
  const y = [...await inYear(2027), ...await inYear(2028)];
  assert.deepEqual(y, ['2027-02-28', '2028-02-29']);

  const biweekly = (await req('POST', '/api/events', { title: 'Basen', starts_on: '2026-12-01', repeat: 'biweekly' })).body;
  const b = (await req('GET', '/api/events?from=2026-12-01&to=2026-12-31')).body.filter((e) => e.id === biweekly.id).map((e) => e.date);
  assert.deepEqual(b, ['2026-12-01', '2026-12-15', '2026-12-29']);

  assert.equal((await req('GET', '/api/events?from=2026-01-01&to=2028-12-31')).status, 400);
});

test('kalendarz: wpis wielodniowy widać w zakresie, który zaczyna się w trakcie', async () => {
  const trip = (await req('POST', '/api/events', { title: 'Ferie w górach', starts_on: '2027-01-28', ends_on: '2027-02-03', category: 'trip' })).body;
  const feb = (await req('GET', '/api/events?from=2027-02-01&to=2027-02-28')).body.find((e) => e.id === trip.id);
  assert.equal(feb.date, '2027-01-28');
  assert.equal(feb.end_date, '2027-02-03');
});

test('kalendarz: terminy z domu (gwarancja, przegląd, lek)', async () => {
  const day = addDays(today(), 5);
  await req('POST', '/api/equipment', { name: 'Pralka', warranty_until: day, next_service_at: addDays(today(), 6) });
  await req('POST', '/api/medicines', { name: 'Syrop', quantity: 100, expires_at: addDays(today(), 7) });
  const without = (await req('GET', `/api/events?from=${today()}&to=${addDays(today(), 10)}`)).body;
  assert.ok(!without.some((e) => e.readonly));
  const withHome = (await req('GET', `/api/events?from=${today()}&to=${addDays(today(), 10)}&home=1`)).body.filter((e) => e.readonly);
  assert.deepEqual(withHome.map((e) => e.title), ['Koniec gwarancji: Pralka', 'Przegląd: Pralka', 'Koniec ważności leku: Syrop']);
});
