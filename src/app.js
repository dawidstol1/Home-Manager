'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseExpiry } = require('./expiry');
const { createProductLookup } = require('./products');
const { createImageService } = require('./images');
const { toBarcode, ValidationError } = require('./db');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const MAX_BODY = 5 * 1024 * 1024;

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = body === undefined ? '' : isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Zbyt duże żądanie'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Nieprawidłowy JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const headers = { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' };
    // sw.js nie może być długo cache'owany, inaczej aktualizacje nie dotrą do klientów.
    if (path.basename(file) === 'sw.js') headers['Cache-Control'] = 'no-cache';
    send(res, 200, data, headers);
  });
}

/**
 * Tabela tras: [metoda, wzorzec, handler(ctx)].
 * Handler zwraca obiekt (200), { status, body } lub undefined (204).
 */
function buildRoutes(store, lookupProduct, images) {
  const withImage = async (pending) => {
    const item = await pending;
    if (item.barcode && !item.image) images.attachLater(item.id);
    return item;
  };
  return [
    // Zdjęcia produktów
    [
      'POST',
      /^\/api\/items\/(\d+)\/image$/,
      async ({ m }) => {
        const { item, found } = await images.attach(m[1], { force: true });
        if (!item.barcode) throw new ValidationError('Dodaj kod kreskowy, aby pobrać zdjęcie');
        return { item, found };
      },
    ],
    ['DELETE', /^\/api\/items\/(\d+)\/image$/, ({ m }) => store.updateItem(m[1], { image: null })],
    ['POST', /^\/api\/images\/fill$/, () => images.fillMissing()],

    // Skanowanie: znane zasoby z tym kodem + podpowiedź z bazy produktów, gdy brak dopasowań.
    // Kod w ścieżce (/api/barcode/5901234123457) lub w zapytaniu (/api/barcode?code=...).
    [
      'GET',
      /^\/api\/barcode(?:\/([^/]+))?$/,
      async ({ m, query }) => {
        let raw = query.get('code');
        if (m[1] !== undefined) {
          try {
            raw = decodeURIComponent(m[1]);
          } catch {
            throw new ValidationError('Nieprawidłowy kod kreskowy');
          }
        }
        const barcode = toBarcode(raw ?? '');
        if (!barcode) throw new ValidationError('Podaj kod kreskowy');
        const items = await store.listItems({ barcode });
        const product = items.length ? null : await lookupProduct(barcode);
        return { barcode, items, product };
      },
    ],
    ['POST', /^\/api\/expiry\/parse$/, ({ body }) => parseExpiry(String(body.text ?? '').slice(0, 5000))],

    ['GET', /^\/api\/stats$/, () => store.stats()],
    ['GET', /^\/api\/shopping-list$/, () => store.shoppingList()],
    ['GET', /^\/api\/export$/, () => store.exportAll()],
    ['POST', /^\/api\/import$/, ({ body }) => store.importAll(body)],

    ['GET', /^\/api\/(categories|locations)$/, ({ m }) => store.listDict(m[1])],
    ['POST', /^\/api\/(categories|locations)$/, async ({ m, body }) => ({ status: 201, body: await store.createDict(m[1], body.name) })],
    ['DELETE', /^\/api\/(categories|locations)\/(\d+)$/, ({ m }) => store.deleteDict(m[1], m[2])],

    ['GET', /^\/api\/items$/, ({ query }) => store.listItems(Object.fromEntries(query))],
    ['POST', /^\/api\/items$/, async ({ body }) => ({ status: 201, body: await withImage(store.createItem(body)) })],
    ['GET', /^\/api\/items\/(\d+)$/, ({ m }) => store.getItem(m[1])],
    ['PUT', /^\/api\/items\/(\d+)$/, ({ m, body }) => withImage(store.updateItem(m[1], body))],
    ['PATCH', /^\/api\/items\/(\d+)$/, ({ m, body }) => withImage(store.updateItem(m[1], body))],
    ['DELETE', /^\/api\/items\/(\d+)$/, ({ m }) => store.deleteItem(m[1])],
    ['POST', /^\/api\/items\/(\d+)\/adjust$/, ({ m, body }) => store.adjustQuantity(m[1], body.delta, body.note)],
    ['GET', /^\/api\/items\/(\d+)\/history$/, ({ m }) => store.getHistory(m[1])],
  ];
}

function createApp(store, { productLookup, images, imagesDir, imageFetch } = {}) {
  const lookupEnabled = process.env.PRODUCT_LOOKUP !== 'off';
  const lookup = productLookup ?? createProductLookup(store, { enabled: lookupEnabled });
  const imageService =
    images ??
    createImageService(store, {
      dir: imagesDir ?? path.join(__dirname, '..', 'data', 'images'),
      lookup,
      fetchImpl: imageFetch,
      enabled: lookupEnabled,
    });
  const routes = buildRoutes(store, lookup, imageService);

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    if (pathname.startsWith('/images/')) {
      const file = imageService.filePath(pathname.slice('/images/'.length));
      if (!file) return send(res, 404, 'Not found');
      return fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, 'Not found');
        send(res, 200, data, {
          'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
          'Cache-Control': 'public, max-age=86400',
        });
      });
    }

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, pathname);
    }

    const matching = routes.filter(([, re]) => re.test(pathname));
    if (!matching.length) return send(res, 404, { error: 'Nie znaleziono endpointu' });
    const route = matching.find(([method]) => method === req.method);
    if (!route) return send(res, 405, { error: 'Metoda niedozwolona' });

    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
      const result = await route[2]({ m: pathname.match(route[1]), body, query: url.searchParams });
      if (result === undefined) return send(res, 204);
      if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
        return send(res, result.status, result.body);
      }
      return send(res, 200, result);
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) console.error(err);
      return send(res, status, { error: status === 500 ? 'Błąd serwera' : err.message });
    }
  };
}

module.exports = { createApp };
