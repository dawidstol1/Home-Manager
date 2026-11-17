'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('./helpers');
const { today, addDays } = require('../src/db');

let app;
const req = (...a) => app.req(...a);
before(async () => {
  app = await startApp({ productLookup: async () => null });
});
after(() => app.close());

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const upload = (id, buf, query = '', type = 'application/pdf', token = app.token) =>
  app.raw('POST', `/api/equipment/${id}/documents?${query}`, { body: buf, token, headers: { 'Content-Type': type } });

test('sprzęt: dodawanie, edycja, walidacja, wyszukiwanie', async () => {
  const locs = (await req('GET', '/api/locations')).body;
  const created = await req('POST', '/api/equipment', {
    name: 'Pralka', brand: 'Bosch', model: 'Serie 4', serial_number: 'SN123', location_id: locs[2].id,
    purchase_date: '2025-03-10', price: 1899.99, shop: 'Media Expert', warranty_until: addDays(today(), 20),
    next_service_at: addDays(today(), 5),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.location, locs[2].name);
  assert.deepEqual(created.body.documents, []);

  const upd = await req('PATCH', `/api/equipment/${created.body.id}`, { notes: 'Filtr co 3 mies.' });
  assert.equal(upd.body.notes, 'Filtr co 3 mies.');
  assert.equal(upd.body.brand, 'Bosch');

  assert.equal((await req('POST', '/api/equipment', { name: '' })).status, 400);
  assert.equal((await req('POST', '/api/equipment', { name: 'X', warranty_until: '31.12.2026' })).status, 400);
  assert.equal((await req('GET', '/api/equipment?q=bosch')).body.length, 1);

  const stats = (await req('GET', '/api/stats')).body;
  assert.equal(stats.warranty_ending, 1);
  assert.equal(stats.service_due, 1);
});

test('dokumenty: przesyłanie, pobieranie tylko po zalogowaniu, usuwanie', async () => {
  const { body: eq } = await req('POST', '/api/equipment', { name: 'Telewizor' });
  const name = encodeURIComponent('Gwarancja – telewizor.pdf');
  const up = await upload(eq.id, PDF, `kind=warranty&title=Karta%20gwarancyjna&name=${name}`);
  assert.equal(up.status, 201);
  assert.equal(up.body.mime, 'application/pdf');
  assert.equal(up.body.kind, 'warranty');

  const photo = await upload(eq.id, PNG, 'kind=photo&name=tv.png', 'image/png');
  assert.equal(photo.body.mime, 'image/png');
  const full = (await req('GET', `/api/equipment/${eq.id}`)).body;
  assert.equal(full.documents.length, 2);
  assert.equal(full.photo_document_id, photo.body.id);

  const file = await fetch(`${app.base}/api/documents/${up.body.id}/file`, { headers: { Authorization: `Bearer ${app.token}` } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.match(file.headers.get('content-disposition'), /inline; .*filename\*=UTF-8''Gwarancja%20%E2%80%93%20telewizor\.pdf/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF);
  assert.equal((await fetch(`${app.base}/api/documents/${up.body.id}/file`)).status, 401);

  // Niedozwolone pliki (np. HTML udający PDF) są odrzucane.
  const html = await upload(eq.id, Buffer.from('<html><script>alert(1)</script></html>'), 'name=x.pdf');
  assert.equal(html.status, 400);
  assert.equal((await upload(eq.id, Buffer.alloc(0))).status, 400);
  assert.equal((await upload(999999, PDF)).status, 404);

  const renamed = await req('PATCH', `/api/documents/${up.body.id}`, { title: 'Gwarancja 5 lat', kind: 'nieznany' });
  assert.equal(renamed.body.title, 'Gwarancja 5 lat');
  assert.equal(renamed.body.kind, 'other');

  const stored = path.join(app.dir, 'uploads', up.body.file);
  assert.ok(fs.existsSync(stored));
  assert.equal((await req('DELETE', `/api/documents/${up.body.id}`)).status, 204);
  assert.ok(!fs.existsSync(stored));

  // Usunięcie sprzętu kasuje jego pliki.
  const photoFile = path.join(app.dir, 'uploads', photo.body.file);
  assert.equal((await req('DELETE', `/api/equipment/${eq.id}`)).status, 204);
  assert.ok(!fs.existsSync(photoFile));
  assert.equal((await req('GET', `/api/equipment/${eq.id}`)).status, 404);
});

test('import zapasów nie usuwa sprzętów i zachowuje ich miejsce', async () => {
  const locs = (await req('GET', '/api/locations')).body;
  const { body: eq } = await req('POST', '/api/equipment', { name: 'Wiertarka', location_id: locs.find((l) => l.name === 'Garaż').id });
  const exported = (await req('GET', '/api/export')).body;
  assert.equal((await req('POST', '/api/import', exported)).status, 200);
  const after = (await req('GET', `/api/equipment/${eq.id}`)).body;
  assert.equal(after.location, 'Garaż');
});
