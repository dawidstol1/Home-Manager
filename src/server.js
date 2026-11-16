'use strict';

const http = require('node:http');
const path = require('node:path');
const { Store, DEFAULT_URL } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATABASE_URL = process.env.DATABASE_URL || DEFAULT_URL;
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(__dirname, '..', 'data', 'images');

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

  const server = http.createServer(createApp(store, { imagesDir: IMAGES_DIR }));
  server.listen(PORT, HOST, () => {
    console.log(`Manager zasobów domowych działa: http://${HOST}:${PORT}`);
    console.log(`Baza danych: ${safeUrl(DATABASE_URL)}`);
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
