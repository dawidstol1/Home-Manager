'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'home-manager.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const store = new Store(DB_FILE);
const server = http.createServer(createApp(store));

server.listen(PORT, HOST, () => {
  console.log(`Manager zasobów domowych działa: http://${HOST}:${PORT}`);
  console.log(`Baza danych: ${DB_FILE}`);
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
