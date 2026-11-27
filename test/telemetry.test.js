'use strict';
/*
 * OpenTelemetry na żywo: serwer aplikacji wysyła ślady, metryki i logi przez OTLP/gRPC
 * (tak jak do proxy Zabbix 8 z APM) do odbiornika gRPC uruchomionego w teście.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const { TEST_URL } = require('./helpers');
const { routeName } = require('../src/metrics');
const { isEnabled } = require('../src/telemetry');

const received = { traces: [], metrics: [], logs: [] };
let grpcServer;
let app;
let base;

/** Odbiornik OTLP/gRPC: zapisuje surowe wiadomości (protobuf) – nazwy usług, śladów i metryk są w nich tekstem. */
function otlpService(kind, pkg, svc) {
  const raw = { serialize: (b) => b, deserialize: (b) => b };
  return {
    def: { Export: { path: `/opentelemetry.proto.collector.${pkg}.v1.${svc}/Export`, requestStream: false, responseStream: false, requestSerialize: raw.serialize, requestDeserialize: raw.deserialize, responseSerialize: raw.serialize, responseDeserialize: raw.deserialize } },
    impl: { Export: (call, cb) => { received[kind].push(call.request.toString('latin1')); cb(null, Buffer.alloc(0)); } },
  };
}

const waitFor = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};
const has = (kind, text) => received[kind].some((m) => m.includes(text));

before(async () => {
  grpcServer = new grpc.Server();
  for (const [kind, pkg, svc] of [['traces', 'trace', 'TraceService'], ['metrics', 'metrics', 'MetricsService'], ['logs', 'logs', 'LogsService']]) {
    const s = otlpService(kind, pkg, svc);
    grpcServer.addService(s.def, s.impl);
  }
  const port = await new Promise((res, rej) => grpcServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));

  // Wolny port dla serwera aplikacji.
  const appPort = await new Promise((res) => { const srv = require('node:net').createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); }); });
  app = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      DATABASE_URL: TEST_URL, PORT: String(appPort), HOST: '127.0.0.1', PRODUCT_LOOKUP: 'off',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
      OTEL_SERVICE_NAME: 'home-manager-test',
      OTEL_METRIC_EXPORT_INTERVAL: '500',
      OTEL_BSP_SCHEDULE_DELAY: '100',
      OTEL_BLRP_SCHEDULE_DELAY: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    app.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/działa: (http:\/\/[\d.]+:\d+)/);
      if (m) resolve(m[1]);
    });
    app.stderr.on('data', (d) => { out += d; });
    app.on('exit', (code) => reject(new Error(`serwer zakończył się (${code}): ${out}`)));
  });
});

after(async () => {
  app?.kill('SIGTERM');
  await new Promise((r) => (app && app.exitCode === null ? app.on('exit', r) : r()));
  grpcServer?.forceShutdown();
});

test('telemetria wyłączona bez zmiennych OTEL_*', () => {
  assert.equal(isEnabled({}), false);
  assert.equal(isEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x:4317' }), true);
  assert.equal(isEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x:4317', OTEL_SDK_DISABLED: 'true' }), false);
  assert.equal(isEnabled({ OTEL_METRICS_EXPORTER: 'prometheus' }), true);
});

test('nazwy tras w śladach', () => {
  assert.equal(routeName(/^\/api\/items\/(\d+)\/adjust$/), '/api/items/:id/adjust');
  assert.equal(routeName(/^\/api\/(categories|locations)\/(\d+)$/), '/api/{categories|locations}/:id');
});

test('/api/health – stan aplikacji i bazy (bez logowania)', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.database, 'ok');
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
});

test('ślady, metryki i logi trafiają do odbiornika OTLP/gRPC', async () => {
  await fetch(`${base}/api/auth/status`);
  await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'nikt', password: 'zlezlezle' }) });
  await fetch(`${base}/styles.css`); // pliki interfejsu nie są śledzone

  assert.ok(await waitFor(() => has('traces', 'GET /api/auth/status')), 'ślad GET /api/auth/status');
  assert.ok(has('traces', 'home-manager-test'), 'nazwa usługi w śladach');
  assert.ok(await waitFor(() => has('traces', 'POST /api/auth/login')), 'ślad logowania');
  assert.ok(await waitFor(() => has('traces', 'pg.query') || has('traces', 'SELECT')), 'zapytania do bazy w śladzie');
  assert.ok(!has('traces', 'styles.css'), 'pliki interfejsu pominięte');

  assert.ok(await waitFor(() => has('metrics', 'home_manager.login.attempts')), 'licznik logowań');
  assert.ok(await waitFor(() => has('metrics', 'home_manager.items.expired')), 'stan domu');
  assert.ok(has('metrics', 'home_manager.db.up'), 'stan bazy');
  assert.ok(await waitFor(() => has('metrics', 'http.server.request.duration')), 'czas odpowiedzi HTTP');

  assert.ok(await waitFor(() => has('logs', 'Baza danych')), 'logi aplikacji');
});
