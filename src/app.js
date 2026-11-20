'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseExpiry } = require('./expiry');
const { parseReceipt } = require('./receipt');
const { createProductLookup } = require('./products');
const { createImageService } = require('./images');
const { createFileStore, MAX_UPLOAD } = require('./files');
const auth = require('./auth');
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
  '.woff2': 'font/woff2',
};
const MAX_JSON = 5 * 1024 * 1024;

const httpError = (status, message) => Object.assign(new Error(message), { status });

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

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > max) {
      reject(httpError(413, 'Zbyt duże żądanie'));
      req.resume();
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(httpError(413, 'Zbyt duże żądanie'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw httpError(400, 'Nieprawidłowy JSON');
  }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const headers = { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' };
    // Kod interfejsu zawsze sprawdzany na serwerze – inaczej aktualizacje nie dotrą do klientów.
    // Fonty i ikony się nie zmieniają, mogą leżeć w pamięci przeglądarki dłużej.
    headers['Cache-Control'] = ['.woff2', '.png', '.svg'].includes(path.extname(file)) ? 'public, max-age=604800' : 'no-cache';
    send(res, 200, data, headers);
  });
}

function contentDisposition(name, inline) {
  const safe = String(name || 'plik').replace(/[\r\n"]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * Tabela tras: [metoda, wzorzec, handler(ctx), opcje].
 * Opcje: public (bez logowania), admin (tylko administrator), raw (treść jako Buffer).
 * Handler zwraca obiekt (200), { status, body, headers } lub undefined (204).
 */
function buildRoutes({ store, lookupProduct, images, files, limiter, cfg }) {
  const withImage = async (pending) => {
    const item = await pending;
    if (item.barcode && !item.image) images.attachLater(item.id);
    return item;
  };

  async function startSession(user, req) {
    const token = auth.newToken();
    await store.createSession(user.id, auth.tokenHash(token), { days: auth.SESSION_DAYS, userAgent: req.headers['user-agent'] ?? '' });
    return {
      status: 200,
      body: { user, token },
      headers: { 'Set-Cookie': auth.sessionCookie(token, req, cfg) },
    };
  }

  const uid = (ctx) => ({ userId: ctx.user?.id ?? null });

  return [
    // ----- Konta -----
    [
      'GET', /^\/api\/auth\/status$/,
      async ({ user }) => ({ setup_required: (await store.countUsers()) === 0, user: user ?? null }),
      { public: true },
    ],
    [
      'POST', /^\/api\/auth\/setup$/,
      async ({ body, req }) => {
        const hash = await auth.hashPassword(body.password);
        const user = await store.createUser({ ...body, role: 'admin' }, hash, { onlyIfNoUsers: true });
        return startSession(user, req);
      },
      { public: true },
    ],
    [
      'POST', /^\/api\/auth\/login$/,
      async ({ body, req }) => {
        const key = auth.clientIp(req, cfg.trustProxy);
        limiter.check(key);
        const found = await store.findUserForLogin(body.login);
        const ok = found ? await auth.verifyPassword(body.password, found.password_hash) : (await auth.burnTime(body.password), false);
        if (!ok) {
          limiter.fail(key);
          throw httpError(401, 'Nieprawidłowy login lub hasło');
        }
        limiter.reset(key);
        const { password_hash: _h, ...user } = found;
        return startSession(user, req);
      },
      { public: true },
    ],
    [
      'POST', /^\/api\/auth\/logout$/,
      async ({ token }) => {
        if (token) await store.deleteSession(auth.tokenHash(token));
        return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': auth.clearCookie() } };
      },
      { public: true },
    ],
    ['GET', /^\/api\/auth\/me$/, ({ user }) => user],
    [
      'POST', /^\/api\/auth\/password$/,
      async ({ body, user, token }) => {
        const full = await store.findUserForLogin(user.login);
        if (!full || !(await auth.verifyPassword(body.current_password, full.password_hash))) {
          throw new ValidationError('Obecne hasło jest nieprawidłowe');
        }
        await store.updateUser(user.id, {}, await auth.hashPassword(body.new_password));
        // Wylogowanie z innych urządzeń po zmianie hasła.
        await store.deleteUserSessions(user.id, { exceptHash: auth.tokenHash(token) });
        return { ok: true };
      },
    ],
    ['GET', /^\/api\/users$/, () => store.listUsers()],
    [
      'POST', /^\/api\/users$/,
      async ({ body }) => ({ status: 201, body: await store.createUser(body, await auth.hashPassword(body.password)) }),
      { admin: true },
    ],
    [
      'PATCH', /^\/api\/users\/(\d+)$/,
      async ({ m, body }) => {
        const hash = body.password ? await auth.hashPassword(body.password) : null;
        const user = await store.updateUser(m[1], body, hash);
        if (hash) await store.deleteUserSessions(user.id);
        return user;
      },
      { admin: true },
    ],
    [
      'DELETE', /^\/api\/users\/(\d+)$/,
      ({ m, user }) => {
        if (Number(m[1]) === user.id) throw new ValidationError('Nie możesz usunąć własnego konta');
        return store.deleteUser(m[1]);
      },
      { admin: true },
    ],

    // ----- Zdjęcia produktów -----
    [
      'POST', /^\/api\/items\/(\d+)\/image$/,
      async ({ m }) => {
        const { item, found } = await images.attach(m[1], { force: true });
        if (!item.barcode) throw new ValidationError('Dodaj kod kreskowy, aby pobrać zdjęcie');
        return { item, found };
      },
    ],
    ['DELETE', /^\/api\/items\/(\d+)\/image$/, ({ m }) => store.updateItem(m[1], { image: null })],
    ['POST', /^\/api\/images\/fill$/, () => images.fillMissing()],

    // ----- Skanowanie -----
    // Kod w ścieżce (/api/barcode/5901234123457) lub w zapytaniu (/api/barcode?code=...).
    [
      'GET', /^\/api\/barcode(?:\/([^/]+))?$/,
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
    // Szybkie zużycie: zeskanowany kod → −1 z partii o najkrótszym terminie.
    [
      'POST', /^\/api\/consume$/,
      (ctx) => store.consumeByBarcode(ctx.body.barcode, { reason: ctx.body.reason, quantity: ctx.body.quantity, ...uid(ctx) }),
    ],
    ['POST', /^\/api\/history\/(\d+)\/undo$/, ({ m }) => store.undoHistory(m[1])],
    ['POST', /^\/api\/expiry\/parse$/, ({ body }) => parseExpiry(String(body.text ?? '').slice(0, 5000))],

    // ----- Paragony -----
    [
      'POST', /^\/api\/receipts\/parse$/,
      async ({ body }) => {
        const parsed = parseReceipt(String(body.text ?? '').slice(0, 20000));
        return { ...parsed, lines: await store.matchReceiptLines(parsed.lines) };
      },
    ],
    ['GET', /^\/api\/receipts$/, ({ query }) => store.listReceipts({ limit: query.get('limit') })],
    ['POST', /^\/api\/receipts$/, async (ctx) => ({ status: 201, body: await store.applyReceipt(ctx.body, uid(ctx)) })],
    ['GET', /^\/api\/receipts\/(\d+)$/, ({ m }) => store.getReceipt(m[1])],

    // ----- Raporty -----
    ['GET', /^\/api\/stats$/, () => store.stats()],
    ['GET', /^\/api\/reports$/, ({ query }) => store.reports({ months: query.get('months') })],
    ['GET', /^\/api\/shopping-list$/, () => store.shoppingList()],
    ['GET', /^\/api\/export$/, () => store.exportAll()],
    ['POST', /^\/api\/import$/, ({ body }) => store.importAll(body), { admin: true }],

    // ----- Słowniki -----
    ['GET', /^\/api\/(categories|locations)$/, ({ m }) => store.listDict(m[1])],
    ['POST', /^\/api\/(categories|locations)$/, async ({ m, body }) => ({ status: 201, body: await store.createDict(m[1], body.name) })],
    ['DELETE', /^\/api\/(categories|locations)\/(\d+)$/, ({ m }) => store.deleteDict(m[1], m[2])],

    // ----- Zasoby i partie -----
    ['GET', /^\/api\/items$/, ({ query }) => store.listItems(Object.fromEntries(query))],
    ['POST', /^\/api\/items$/, async (ctx) => ({ status: 201, body: await withImage(store.createItem(ctx.body, uid(ctx))) })],
    ['GET', /^\/api\/items\/(\d+)$/, ({ m }) => store.getItem(m[1])],
    ['PUT', /^\/api\/items\/(\d+)$/, (ctx) => withImage(store.updateItem(ctx.m[1], ctx.body, uid(ctx)))],
    ['PATCH', /^\/api\/items\/(\d+)$/, (ctx) => withImage(store.updateItem(ctx.m[1], ctx.body, uid(ctx)))],
    ['DELETE', /^\/api\/items\/(\d+)$/, ({ m }) => store.deleteItem(m[1])],
    [
      'POST', /^\/api\/items\/(\d+)\/adjust$/,
      ({ m, body, user }) => store.adjustQuantity(m[1], body.delta, {
        note: body.note, reason: body.reason, expires_at: body.expires_at, price: body.price,
        total: body.total, batch_id: body.batch_id, userId: user.id,
      }),
    ],
    ['GET', /^\/api\/items\/(\d+)\/history$/, ({ m }) => store.getHistory(m[1])],
    ['PATCH', /^\/api\/batches\/(\d+)$/, (ctx) => store.updateBatch(ctx.m[1], ctx.body, uid(ctx))],
    ['DELETE', /^\/api\/batches\/(\d+)$/, (ctx) => store.removeBatch(ctx.m[1], { reason: ctx.query.get('reason') ?? 'wasted', ...uid(ctx) })],

    // ----- Domowa apteka -----
    ['GET', /^\/api\/medicines$/, ({ query }) => store.listMedicines(Object.fromEntries(query))],
    ['POST', /^\/api\/medicines$/, async ({ body, user }) => ({ status: 201, body: await store.createMedicine(body, { userId: user.id }) })],
    ['GET', /^\/api\/medicines\/journal$/, ({ query }) => store.medicineJournal({ limit: query.get('limit') })],
    ['GET', /^\/api\/medicines\/suggestions$/, () => store.medicineSuggestions()],
    ['POST', /^\/api\/medicines\/dispose-expired$/, ({ user }) => store.disposeExpiredMedicines({ userId: user.id })],
    ['GET', /^\/api\/medicines\/(\d+)$/, ({ m }) => store.getMedicine(m[1])],
    ['PUT', /^\/api\/medicines\/(\d+)$/, ({ m, body }) => store.updateMedicine(m[1], body)],
    ['PATCH', /^\/api\/medicines\/(\d+)$/, ({ m, body }) => store.updateMedicine(m[1], body)],
    ['DELETE', /^\/api\/medicines\/(\d+)$/, ({ m }) => store.deleteMedicine(m[1])],
    ['POST', /^\/api\/medicines\/(\d+)\/packs$/, async ({ m, body, user }) => ({ status: 201, body: await store.addMedicinePack(m[1], body, { userId: user.id }) })],
    ['POST', /^\/api\/medicines\/(\d+)\/take$/, ({ m, body, user }) => store.takeMedicine(m[1], body, { userId: user.id })],
    ['PATCH', /^\/api\/medicine-packs\/(\d+)$/, ({ m, body, user }) => store.updateMedicinePack(m[1], body, { userId: user.id })],
    ['DELETE', /^\/api\/medicine-packs\/(\d+)$/, ({ m, user }) => store.removeMedicinePack(m[1], { userId: user.id })],
    ['POST', /^\/api\/medicine-log\/(\d+)\/undo$/, ({ m }) => store.undoMedicineLog(m[1])],

    // ----- Sprzęty i dokumenty -----
    ['GET', /^\/api\/equipment$/, ({ query }) => store.listEquipment(Object.fromEntries(query))],
    ['POST', /^\/api\/equipment$/, async ({ body }) => ({ status: 201, body: await store.createEquipment(body) })],
    ['GET', /^\/api\/equipment\/(\d+)$/, ({ m }) => store.getEquipment(m[1])],
    ['PUT', /^\/api\/equipment\/(\d+)$/, ({ m, body }) => store.updateEquipment(m[1], body)],
    ['PATCH', /^\/api\/equipment\/(\d+)$/, ({ m, body }) => store.updateEquipment(m[1], body)],
    [
      'DELETE', /^\/api\/equipment\/(\d+)$/,
      async ({ m }) => {
        const removed = await store.deleteEquipment(m[1]);
        await Promise.all(removed.map((f) => files.remove(f)));
      },
    ],
    // Przesłanie pliku: treść żądania = plik; nazwa, rodzaj i tytuł w parametrach adresu.
    [
      'POST', /^\/api\/equipment\/(\d+)\/documents$/,
      async ({ m, body, query, req, user }) => {
        await store.getEquipment(m[1]);
        const saved = await files.save(body, req.headers['content-type'] ?? '');
        try {
          const doc = await store.addDocument(m[1], {
            kind: query.get('kind'), title: query.get('title') ?? '', originalName: query.get('name') ?? '',
            ...saved, userId: user.id,
          });
          return { status: 201, body: doc };
        } catch (err) {
          await files.remove(saved.file);
          throw err;
        }
      },
      { raw: true },
    ],
    ['PATCH', /^\/api\/documents\/(\d+)$/, ({ m, body }) => store.updateDocument(m[1], body)],
    [
      'DELETE', /^\/api\/documents\/(\d+)$/,
      async ({ m }) => {
        await files.remove(await store.deleteDocument(m[1]));
      },
    ],
    [
      'GET', /^\/api\/documents\/(\d+)\/file$/,
      async ({ m, query, res }) => {
        const doc = await store.getDocument(m[1]);
        const p = files.filePath(doc.file);
        const data = p ? await fs.promises.readFile(p).catch(() => null) : null;
        if (!data) throw httpError(404, 'Plik dokumentu nie istnieje na serwerze');
        const inline = query.get('download') !== '1' && doc.mime !== 'image/heic' && doc.mime !== 'image/heif';
        send(res, 200, data, {
          'Content-Type': doc.mime === 'text/plain' ? 'text/plain; charset=utf-8' : doc.mime,
          'Content-Disposition': contentDisposition(doc.original_name || `${doc.title || 'dokument'}.${doc.file.split('.').pop()}`, inline),
          'Cache-Control': 'private, max-age=3600',
        });
        return send;
      },
    ],
  ];
}

/**
 * Opcje: productLookup, images, imagesDir, imageFetch (zdjęcia produktów),
 * uploadsDir (dokumenty), trustProxy (nagłówki X-Forwarded-* od nginx), secureCookies.
 */
function createApp(store, { productLookup, images, imagesDir, imageFetch, uploadsDir, trustProxy = false, secureCookies } = {}) {
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
  const files = createFileStore(uploadsDir ?? path.join(__dirname, '..', 'data', 'uploads'));
  const cfg = { trustProxy, secure: secureCookies };
  const routes = buildRoutes({ store, lookupProduct: lookup, images: imageService, files, limiter: auth.createLoginLimiter(), cfg });

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
    const [, re, handle, opts = {}] = route;

    try {
      const cred = auth.readToken(req);
      // Ochrona przed CSRF: zmiany z ciasteczkiem tylko z tej samej strony.
      if (cred?.via === 'cookie' && !['GET', 'HEAD'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin) {
          let host = null;
          try {
            host = new URL(origin).host;
          } catch { /* nieprawidłowy nagłówek */ }
          const allowed = [req.headers.host];
          if (trustProxy && req.headers['x-forwarded-host']) allowed.push(String(req.headers['x-forwarded-host']).split(',')[0].trim());
          if (!allowed.includes(host)) throw httpError(403, 'Żądanie z innej strony zostało zablokowane');
        }
      }
      const user = cred ? await store.getSessionUser(auth.tokenHash(cred.token), { days: auth.SESSION_DAYS }) : null;
      if (!opts.public && !user) throw httpError(401, 'Zaloguj się');
      if (opts.admin && user.role !== 'admin') throw httpError(403, 'Tylko administrator może to zrobić');

      let body = {};
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        body = opts.raw ? await readBody(req, MAX_UPLOAD) : await readJson(req);
      }
      const result = await handle({ m: pathname.match(re), body, query: url.searchParams, user, token: cred?.token, req, res });
      if (result === send) return undefined; // handler sam wysłał odpowiedź
      if (result === undefined) return send(res, 204);
      if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
        return send(res, result.status, result.body, result.headers);
      }
      return send(res, 200, result);
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.end();
      if (status === 413) res.setHeader('Connection', 'close');
      return send(res, status, { error: status === 500 ? 'Błąd serwera' : err.message });
    }
  };
}

module.exports = { createApp };
