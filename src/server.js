'use strict';

// OpenTelemetry musi wystartować przed załadowaniem http i pg (inaczej nie śledzi żądań i zapytań).
require('./telemetry').startIfEnabled();

const http = require('node:http');
const path = require('node:path');
const { Store, DEFAULT_URL } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATABASE_URL = process.env.DATABASE_URL || DEFAULT_URL;
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(__dirname, '..', 'data', 'images');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'data', 'uploads');
// Za reverse proxy (nginx): ufaj nagłówkom X-Forwarded-For / X-Forwarded-Proto.
const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY).toLowerCase());
// Wymuszenie flagi Secure ciasteczka (domyślnie: automatycznie, gdy połączenie jest po HTTPS).
const COOKIE_SECURE = process.env.COOKIE_SECURE === undefined ? undefined : ['1', 'true', 'yes'].includes(process.env.COOKIE_SECURE.toLowerCase());

/** Adres bazy bez hasła – do logów. */
function safeUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(nieprawidłowy DATABASE_URL)';
  }
}

async function main() {
  let store;
  // Baza w kontenerze może startować chwilę dłużej niż aplikacja – kilka prób połączenia.
  for (let attempt = 1; ; attempt++) {
    try {
      store = await Store.open({ connectionString: DATABASE_URL });
      break;
    } catch (err) {
      if (attempt >= 10) {
        console.error(`Nie udało się połączyć z PostgreSQL (${safeUrl(DATABASE_URL)}): ${err.message}`);
        process.exit(1);
      }
      console.log(`Czekam na PostgreSQL… (${attempt}/10: ${err.code || err.message})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Stan domu (produkty, terminy, leki, wydatki, połączenia z bazą) jako metryki OpenTelemetry.
  require('./metrics').observeStore(store);
  if (require('./telemetry').isEnabled()) {
    const env = process.env;
    if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      console.log(`OpenTelemetry: wysyłam do ${env.OTEL_EXPORTER_OTLP_ENDPOINT} (${env.OTEL_EXPORTER_OTLP_PROTOCOL || 'http/protobuf'})`);
    }
    if (/prometheus/.test(env.OTEL_METRICS_EXPORTER ?? '')) {
      console.log(`OpenTelemetry: metryki Prometheus na porcie ${env.OTEL_EXPORTER_PROMETHEUS_PORT || 9464} (/metrics)`);
    }
  }

  const server = http.createServer(createApp(store, {
    imagesDir: IMAGES_DIR,
    uploadsDir: UPLOADS_DIR,
    trustProxy: TRUST_PROXY,
    secureCookies: COOKIE_SECURE,
  }));
  server.listen(PORT, HOST, () => {
    console.log(`Manager zasobów domowych działa: http://${HOST}:${PORT}`);
    console.log(`Baza danych: ${safeUrl(DATABASE_URL)}`);
    store.countUsers().then((n) => {
      if (!n) console.log('Brak kont – otwórz aplikację w przeglądarce i utwórz konto administratora.');
    });
  });

  const shutdown = () => {
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
