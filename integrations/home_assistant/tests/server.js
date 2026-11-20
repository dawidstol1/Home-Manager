'use strict';
// Serwer aplikacji do testów wtyczki Home Assistant: osobny schemat bazy, konto, klucz API i przykładowe dane.
// Wypisuje {"url","token","user_id"} w jednej linii i działa do SIGTERM (wtedy usuwa schemat).
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..', '..', '..');
const { openTestStore, closeTestStore } = require(path.join(ROOT, 'test', 'helpers.js'));
const { createApp } = require(path.join(ROOT, 'src', 'app.js'));
const { today, addDays } = require(path.join(ROOT, 'src', 'db.js'));

(async () => {
  const store = await openTestStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-ha-'));
  const server = http.createServer(createApp(store, { productLookup: async () => null, imagesDir: dir, uploadsDir: dir }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const user = await store.createUser({ name: 'Dawid', login: 'dawid', role: 'admin' }, 'scrypt$x');
  const { token } = await store.createApiToken(user.id, 'Home Assistant');
  const t = today();
  await store.createItem({ name: 'Mleko', quantity: 1, min_quantity: 3, unit: 'l', barcode: '5900820000011', expires_at: addDays(t, 5) }, { userId: user.id });
  await store.createItem({ name: 'Ser', quantity: 1, expires_at: addDays(t, -2) }, { userId: user.id });
  await store.createItem({ name: 'Jogurt naturalny', quantity: 2, unit: 'szt.', expires_at: addDays(t, 2) }, { userId: user.id });
  await store.createUser({ name: 'Kasia', login: 'kasia' }, 'scrypt$x');
  await store.createMedicine({ name: 'Paracetamol', quantity: 20, unit: 'tabl.', purpose: 'ból, gorączka', person: 'Wszyscy', expires_at: addDays(t, 300) }, { userId: user.id });
  await store.createMedicine({ name: 'Ibuprom dla dzieci', form: 'zawiesina', quantity: 100, unit: 'ml', purpose: 'gorączka, ból zęba', person: 'Zosia', kit: 'Kuchnia', expires_at: addDays(t, 200) }, { userId: user.id });
  await store.createMedicine({ name: 'Stary syrop', quantity: 50, unit: 'ml', expires_at: addDays(t, -10) }, { userId: user.id });
  await store.createEvent({ title: 'Dentysta', starts_on: t, start_time: '23:00', end_time: '23:30', category: 'health' }, { userId: user.id });
  await store.createEvent({ title: 'Wywóz śmieci', starts_on: addDays(t, 1), repeat: 'weekly', category: 'home' }, { userId: user.id });
  await store.createEquipment({ name: 'Pralka', warranty_until: addDays(t, 3) });
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token, user_id: user.id })}\n`);
  const stop = async () => {
    server.closeAllConnections?.();
    server.close();
    await closeTestStore(store).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})().catch((e) => { console.error(e); process.exit(1); });
