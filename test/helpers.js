'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/db');
const { createApp } = require('../src/app');

const TEST_URL = process.env.TEST_DATABASE_URL || 'postgres://homemanager:homemanager@localhost:5432/homemanager_test';

/** Każdy plik testów dostaje własny, tymczasowy schemat w testowej bazie PostgreSQL. */
async function openTestStore(options = {}) {
  const schema = `t_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  return Store.open({ connectionString: TEST_URL, schema, max: 4, ...options });
}

async function closeTestStore(store) {
  await store.dropSchema();
  await store.close();
}

/**
 * Uruchamia serwer testowy z własną bazą i katalogami plików, zakłada konto administratora
 * i zwraca funkcję `req` wysyłającą żądania z jego tokenem.
 */
async function startApp(appOptions = {}, { login = true } = {}) {
  const store = await openTestStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-test-'));
  const server = http.createServer(createApp(store, {
    imagesDir: path.join(dir, 'images'),
    uploadsDir: path.join(dir, 'uploads'),
    ...appOptions,
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function raw(method, p, { body, token, headers = {} } = {}) {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(body !== undefined && !isBuf ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  const ctx = { store, base, dir, server, raw, token: null, user: null };
  if (login) {
    const setup = await raw('POST', '/api/auth/setup', { body: { name: 'Admin', login: 'admin', password: 'tajnehaslo' } });
    if (setup.status !== 200) throw new Error(`setup: ${JSON.stringify(setup.body)}`);
    ctx.token = setup.body.token;
    ctx.user = setup.body.user;
  }
  ctx.req = (method, p, body, opts = {}) => raw(method, p, { body, token: ctx.token, ...opts });
  ctx.close = async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await closeTestStore(store);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return ctx;
}

module.exports = { openTestStore, closeTestStore, startApp, TEST_URL };
