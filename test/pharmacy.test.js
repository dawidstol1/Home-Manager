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

test('apteka: dodanie leku z opakowaniem, walidacja, wyszukiwanie', async () => {
  const created = await req('POST', '/api/medicines', {
    name: 'Paracetamol', substance: 'paracetamol', form: 'tabletki', strength: '500 mg',
    purpose: 'ból, gorączka', person: 'Wszyscy', kit: 'Łazienka', unit: 'tabl.', min_quantity: 5,
    quantity: 20, expires_at: addDays(today(), 400), dosage: '1–2 tabl. co 6 h, max 8 dziennie',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.quantity, 20);
  assert.equal(created.body.packs.length, 1);
  assert.equal(created.body.low, false);
  assert.equal(created.body.log[0].reason, 'added');

  assert.equal((await req('POST', '/api/medicines', { name: '' })).status, 400);
  assert.equal((await req('POST', '/api/medicines', { name: 'X', after_opening_days: -3 })).status, 400);
  assert.equal((await req('POST', '/api/medicines', { name: 'X', quantity: 2, expires_at: '12/2027' })).status, 400);

  assert.equal((await req('GET', '/api/medicines?q=gorączka')).body.length, 1);
  assert.equal((await req('GET', '/api/medicines?q=ibuprofen')).body.length, 0);
});

test('apteka: podanie leku zdejmuje z otwartego opakowania, dziennik i cofnięcie', async () => {
  const med = (await req('POST', '/api/medicines', {
    name: 'Ibuprom dla dzieci', form: 'syrop', unit: 'ml', quantity: 100, expires_at: addDays(today(), 200), after_opening_days: 180,
  })).body;
  const withSecond = (await req('POST', `/api/medicines/${med.id}/packs`, { quantity: 100, expires_at: addDays(today(), 100) })).body;
  assert.equal(withSecond.quantity, 200);

  const taken = await req('POST', `/api/medicines/${med.id}/take`, { amount: 5, person: 'Zosia' });
  assert.equal(taken.status, 200);
  assert.equal(taken.body.quantity, 195);
  assert.equal(taken.body.last_taken.person, 'Zosia');
  assert.equal(taken.body.last_taken.amount, 5);
  // Najpierw opakowanie z krótszym terminem; po otwarciu ma datę otwarcia.
  const opened = taken.body.packs.find((p) => p.opened_at);
  assert.equal(opened.quantity, 95);
  assert.equal(opened.opened_at, today());

  // Następne podanie idzie z tego samego (otwartego) opakowania.
  const again = (await req('POST', `/api/medicines/${med.id}/take`, { amount: 5, person: 'Zosia' })).body;
  assert.equal(again.packs.find((p) => p.opened_at).quantity, 90);

  const journal = (await req('GET', '/api/medicines/journal')).body;
  assert.equal(journal[0].name, 'Ibuprom dla dzieci');
  assert.equal(journal[0].amount, 5);
  assert.equal(journal[0].user_name, app.user.name);

  const undone = await req('POST', `/api/medicine-log/${again.log_id}/undo`);
  assert.equal(undone.body.quantity, 195);

  assert.equal((await req('POST', `/api/medicines/${med.id}/take`, { amount: 1000 })).status, 400);
  assert.equal((await req('POST', `/api/medicines/${med.id}/take`, { amount: 0 })).status, 400);
});

test('apteka: termin po otwarciu, przeterminowane nie są podawane, utylizacja', async () => {
  const med = (await req('POST', '/api/medicines', { name: 'Krople do oczu', unit: 'ml', after_opening_days: 28 })).body;
  const withPack = (await req('POST', `/api/medicines/${med.id}/packs`, {
    quantity: 10, expires_at: addDays(today(), 300), opened_at: addDays(today(), -40),
  })).body;
  // Otwarte 40 dni temu, ważne 28 dni po otwarciu → po terminie mimo daty na pudełku.
  assert.equal(withPack.has_expired, true);
  assert.equal(withPack.quantity, 0);
  assert.equal(withPack.expired_quantity, 10);
  assert.equal(withPack.packs[0].deadline, addDays(today(), -12));

  const refused = await req('POST', `/api/medicines/${med.id}/take`, { amount: 1 });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /przeterminowane/);

  const expiring = (await req('POST', `/api/medicines/${med.id}/packs`, { quantity: 10, expires_at: addDays(today(), 10) })).body;
  assert.equal(expiring.expiring, true);

  assert.ok((await req('GET', '/api/medicines?status=expired')).body.some((m) => m.id === med.id));
  assert.ok((await req('GET', '/api/medicines?status=expiring')).body.some((m) => m.id === med.id));

  const stats = (await req('GET', '/api/stats')).body;
  assert.ok(stats.med_expired >= 1);
  assert.ok(stats.medicines >= 1);

  const disposed = (await req('POST', '/api/medicines/dispose-expired')).body;
  assert.ok(disposed.medicines.includes('Krople do oczu'));
  const after = (await req('GET', `/api/medicines/${med.id}`)).body;
  assert.equal(after.has_expired, false);
  assert.equal(after.packs.length, 1);
  assert.equal(after.log[0].reason, 'disposed');
});

test('apteka: edycja opakowania, usunięcie, niski stan, podpowiedzi, kopia zapasowa', async () => {
  const med = (await req('POST', '/api/medicines', { name: 'Witamina D', person: 'Kasia', kit: 'Kuchnia', min_quantity: 10, quantity: 12 })).body;
  const packId = med.packs[0].id;
  const edited = (await req('PATCH', `/api/medicine-packs/${packId}`, { quantity: 8 })).body;
  assert.equal(edited.quantity, 8);
  assert.equal(edited.low, true);
  assert.ok((await req('GET', '/api/medicines?status=low')).body.some((m) => m.id === med.id));

  const sug = (await req('GET', '/api/medicines/suggestions')).body;
  assert.ok(sug.persons.includes('Kasia'));
  assert.ok(sug.kits.includes('Kuchnia'));

  const removed = (await req('DELETE', `/api/medicine-packs/${packId}`)).body;
  assert.equal(removed.packs.length, 0);

  const exp = (await req('GET', '/api/export')).body;
  assert.ok(exp.medicines.some((m) => m.name === 'Witamina D'));
  assert.ok(Array.isArray(exp.medicine_packs));
  const imported = await req('POST', '/api/import', exp);
  assert.equal(imported.status, 200);
  assert.equal(imported.body.medicines, exp.medicines.length);
  assert.equal((await req('GET', '/api/medicines')).body.length, exp.medicines.length);

  assert.equal((await req('DELETE', `/api/medicines/${med.id}`)).status, 204);
  assert.equal((await req('GET', `/api/medicines/${med.id}`)).status, 404);
});

test('apteka: wymaga zalogowania', async () => {
  const res = await app.raw('GET', '/api/medicines', { token: null });
  assert.equal(res.status, 401);
});
