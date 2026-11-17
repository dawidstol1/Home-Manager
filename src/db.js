'use strict';

/**
 * Warstwa danych na PostgreSQL.
 * Wszystkie metody są asynchroniczne; kształt zwracanych obiektów jest taki sam jak w API
 * (daty jako 'RRRR-MM-DD', znaczniki czasu jako 'RRRR-MM-DD GG:MM:SS' w UTC).
 *
 * Stan magazynowy produktu to suma jego partii (`batches`) – każda partia ma własną datę ważności.
 * Kolumny items.quantity i items.expires_at są utrzymywane jako suma / najbliższy termin partii.
 */

const { Pool, types } = require('pg');

const DEFAULT_URL = 'postgres://homemanager:homemanager@localhost:5432/homemanager';
const REPORT_TZ = process.env.REPORT_TZ || 'Europe/Warsaw';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS categories_name_ci ON categories (lower(name));

CREATE TABLE IF NOT EXISTS locations (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS locations_name_ci ON locations (lower(name));

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,
  login         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_login_ci ON users (lower(login));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS items (
  id           SERIAL PRIMARY KEY,
  name         TEXT             NOT NULL,
  category_id  INTEGER          REFERENCES categories(id) ON DELETE SET NULL,
  location_id  INTEGER          REFERENCES locations(id)  ON DELETE SET NULL,
  quantity     DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit         TEXT             NOT NULL DEFAULT 'szt.',
  min_quantity DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
  price        DOUBLE PRECISION CHECK (price IS NULL OR price >= 0),
  expires_at   DATE,
  notes        TEXT             NOT NULL DEFAULT '',
  barcode      TEXT,
  image        TEXT,
  created_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS batches (
  id         SERIAL PRIMARY KEY,
  item_id    INTEGER          NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity   DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
  expires_at DATE,
  created_at TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batches_item ON batches(item_id);

CREATE TABLE IF NOT EXISTS receipts (
  id           SERIAL PRIMARY KEY,
  shop         TEXT             NOT NULL DEFAULT '',
  purchased_on DATE             NOT NULL,
  total        DOUBLE PRECISION,
  user_id      INTEGER          REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS history (
  id         SERIAL PRIMARY KEY,
  item_id    INTEGER          NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  delta      DOUBLE PRECISION NOT NULL,
  note       TEXT             NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ      NOT NULL DEFAULT now()
);
ALTER TABLE history ADD COLUMN IF NOT EXISTS reason     TEXT NOT NULL DEFAULT 'other';
ALTER TABLE history ADD COLUMN IF NOT EXISTS amount     DOUBLE PRECISION;
ALTER TABLE history ADD COLUMN IF NOT EXISTS expires_at DATE;
ALTER TABLE history ADD COLUMN IF NOT EXISTS user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE history ADD COLUMN IF NOT EXISTS receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL;

-- Zapamiętane dopasowania „nazwa z paragonu → produkt”.
CREATE TABLE IF NOT EXISTS receipt_aliases (
  name_key TEXT PRIMARY KEY,
  item_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS equipment (
  id              SERIAL PRIMARY KEY,
  name            TEXT             NOT NULL,
  brand           TEXT             NOT NULL DEFAULT '',
  model           TEXT             NOT NULL DEFAULT '',
  serial_number   TEXT             NOT NULL DEFAULT '',
  location_id     INTEGER          REFERENCES locations(id) ON DELETE SET NULL,
  purchase_date   DATE,
  price           DOUBLE PRECISION CHECK (price IS NULL OR price >= 0),
  shop            TEXT             NOT NULL DEFAULT '',
  warranty_until  DATE,
  next_service_at DATE,
  notes           TEXT             NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id            SERIAL PRIMARY KEY,
  equipment_id  INTEGER     NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  kind          TEXT        NOT NULL DEFAULT 'other',
  title         TEXT        NOT NULL DEFAULT '',
  file          TEXT        NOT NULL UNIQUE,
  original_name TEXT        NOT NULL DEFAULT '',
  mime          TEXT        NOT NULL,
  size          INTEGER     NOT NULL,
  user_id       INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_equipment ON documents(equipment_id);

CREATE TABLE IF NOT EXISTS barcode_cache (
  barcode    TEXT PRIMARY KEY,
  data       JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_id);
CREATE INDEX IF NOT EXISTS idx_items_location ON items(location_id);
CREATE INDEX IF NOT EXISTS idx_items_barcode  ON items(barcode);
CREATE INDEX IF NOT EXISTS idx_history_item   ON history(item_id);
CREATE INDEX IF NOT EXISTS idx_history_time   ON history(created_at);

-- Migracja starszych danych: wpisy historii bez powodu i produkty bez partii.
UPDATE history SET reason = CASE
    WHEN note = 'Edycja' THEN 'correction'
    WHEN delta < 0 THEN 'used'
    WHEN note = 'Utworzenie' THEN 'initial'
    ELSE 'purchase' END
  WHERE reason = 'other';
INSERT INTO batches (item_id, quantity, expires_at)
  SELECT i.id, i.quantity, i.expires_at FROM items i
  WHERE i.quantity > 0 AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.item_id = i.id);
`;

const DEFAULT_CATEGORIES = ['Żywność', 'Chemia domowa', 'Kosmetyki', 'Leki', 'Narzędzia', 'Elektronika', 'Inne'];
const DEFAULT_LOCATIONS = ['Kuchnia', 'Spiżarnia', 'Łazienka', 'Garaż', 'Piwnica'];

const REASONS = {
  initial: 'Stan początkowy',
  purchase: 'Zakup',
  used: 'Zużycie',
  wasted: 'Wyrzucone',
  correction: 'Korekta',
};
const DOC_KINDS = ['receipt', 'warranty', 'manual', 'invoice', 'photo', 'other'];

const ITEM_SELECT = `
  SELECT i.*, c.name AS category, l.name AS location,
         (SELECT COUNT(*) FROM batches b WHERE b.item_id = i.id) AS batch_count
  FROM items i
  LEFT JOIN categories c ON c.id = i.category_id
  LEFT JOIN locations  l ON l.id = i.location_id
`;

const EQUIPMENT_SELECT = `
  SELECT e.*, l.name AS location,
         (SELECT COUNT(*) FROM documents d WHERE d.equipment_id = e.id) AS document_count,
         (SELECT d.id FROM documents d
           WHERE d.equipment_id = e.id AND d.kind = 'photo' AND d.mime LIKE 'image/%'
           ORDER BY d.id LIMIT 1) AS photo_document_id
  FROM equipment e
  LEFT JOIN locations l ON l.id = e.location_id
`;

// Typy PostgreSQL → wartości JS zgodne z API.
const pad = (n) => String(n).padStart(2, '0');
const TYPE_PARSERS = {
  20: (v) => Number(v), // int8 (COUNT, SUM po int)
  1082: (v) => v, // date → 'RRRR-MM-DD' bez stref czasowych
  1184: (v) => {
    // timestamptz → 'RRRR-MM-DD GG:MM:SS' (UTC)
    const d = new Date(v);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  },
};
const pgTypes = { getTypeParser: (oid, format) => TYPE_PARSERS[oid] ?? types.getTypeParser(oid, format) };

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

class NotFoundError extends Error {
  constructor(message = 'Nie znaleziono') {
    super(message);
    this.status = 404;
  }
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const round2 = (n) => Math.round(n * 100) / 100;

function toNumber(value, field, { required = false, allowNull = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`Pole "${field}" jest wymagane`);
    return allowNull ? null : undefined;
  }
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 1e9) {
    throw new ValidationError(`Pole "${field}" musi być nieujemną liczbą`);
  }
  return n;
}

function toDate(value, field = 'Data ważności') {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} musi mieć format RRRR-MM-DD`);
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new ValidationError(`${field}: nieprawidłowa data`);
  return value;
}

function toId(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new ValidationError('Nieprawidłowy identyfikator');
  return n;
}

function toText(value, max) {
  if (value === undefined) return undefined;
  return String(value ?? '').trim().slice(0, max);
}

function toBarcode(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const code = String(value).trim();
  if (!code) return null;
  if (code.length > 64 || !/^[\x21-\x7E]+$/.test(code)) {
    throw new ValidationError('Kod kreskowy może zawierać maksymalnie 64 znaki ASCII bez spacji');
  }
  return code;
}

function toReason(value, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) throw new ValidationError('Nieprawidłowy powód zmiany stanu');
  return value;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Klucz do porównywania nazw: małe litery, bez polskich znaków i interpunkcji. */
function nameKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const isUniqueViolation = (err) => err?.code === '23505';
const isForeignKeyViolation = (err) => err?.code === '23503';

class Store {
  /**
   * Otwiera połączenie, tworzy schemat (jeśli trzeba) i domyślne słowniki.
   * `schema` pozwala trzymać dane w osobnym schemacie (np. w testach).
   */
  static async open({ connectionString = process.env.DATABASE_URL || DEFAULT_URL, schema = null, seed = true, max = 10 } = {}) {
    if (schema && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Nieprawidłowa nazwa schematu');
    const pool = new Pool({
      connectionString,
      max,
      types: pgTypes,
      ...(schema ? { options: `-c search_path=${schema}` } : {}),
    });
    const store = new Store(pool, schema);
    if (schema) await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await store.init({ seed });
    return store;
  }

  constructor(pool, schema = null) {
    this.pool = pool;
    this.schema = schema;
  }

  async init({ seed }) {
    // Blokada doradcza: kilka instancji startujących naraz nie tworzy schematu równolegle.
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(727001)');
      await client.query(SCHEMA);
      if (seed) await this.seedDefaults(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  /** Usuwa cały schemat (tylko dla baz testowych z własnym schematem). */
  async dropSchema() {
    if (!this.schema) throw new Error('Brak własnego schematu');
    await this.pool.query(`DROP SCHEMA ${this.schema} CASCADE`);
  }

  q(sql, params = [], client = this.pool) {
    return client.query(sql, params);
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async seedDefaults(client = this.pool) {
    for (const [table, names] of [['categories', DEFAULT_CATEGORIES], ['locations', DEFAULT_LOCATIONS]]) {
      const { rows } = await client.query(`SELECT COUNT(*) AS n FROM ${table}`);
      if (rows[0].n === 0) {
        await client.query(`INSERT INTO ${table} (name) SELECT unnest($1::text[])`, [names]);
      }
    }
  }

  // ---------- Słowniki (kategorie / lokalizacje) ----------

  #dictTable(kind) {
    if (kind !== 'categories' && kind !== 'locations') throw new NotFoundError();
    return kind;
  }

  async listDict(kind) {
    const table = this.#dictTable(kind);
    const fk = kind === 'categories' ? 'category_id' : 'location_id';
    const { rows } = await this.q(
      `SELECT d.id, d.name, COUNT(i.id) AS item_count
       FROM ${table} d LEFT JOIN items i ON i.${fk} = d.id
       GROUP BY d.id ORDER BY lower(d.name)`
    );
    return rows;
  }

  async createDict(kind, name) {
    const table = this.#dictTable(kind);
    const clean = String(name ?? '').trim();
    if (!clean) throw new ValidationError('Nazwa jest wymagana');
    if (clean.length > 100) throw new ValidationError('Nazwa może mieć maksymalnie 100 znaków');
    try {
      const { rows } = await this.q(`INSERT INTO ${table} (name) VALUES ($1) RETURNING id, name`, [clean]);
      return { ...rows[0], item_count: 0 };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ValidationError(`"${clean}" już istnieje`);
      throw err;
    }
  }

  async deleteDict(kind, id) {
    const table = this.#dictTable(kind);
    const { rowCount } = await this.q(`DELETE FROM ${table} WHERE id = $1`, [toId(id)]);
    if (!rowCount) throw new NotFoundError();
  }

  // ---------- Zasoby ----------

  async listItems({ q, category_id, location_id, status, barcode } = {}, client = this.pool) {
    const where = [];
    const params = [];
    const p = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (q) {
      const like = p(`%${String(q).replace(/[\\%_]/g, '\\$&')}%`);
      where.push(`(i.name ILIKE ${like} OR i.notes ILIKE ${like} OR i.barcode = ${p(String(q).trim())})`);
    }
    if (category_id) where.push(`i.category_id = ${p(toId(category_id))}`);
    if (location_id) where.push(`i.location_id = ${p(toId(location_id))}`);
    if (barcode) where.push(`i.barcode = ${p(toBarcode(barcode))}`);
    if (status === 'low') {
      where.push('i.min_quantity > 0 AND i.quantity <= i.min_quantity');
    } else if (status === 'expiring') {
      where.push(`i.expires_at IS NOT NULL AND i.expires_at <= ${p(addDays(today(), 7))}`);
    } else if (status === 'expired') {
      where.push(`i.expires_at IS NOT NULL AND i.expires_at < ${p(today())}`);
    }
    const sql = `${ITEM_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY lower(i.name), i.id`;
    const { rows } = await this.q(sql, params, client);
    return rows;
  }

  /** Zasób razem z listą partii (od najkrótszego terminu). */
  async getItem(id, client = this.pool) {
    const { rows } = await this.q(`${ITEM_SELECT} WHERE i.id = $1`, [toId(id)], client);
    if (!rows.length) throw new NotFoundError('Nie znaleziono zasobu');
    const { rows: batches } = await this.q(
      `SELECT id, quantity, expires_at, created_at FROM batches
       WHERE item_id = $1 ORDER BY expires_at NULLS LAST, id`,
      [rows[0].id],
      client
    );
    return { ...rows[0], batches };
  }

  #normalizeItem(input, { partial }) {
    const out = {};
    if (!partial || input.name !== undefined) {
      const name = String(input.name ?? '').trim();
      if (!name) throw new ValidationError('Nazwa zasobu jest wymagana');
      if (name.length > 200) throw new ValidationError('Nazwa może mieć maksymalnie 200 znaków');
      out.name = name;
    }
    const map = {
      category_id: toId(input.category_id),
      location_id: toId(input.location_id),
      quantity: toNumber(input.quantity, 'ilość'),
      min_quantity: toNumber(input.min_quantity, 'stan minimalny'),
      price: input.price === undefined ? undefined : toNumber(input.price, 'cena', { allowNull: true }),
      expires_at: toDate(input.expires_at),
      unit: input.unit === undefined ? undefined : String(input.unit).trim().slice(0, 20) || 'szt.',
      notes: input.notes === undefined ? undefined : String(input.notes).slice(0, 2000),
      barcode: toBarcode(input.barcode),
      // Klient może tylko usunąć zdjęcie; nazwę pliku ustawia wyłącznie serwer.
      image: input.image === null ? null : undefined,
    };
    for (const [k, v] of Object.entries(map)) if (v !== undefined) out[k] = v;
    return out;
  }

  #fkError(err) {
    if (isForeignKeyViolation(err)) return new ValidationError('Wybrana kategoria lub lokalizacja nie istnieje');
    return err;
  }

  async #insertItem(c, data) {
    const cols = Object.keys(data);
    const { rows } = await c.query(
      `INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((k) => data[k])
    );
    return rows[0].id;
  }

  async createItem(input, { userId = null } = {}) {
    const { quantity = 0, expires_at: expiresAt = null, ...data } = this.#normalizeItem(input ?? {}, { partial: false });
    try {
      return await this.transaction(async (c) => {
        const id = await this.#insertItem(c, data);
        if (quantity > 0) {
          await this.#addStock(c, id, quantity, { expiresAt, reason: 'initial', note: 'Utworzenie', userId });
        }
        return this.getItem(id, c);
      });
    } catch (err) {
      throw this.#fkError(err);
    }
  }

  /**
   * Edycja zasobu. Zmiana ilości dodaje partię (z datą z formularza) albo zdejmuje
   * najstarsze partie; zmiana daty dotyczy jedynej partii (przy wielu partiach – edycja partii).
   */
  async updateItem(id, input, { userId = null } = {}) {
    const { quantity, expires_at: expiresAt, ...data } = this.#normalizeItem(input ?? {}, { partial: true });
    const cols = Object.keys(data);
    try {
      return await this.transaction(async (c) => {
        const itemId = toId(id);
        const current = await this.#lockItem(c, itemId);
        if (cols.length) {
          await c.query(
            `UPDATE items SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1}`,
            [...cols.map((k) => data[k]), itemId]
          );
        }
        const { rows: batches } = await c.query('SELECT id, expires_at FROM batches WHERE item_id = $1 ORDER BY id', [itemId]);
        if (expiresAt !== undefined && batches.length === 1 && batches[0].expires_at !== expiresAt) {
          await c.query('UPDATE batches SET expires_at = $1 WHERE id = $2', [expiresAt, batches[0].id]);
        }
        if (quantity !== undefined && round3(quantity - current.quantity) !== 0) {
          const diff = round3(quantity - current.quantity);
          if (diff > 0) {
            const date = expiresAt !== undefined ? expiresAt : (batches.at(-1)?.expires_at ?? null);
            await this.#addStock(c, itemId, diff, { expiresAt: date, reason: 'correction', note: 'Edycja', userId });
          } else {
            await this.#takeStock(c, itemId, -diff, { reason: 'correction', note: 'Edycja', userId });
          }
        }
        await this.#syncItem(c, itemId);
        return this.getItem(itemId, c);
      });
    } catch (err) {
      throw this.#fkError(err);
    }
  }

  async deleteItem(id) {
    const { rowCount } = await this.q('DELETE FROM items WHERE id = $1', [toId(id)]);
    if (!rowCount) throw new NotFoundError('Nie znaleziono zasobu');
  }

  // ---------- Partie i ruchy magazynowe ----------

  async #lockItem(c, itemId) {
    const { rows } = await c.query('SELECT id, name, quantity, unit, price FROM items WHERE id = $1 FOR UPDATE', [itemId]);
    if (!rows.length) throw new NotFoundError('Nie znaleziono zasobu');
    return rows[0];
  }

  /** Przelicza stan i najbliższy termin zasobu z jego partii. */
  async #syncItem(c, itemId) {
    await c.query(
      `UPDATE items SET
         quantity   = COALESCE((SELECT round(SUM(quantity)::numeric, 3)::float8 FROM batches WHERE item_id = $1), 0),
         expires_at = (SELECT MIN(expires_at) FROM batches WHERE item_id = $1),
         updated_at = now()
       WHERE id = $1`,
      [itemId]
    );
  }

  async #logHistory(c, { itemId, delta, reason, note = '', amount = null, expiresAt = null, userId = null, receiptId = null, at = null }) {
    const { rows } = await c.query(
      `INSERT INTO history (item_id, delta, reason, note, amount, expires_at, user_id, receipt_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now())) RETURNING id`,
      [itemId, delta, reason, String(note || REASONS[reason] || '').slice(0, 200), amount == null ? null : round2(amount), expiresAt, userId, receiptId, at]
    );
    return rows[0].id;
  }

  /** Dokłada ilość jako partię (łączy z istniejącą partią o tej samej dacie). */
  async #addStock(c, itemId, qty, { expiresAt = null, reason = 'purchase', note = '', amount = null, userId = null, receiptId = null, at = null } = {}) {
    const { rows } = await c.query(
      'SELECT id FROM batches WHERE item_id = $1 AND expires_at IS NOT DISTINCT FROM $2 ORDER BY id LIMIT 1 FOR UPDATE',
      [itemId, expiresAt]
    );
    if (rows.length) {
      await c.query('UPDATE batches SET quantity = round((quantity + $1)::numeric, 3)::float8 WHERE id = $2', [qty, rows[0].id]);
    } else {
      await c.query('INSERT INTO batches (item_id, quantity, expires_at) VALUES ($1, $2, $3)', [itemId, round3(qty), expiresAt]);
    }
    const historyId = await this.#logHistory(c, { itemId, delta: round3(qty), reason, note, amount, expiresAt, userId, receiptId, at });
    await this.#syncItem(c, itemId);
    return [historyId];
  }

  /**
   * Zdejmuje ilość ze stanu – najpierw z partii o najkrótszym terminie (FIFO),
   * albo z konkretnej partii. Każda naruszona partia to osobny wpis historii.
   */
  async #takeStock(c, itemId, qty, { batchId = null, reason = 'used', note = '', userId = null } = {}) {
    const item = await this.#lockItem(c, itemId);
    const { rows: batches } = await c.query(
      `SELECT id, quantity, expires_at FROM batches
       WHERE item_id = $1 ${batchId ? 'AND id = $2' : ''}
       ORDER BY expires_at NULLS LAST, id FOR UPDATE`,
      batchId ? [itemId, batchId] : [itemId]
    );
    if (batchId && !batches.length) throw new NotFoundError('Nie znaleziono partii');
    const available = round3(batches.reduce((s, b) => s + b.quantity, 0));
    if (qty > available + 1e-9) {
      throw new ValidationError(`Brak wystarczającej ilości (dostępne: ${available} ${item.unit})`);
    }
    const ids = [];
    let left = qty;
    for (const b of batches) {
      if (left <= 1e-9) break;
      const take = round3(Math.min(left, b.quantity));
      if (take >= b.quantity - 1e-9) await c.query('DELETE FROM batches WHERE id = $1', [b.id]);
      else await c.query('UPDATE batches SET quantity = round((quantity - $1)::numeric, 3)::float8 WHERE id = $2', [take, b.id]);
      const amount = reason === 'wasted' && item.price != null ? take * item.price : null;
      ids.push(await this.#logHistory(c, { itemId, delta: -take, reason, note, amount, expiresAt: b.expires_at, userId }));
      left = round3(left - take);
    }
    await this.#syncItem(c, itemId);
    return ids;
  }

  /**
   * Zmienia stan o delta (dodatnia = zakup/uzupełnienie, ujemna = zużycie lub wyrzucenie).
   * Opcje: reason, note, expires_at (data nowej partii), price (cena jedn.), total (kwota zakupu),
   * batch_id (z której partii zdjąć). Atomowo – bez wyścigów między urządzeniami.
   */
  async adjustQuantity(id, delta, options = {}) {
    const opts = typeof options === 'string' ? { note: options } : (options ?? {});
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) throw new ValidationError('Zmiana ilości musi być niezerową liczbą');
    const itemId = toId(id);
    const result = await this.transaction(async (c) => {
      const item = await this.#lockItem(c, itemId);
      if (d > 0) {
        const reason = toReason(opts.reason, ['purchase', 'correction', 'initial'], 'purchase');
        const price = toNumber(opts.price, 'cena', { allowNull: true });
        const total = toNumber(opts.total, 'kwota', { allowNull: true });
        let expiresAt = toDate(opts.expires_at);
        if (expiresAt === undefined) {
          // Bez podanej daty nowa sztuka dostaje termin najnowszej partii (zwykle ten sam produkt).
          const { rows } = await c.query('SELECT expires_at FROM batches WHERE item_id = $1 ORDER BY id DESC LIMIT 1', [itemId]);
          expiresAt = rows[0]?.expires_at ?? null;
        }
        const unitPrice = price ?? (total != null ? total / d : null);
        if (unitPrice != null) await c.query('UPDATE items SET price = $1 WHERE id = $2', [round2(unitPrice), itemId]);
        const amount = reason === 'purchase'
          ? (total ?? (unitPrice ?? item.price) * d)
          : null;
        const historyIds = await this.#addStock(c, itemId, d, {
          expiresAt, reason, note: opts.note, amount: Number.isFinite(amount) ? amount : null, userId: opts.userId,
        });
        return { historyIds };
      }
      const reason = toReason(opts.reason, ['used', 'wasted', 'correction'], 'used');
      const historyIds = await this.#takeStock(c, itemId, round3(-d), {
        batchId: toId(opts.batch_id) ?? null, reason, note: opts.note, userId: opts.userId,
      });
      return { historyIds };
    });
    const item = await this.getItem(itemId);
    return opts.withHistory ? { item, history_ids: result.historyIds } : item;
  }

  /** Szybkie zużycie po zeskanowaniu kodu: −1 z partii o najkrótszym terminie. */
  async consumeByBarcode(barcode, { reason = 'used', quantity = 1, userId = null } = {}) {
    const code = toBarcode(barcode);
    if (!code) throw new ValidationError('Podaj kod kreskowy');
    const items = await this.listItems({ barcode: code });
    if (!items.length) throw new NotFoundError('Nie masz produktu z tym kodem');
    const inStock = items.filter((i) => i.quantity > 0)
      .sort((a, b) => (a.expires_at ?? '9999').localeCompare(b.expires_at ?? '9999') || a.id - b.id);
    if (!inStock.length) throw new ValidationError(`„${items[0].name}” – brak na stanie`);
    const target = inStock[0];
    const q = toNumber(quantity, 'ilość') || 1;
    const take = Math.min(q, target.quantity);
    const res = await this.adjustQuantity(target.id, -take, { reason, note: 'Skan', userId, withHistory: true });
    return { ...res, taken: take };
  }

  /** Cofa zużycie / wyrzucenie: przywraca partię z tą samą datą i usuwa wpis historii. */
  async undoHistory(historyId) {
    return this.transaction(async (c) => {
      const { rows } = await c.query('SELECT * FROM history WHERE id = $1 FOR UPDATE', [toId(historyId)]);
      const h = rows[0];
      if (!h) throw new NotFoundError('Nie znaleziono wpisu historii');
      if (h.delta >= 0) throw new ValidationError('Cofnąć można tylko zużycie lub wyrzucenie');
      await this.#lockItem(c, h.item_id);
      const { rows: same } = await c.query(
        'SELECT id FROM batches WHERE item_id = $1 AND expires_at IS NOT DISTINCT FROM $2 ORDER BY id LIMIT 1',
        [h.item_id, h.expires_at]
      );
      if (same.length) {
        await c.query('UPDATE batches SET quantity = round((quantity + $1)::numeric, 3)::float8 WHERE id = $2', [-h.delta, same[0].id]);
      } else {
        await c.query('INSERT INTO batches (item_id, quantity, expires_at) VALUES ($1, $2, $3)', [h.item_id, -h.delta, h.expires_at]);
      }
      await c.query('DELETE FROM history WHERE id = $1', [h.id]);
      await this.#syncItem(c, h.item_id);
      return this.getItem(h.item_id, c);
    });
  }

  async #lockBatch(c, batchId) {
    const { rows } = await c.query('SELECT item_id FROM batches WHERE id = $1', [toId(batchId)]);
    if (!rows.length) throw new NotFoundError('Nie znaleziono partii');
    await this.#lockItem(c, rows[0].item_id);
    const { rows: locked } = await c.query('SELECT * FROM batches WHERE id = $1 FOR UPDATE', [toId(batchId)]);
    if (!locked.length) throw new NotFoundError('Nie znaleziono partii');
    return locked[0];
  }

  /** Edycja partii: data ważności i/lub ilość (zmiana ilości trafia do historii jako korekta). */
  async updateBatch(batchId, input = {}, { userId = null } = {}) {
    const expiresAt = toDate(input.expires_at);
    const quantity = toNumber(input.quantity, 'ilość');
    return this.transaction(async (c) => {
      const b = await this.#lockBatch(c, batchId);
      if (quantity === 0) {
        await this.#takeStock(c, b.item_id, b.quantity, { batchId: b.id, reason: 'correction', userId });
        return this.getItem(b.item_id, c);
      }
      if (expiresAt !== undefined) await c.query('UPDATE batches SET expires_at = $1 WHERE id = $2', [expiresAt, b.id]);
      if (quantity !== undefined && round3(quantity - b.quantity) !== 0) {
        const diff = round3(quantity - b.quantity);
        await c.query('UPDATE batches SET quantity = $1 WHERE id = $2', [round3(quantity), b.id]);
        await this.#logHistory(c, {
          itemId: b.item_id, delta: diff, reason: 'correction', note: 'Edycja partii',
          expiresAt: expiresAt !== undefined ? expiresAt : b.expires_at, userId,
        });
      }
      await this.#syncItem(c, b.item_id);
      return this.getItem(b.item_id, c);
    });
  }

  /** Zdejmuje całą partię (zużyta / wyrzucona / korekta). */
  async removeBatch(batchId, { reason = 'wasted', userId = null } = {}) {
    const r = toReason(reason, ['used', 'wasted', 'correction'], 'wasted');
    return this.transaction(async (c) => {
      const b = await this.#lockBatch(c, batchId);
      await this.#takeStock(c, b.item_id, b.quantity, { batchId: b.id, reason: r, userId });
      return this.getItem(b.item_id, c);
    });
  }

  async getHistory(id) {
    const item = await this.getItem(id);
    const { rows } = await this.q(
      `SELECT h.id, h.delta, h.note, h.reason, h.amount, h.expires_at, h.receipt_id, h.created_at, u.name AS user_name
       FROM history h LEFT JOIN users u ON u.id = h.user_id
       WHERE h.item_id = $1 ORDER BY h.id DESC LIMIT 100`,
      [item.id]
    );
    return rows;
  }

  /** Zapisuje plik zdjęcia dla zasobu i dla innych pozycji z tym kodem, które jeszcze go nie mają. */
  async setImageForBarcode(barcode, file, { overwrite = false, itemId = null } = {}) {
    await this.q(
      'UPDATE items SET image = $1, updated_at = now() WHERE barcode = $2 AND (image IS NULL OR id = $3 OR $4)',
      [file, barcode, itemId ?? -1, overwrite]
    );
  }

  // ---------- Cache bazy produktów ----------

  async getCachedProduct(barcode) {
    const { rows } = await this.q(
      'SELECT data, extract(epoch FROM fetched_at) * 1000 AS fetched_ms FROM barcode_cache WHERE barcode = $1',
      [barcode]
    );
    return rows[0] ? { data: rows[0].data, fetchedAt: Number(rows[0].fetched_ms) } : null;
  }

  async putCachedProduct(barcode, data) {
    await this.q(
      `INSERT INTO barcode_cache (barcode, data, fetched_at) VALUES ($1, $2, now())
       ON CONFLICT (barcode) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
      [barcode, data === null ? null : JSON.stringify(data)]
    );
  }

  // ---------- Paragony ----------

  /** Podpowiada produkty dla pozycji paragonu: zapamiętane dopasowania, potem podobieństwo nazw. */
  async matchReceiptLines(lines) {
    const { rows: aliases } = await this.q(
      'SELECT a.name_key, i.id, i.name FROM receipt_aliases a JOIN items i ON i.id = a.item_id WHERE a.name_key = ANY($1)',
      [lines.map((l) => nameKey(l.name))]
    );
    const byAlias = new Map(aliases.map((a) => [a.name_key, a]));
    const { rows: items } = await this.q('SELECT id, name FROM items');
    const prepared = items.map((i) => ({ ...i, tokens: tokens(i.name) }));
    return lines.map((line) => {
      const alias = byAlias.get(nameKey(line.name));
      if (alias) return { ...line, match: { item_id: alias.id, name: alias.name, score: 1, remembered: true } };
      const lt = tokens(line.name);
      let best = null;
      for (const it of prepared) {
        const score = similarity(lt, it.tokens);
        if (score > (best?.score ?? 0)) best = { item_id: it.id, name: it.name, score: round2(score) };
      }
      return { ...line, match: best && best.score >= 0.5 ? best : null };
    });
  }

  /**
   * Zapisuje paragon: każda pozycja z item_id dokłada partię do istniejącego produktu,
   * pozycja z `create` tworzy nowy produkt. Kwoty trafiają do wydatków z datą paragonu.
   */
  async applyReceipt(input = {}, { userId = null } = {}) {
    const date = toDate(input.date, 'Data paragonu') || today();
    const shop = toText(input.shop ?? '', 100);
    const lines = Array.isArray(input.lines) ? input.lines : [];
    if (!lines.length) throw new ValidationError('Paragon nie zawiera pozycji do zapisania');
    if (lines.length > 200) throw new ValidationError('Zbyt wiele pozycji');
    const prepared = lines.map((l, idx) => {
      const quantity = toNumber(l.quantity, 'ilość') || 1;
      const total = toNumber(l.total, 'kwota', { allowNull: true });
      const itemId = toId(l.item_id) ?? null;
      const create = !itemId && l.create ? this.#normalizeItem({ name: l.create.name ?? l.name, ...l.create, quantity: undefined, expires_at: undefined }, { partial: false }) : null;
      if (!itemId && !create) throw new ValidationError(`Pozycja ${idx + 1}: wybierz produkt albo „nowy produkt”`);
      return { name: toText(l.name ?? '', 200), quantity, total, itemId, create, expiresAt: toDate(l.expires_at) ?? null };
    });
    const totalInput = toNumber(input.total, 'suma', { allowNull: true });
    const sum = round2(prepared.reduce((s, l) => s + (l.total ?? 0), 0));
    try {
      return await this.transaction(async (c) => {
        const { rows } = await c.query(
          'INSERT INTO receipts (shop, purchased_on, total, user_id) VALUES ($1, $2, $3, $4) RETURNING id',
          [shop, date, totalInput ?? sum, userId]
        );
        const receiptId = rows[0].id;
        const at = `${date}T12:00:00Z`;
        let created = 0;
        for (const l of prepared) {
          let itemId = l.itemId;
          if (!itemId) {
            itemId = await this.#insertItem(c, l.create);
            created += 1;
          } else {
            await this.#lockItem(c, itemId);
          }
          if (l.total != null) await c.query('UPDATE items SET price = $1 WHERE id = $2', [round2(l.total / l.quantity), itemId]);
          await this.#addStock(c, itemId, l.quantity, {
            expiresAt: l.expiresAt, reason: 'purchase', note: shop ? `Paragon: ${shop}` : 'Paragon',
            amount: l.total, userId, receiptId, at,
          });
          const key = nameKey(l.name);
          if (key) {
            await c.query(
              `INSERT INTO receipt_aliases (name_key, item_id) VALUES ($1, $2)
               ON CONFLICT (name_key) DO UPDATE SET item_id = excluded.item_id`,
              [key, itemId]
            );
          }
        }
        return { receipt_id: receiptId, lines: prepared.length, created, total: totalInput ?? sum };
      });
    } catch (err) {
      throw this.#fkError(err);
    }
  }

  async listReceipts({ limit = 20 } = {}) {
    const { rows } = await this.q(
      `SELECT r.id, r.shop, r.purchased_on, r.total, r.created_at, u.name AS user_name,
              (SELECT COUNT(*) FROM history h WHERE h.receipt_id = r.id) AS line_count
       FROM receipts r LEFT JOIN users u ON u.id = r.user_id
       ORDER BY r.purchased_on DESC, r.id DESC LIMIT $1`,
      [Math.min(Number(limit) || 20, 100)]
    );
    return rows;
  }

  async getReceipt(id) {
    const { rows } = await this.q('SELECT * FROM receipts WHERE id = $1', [toId(id)]);
    if (!rows.length) throw new NotFoundError('Nie znaleziono paragonu');
    const { rows: lines } = await this.q(
      `SELECT h.id, h.item_id, i.name, h.delta AS quantity, i.unit, h.amount
       FROM history h JOIN items i ON i.id = h.item_id WHERE h.receipt_id = $1 ORDER BY h.id`,
      [rows[0].id]
    );
    return { ...rows[0], lines };
  }

  // ---------- Sprzęty i dokumenty ----------

  #normalizeEquipment(input, { partial }) {
    const out = {};
    if (!partial || input.name !== undefined) {
      const name = String(input.name ?? '').trim();
      if (!name) throw new ValidationError('Nazwa sprzętu jest wymagana');
      if (name.length > 200) throw new ValidationError('Nazwa może mieć maksymalnie 200 znaków');
      out.name = name;
    }
    const map = {
      brand: toText(input.brand, 100),
      model: toText(input.model, 100),
      serial_number: toText(input.serial_number, 100),
      shop: toText(input.shop, 100),
      notes: input.notes === undefined ? undefined : String(input.notes ?? '').slice(0, 4000),
      location_id: toId(input.location_id),
      purchase_date: toDate(input.purchase_date, 'Data zakupu'),
      warranty_until: toDate(input.warranty_until, 'Gwarancja do'),
      next_service_at: toDate(input.next_service_at, 'Następny przegląd'),
      price: input.price === undefined ? undefined : toNumber(input.price, 'cena', { allowNull: true }),
    };
    for (const [k, v] of Object.entries(map)) if (v !== undefined) out[k] = v;
    return out;
  }

  async listEquipment({ q, location_id } = {}) {
    const where = [];
    const params = [];
    if (q) {
      params.push(`%${String(q).replace(/[\\%_]/g, '\\$&')}%`);
      where.push(`(e.name ILIKE $1 OR e.brand ILIKE $1 OR e.model ILIKE $1 OR e.serial_number ILIKE $1 OR e.notes ILIKE $1)`);
    }
    if (location_id) {
      params.push(toId(location_id));
      where.push(`e.location_id = $${params.length}`);
    }
    const { rows } = await this.q(
      `${EQUIPMENT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY lower(e.name), e.id`,
      params
    );
    return rows;
  }

  async getEquipment(id, client = this.pool) {
    const { rows } = await this.q(`${EQUIPMENT_SELECT} WHERE e.id = $1`, [toId(id)], client);
    if (!rows.length) throw new NotFoundError('Nie znaleziono sprzętu');
    const { rows: documents } = await this.q(
      `SELECT d.id, d.kind, d.title, d.original_name, d.mime, d.size, d.created_at, u.name AS user_name
       FROM documents d LEFT JOIN users u ON u.id = d.user_id
       WHERE d.equipment_id = $1 ORDER BY d.id`,
      [rows[0].id],
      client
    );
    return { ...rows[0], documents };
  }

  async createEquipment(input) {
    const data = this.#normalizeEquipment(input ?? {}, { partial: false });
    const cols = Object.keys(data);
    try {
      const { rows } = await this.q(
        `INSERT INTO equipment (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        cols.map((k) => data[k])
      );
      return this.getEquipment(rows[0].id);
    } catch (err) {
      throw this.#fkError(err);
    }
  }

  async updateEquipment(id, input) {
    const data = this.#normalizeEquipment(input ?? {}, { partial: true });
    const cols = Object.keys(data);
    if (cols.length) {
      try {
        const { rowCount } = await this.q(
          `UPDATE equipment SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1}`,
          [...cols.map((k) => data[k]), toId(id)]
        );
        if (!rowCount) throw new NotFoundError('Nie znaleziono sprzętu');
      } catch (err) {
        throw this.#fkError(err);
      }
    }
    return this.getEquipment(id);
  }

  /** Usuwa sprzęt i zwraca nazwy plików jego dokumentów (do skasowania z dysku). */
  async deleteEquipment(id) {
    return this.transaction(async (c) => {
      const { rows } = await c.query('SELECT file FROM documents WHERE equipment_id = $1', [toId(id)]);
      const { rowCount } = await c.query('DELETE FROM equipment WHERE id = $1', [toId(id)]);
      if (!rowCount) throw new NotFoundError('Nie znaleziono sprzętu');
      return rows.map((r) => r.file);
    });
  }

  async addDocument(equipmentId, { kind, title, file, originalName, mime, size, userId = null }) {
    const k = DOC_KINDS.includes(kind) ? kind : 'other';
    try {
      const { rows } = await this.q(
        `INSERT INTO documents (equipment_id, kind, title, file, original_name, mime, size, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [toId(equipmentId), k, toText(title ?? '', 200), file, toText(originalName ?? '', 200), mime, size, userId]
      );
      return this.getDocument(rows[0].id);
    } catch (err) {
      if (isForeignKeyViolation(err)) throw new NotFoundError('Nie znaleziono sprzętu');
      throw err;
    }
  }

  async getDocument(id) {
    const { rows } = await this.q('SELECT * FROM documents WHERE id = $1', [toId(id)]);
    if (!rows.length) throw new NotFoundError('Nie znaleziono dokumentu');
    return rows[0];
  }

  async updateDocument(id, input = {}) {
    const doc = await this.getDocument(id);
    const kind = input.kind === undefined ? doc.kind : DOC_KINDS.includes(input.kind) ? input.kind : 'other';
    const title = input.title === undefined ? doc.title : toText(input.title, 200);
    await this.q('UPDATE documents SET kind = $1, title = $2 WHERE id = $3', [kind, title, doc.id]);
    return this.getDocument(doc.id);
  }

  async deleteDocument(id) {
    const { rows } = await this.q('DELETE FROM documents WHERE id = $1 RETURNING file', [toId(id)]);
    if (!rows.length) throw new NotFoundError('Nie znaleziono dokumentu');
    return rows[0].file;
  }

  // ---------- Użytkownicy i sesje ----------

  async countUsers() {
    const { rows } = await this.q('SELECT COUNT(*) AS n FROM users');
    return rows[0].n;
  }

  async listUsers() {
    const { rows } = await this.q('SELECT id, name, login, role, created_at FROM users ORDER BY lower(name), id');
    return rows;
  }

  async getUser(id) {
    const { rows } = await this.q('SELECT id, name, login, role, created_at FROM users WHERE id = $1', [toId(id)]);
    if (!rows.length) throw new NotFoundError('Nie znaleziono użytkownika');
    return rows[0];
  }

  /** Zwraca użytkownika razem ze skrótem hasła (tylko do logowania). */
  async findUserForLogin(login) {
    const { rows } = await this.q('SELECT * FROM users WHERE lower(login) = lower($1)', [String(login ?? '').trim()]);
    return rows[0] ?? null;
  }

  static normalizeUser(input, { partial }) {
    const out = {};
    if (!partial || input.name !== undefined) {
      const name = String(input.name ?? '').trim();
      if (!name) throw new ValidationError('Podaj imię');
      if (name.length > 60) throw new ValidationError('Imię może mieć maksymalnie 60 znaków');
      out.name = name;
    }
    if (!partial || input.login !== undefined) {
      const login = String(input.login ?? '').trim();
      if (!/^[A-Za-z0-9._@-]{3,40}$/.test(login)) {
        throw new ValidationError('Login: 3–40 znaków, litery bez polskich znaków, cyfry, kropka, myślnik');
      }
      out.login = login;
    }
    if (input.role !== undefined) {
      if (!['admin', 'member'].includes(input.role)) throw new ValidationError('Nieprawidłowa rola');
      out.role = input.role;
    }
    return out;
  }

  /** `passwordHash` liczy warstwa auth – baza nigdy nie widzi hasła w jawnej postaci. */
  async createUser(input, passwordHash, { onlyIfNoUsers = false } = {}) {
    const data = Store.normalizeUser(input ?? {}, { partial: false });
    try {
      return await this.transaction(async (c) => {
        if (onlyIfNoUsers) {
          await c.query('LOCK TABLE users IN EXCLUSIVE MODE');
          const { rows } = await c.query('SELECT COUNT(*) AS n FROM users');
          if (rows[0].n > 0) throw Object.assign(new Error('Konto administratora już istnieje'), { status: 409 });
        }
        const { rows } = await c.query(
          'INSERT INTO users (name, login, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, login, role, created_at',
          [data.name, data.login, passwordHash, data.role ?? 'member']
        );
        return rows[0];
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ValidationError(`Login „${data.login}” jest już zajęty`);
      throw err;
    }
  }

  async updateUser(id, input, passwordHash = null) {
    const data = Store.normalizeUser(input ?? {}, { partial: true });
    if (passwordHash) data.password_hash = passwordHash;
    return this.transaction(async (c) => {
      const { rows } = await c.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [toId(id)]);
      if (!rows.length) throw new NotFoundError('Nie znaleziono użytkownika');
      if (data.role === 'member' && rows[0].role === 'admin') await this.#ensureAnotherAdmin(c, rows[0].id);
      const cols = Object.keys(data);
      if (cols.length) {
        try {
          await c.query(
            `UPDATE users SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`,
            [...cols.map((k) => data[k]), rows[0].id]
          );
        } catch (err) {
          if (isUniqueViolation(err)) throw new ValidationError(`Login „${data.login}” jest już zajęty`);
          throw err;
        }
      }
      const { rows: out } = await c.query('SELECT id, name, login, role, created_at FROM users WHERE id = $1', [rows[0].id]);
      return out[0];
    });
  }

  async #ensureAnotherAdmin(c, userId) {
    await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const { rows } = await c.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id <> $1", [userId]);
    if (!rows[0].n) throw new ValidationError('W domu musi zostać co najmniej jeden administrator');
  }

  async deleteUser(id) {
    return this.transaction(async (c) => {
      const { rows } = await c.query('SELECT id, role FROM users WHERE id = $1 FOR UPDATE', [toId(id)]);
      if (!rows.length) throw new NotFoundError('Nie znaleziono użytkownika');
      if (rows[0].role === 'admin') await this.#ensureAnotherAdmin(c, rows[0].id);
      await c.query('DELETE FROM users WHERE id = $1', [rows[0].id]);
    });
  }

  async createSession(userId, tokenHash, { days = 30, userAgent = '' } = {}) {
    await this.q(
      `INSERT INTO sessions (token_hash, user_id, user_agent, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
      [tokenHash, userId, String(userAgent).slice(0, 200), days]
    );
    // Sprzątanie wygasłych sesji przy okazji logowania.
    await this.q('DELETE FROM sessions WHERE expires_at < now()');
  }

  /** Zwraca użytkownika ważnej sesji i przedłuża ją (najwyżej raz na godzinę). */
  async getSessionUser(tokenHash, { days = 30 } = {}) {
    const { rows } = await this.q(
      `SELECT u.id, u.name, u.login, u.role, u.created_at, s.last_seen < now() - interval '1 hour' AS stale
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash]
    );
    if (!rows.length) return null;
    const { stale, ...user } = rows[0];
    if (stale) {
      await this.q(
        'UPDATE sessions SET last_seen = now(), expires_at = now() + make_interval(days => $2) WHERE token_hash = $1',
        [tokenHash, days]
      );
    }
    return user;
  }

  async deleteSession(tokenHash) {
    await this.q('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  async deleteUserSessions(userId, { exceptHash = null } = {}) {
    await this.q('DELETE FROM sessions WHERE user_id = $1 AND token_hash IS DISTINCT FROM $2', [userId, exceptHash]);
  }

  // ---------- Raporty ----------

  async shoppingList() {
    const items = await this.listItems({ status: 'low' });
    return items.map((i) => ({
      ...i,
      to_buy: Math.max(i.min_quantity * 2 - i.quantity, i.min_quantity - i.quantity, 1),
    }));
  }

  async stats() {
    const t = today();
    const soon = addDays(t, 7);
    const { rows } = await this.q(
      `SELECT
         COUNT(*) AS total_items,
         COALESCE(SUM(price * quantity), 0) AS total_value,
         COUNT(*) FILTER (WHERE min_quantity > 0 AND quantity <= min_quantity) AS low_stock,
         COUNT(*) FILTER (WHERE expires_at < $1) AS expired,
         COUNT(*) FILTER (WHERE expires_at >= $1 AND expires_at <= $2) AS expiring_soon
       FROM items`,
      [t, soon]
    );
    const { rows: byCategory } = await this.q(
      `SELECT COALESCE(c.name, 'Bez kategorii') AS name, COUNT(*) AS count
       FROM items i LEFT JOIN categories c ON c.id = i.category_id
       GROUP BY c.name ORDER BY count DESC, name`
    );
    const { rows: eq } = await this.q(
      `SELECT
         COUNT(*) FILTER (WHERE warranty_until >= $1 AND warranty_until <= $2) AS warranty_ending,
         COUNT(*) FILTER (WHERE next_service_at IS NOT NULL AND next_service_at <= $3) AS service_due
       FROM equipment`,
      [t, addDays(t, 30), addDays(t, 14)]
    );
    const { rows: money } = await this.q(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE reason = 'purchase'), 0) AS spent,
         COALESCE(SUM(amount) FILTER (WHERE reason = 'wasted'), 0) AS wasted
       FROM history
       WHERE (created_at AT TIME ZONE $1) >= date_trunc('month', now() AT TIME ZONE $1)`,
      [REPORT_TZ]
    );
    const r = rows[0];
    return {
      total_items: r.total_items,
      total_value: round2(r.total_value),
      low_stock: r.low_stock,
      expired: r.expired,
      expiring_soon: r.expiring_soon,
      warranty_ending: eq[0].warranty_ending,
      service_due: eq[0].service_due,
      spent_month: round2(money[0].spent),
      wasted_month: round2(money[0].wasted),
      by_category: byCategory,
    };
  }

  /** Wydatki i marnowanie w ostatnich miesiącach. */
  async reports({ months = 6 } = {}) {
    const n = Math.min(Math.max(Number(months) || 6, 1), 24);
    const tz = REPORT_TZ;
    const { rows: monthly } = await this.q(
      `WITH m AS (
         SELECT generate_series(
           date_trunc('month', now() AT TIME ZONE $1) - make_interval(months => $2 - 1),
           date_trunc('month', now() AT TIME ZONE $1), interval '1 month') AS month
       )
       SELECT to_char(m.month, 'YYYY-MM') AS month,
         COALESCE((SELECT SUM(amount) FROM history h WHERE h.reason = 'purchase'
           AND date_trunc('month', h.created_at AT TIME ZONE $1) = m.month), 0) AS spent,
         COALESCE((SELECT SUM(amount) FROM history h WHERE h.reason = 'wasted'
           AND date_trunc('month', h.created_at AT TIME ZONE $1) = m.month), 0) AS wasted,
         COALESCE((SELECT COUNT(*) FROM history h WHERE h.reason = 'wasted'
           AND date_trunc('month', h.created_at AT TIME ZONE $1) = m.month), 0) AS wasted_count,
         COALESCE((SELECT SUM(price) FROM equipment e
           WHERE date_trunc('month', e.purchase_date::timestamp) = m.month), 0) AS equipment
       FROM m ORDER BY m.month`,
      [tz, n]
    );
    const since = `date_trunc('month', now() AT TIME ZONE $1) - make_interval(months => $2 - 1)`;
    const { rows: byCategory } = await this.q(
      `SELECT COALESCE(c.name, 'Bez kategorii') AS name, SUM(h.amount) AS amount
       FROM history h JOIN items i ON i.id = h.item_id LEFT JOIN categories c ON c.id = i.category_id
       WHERE h.reason = 'purchase' AND h.amount IS NOT NULL AND (h.created_at AT TIME ZONE $1) >= ${since}
       GROUP BY c.name ORDER BY amount DESC`,
      [tz, n]
    );
    const { rows: wastedItems } = await this.q(
      `SELECT i.id, i.name, i.unit, SUM(-h.delta) AS quantity, COALESCE(SUM(h.amount), 0) AS amount, COUNT(*) AS times
       FROM history h JOIN items i ON i.id = h.item_id
       WHERE h.reason = 'wasted' AND (h.created_at AT TIME ZONE $1) >= ${since}
       GROUP BY i.id ORDER BY amount DESC, quantity DESC LIMIT 10`,
      [tz, n]
    );
    const { rows: byUser } = await this.q(
      `SELECT u.name,
              COALESCE(SUM(h.amount) FILTER (WHERE h.reason = 'purchase'), 0) AS spent,
              COUNT(*) FILTER (WHERE h.reason = 'used') AS used_count
       FROM history h JOIN users u ON u.id = h.user_id
       WHERE (h.created_at AT TIME ZONE $1) >= ${since}
       GROUP BY u.id, u.name ORDER BY spent DESC`,
      [tz, n]
    );
    const fix = (rows, keys) => rows.map((r) => {
      const o = { ...r };
      for (const k of keys) o[k] = round2(Number(o[k]));
      return o;
    });
    const m = fix(monthly, ['spent', 'wasted', 'equipment']);
    return {
      months: n,
      monthly: m,
      totals: {
        spent: round2(m.reduce((s, r) => s + r.spent, 0)),
        wasted: round2(m.reduce((s, r) => s + r.wasted, 0)),
        wasted_count: m.reduce((s, r) => s + Number(r.wasted_count), 0),
        equipment: round2(m.reduce((s, r) => s + r.equipment, 0)),
      },
      by_category: fix(byCategory, ['amount']),
      wasted_items: fix(wastedItems, ['amount', 'quantity']),
      by_user: fix(byUser, ['spent']),
      receipts: await this.listReceipts({ limit: 10 }),
    };
  }

  // ---------- Import / eksport ----------

  async exportAll() {
    const [categories, locations, items, batches] = await Promise.all([
      this.q('SELECT id, name FROM categories ORDER BY id'),
      this.q('SELECT id, name FROM locations ORDER BY id'),
      this.q('SELECT * FROM items ORDER BY id'),
      this.q('SELECT item_id, quantity, expires_at FROM batches ORDER BY id'),
    ]);
    return {
      version: 3,
      exported_at: new Date().toISOString(),
      categories: categories.rows,
      locations: locations.rows,
      items: items.rows,
      batches: batches.rows,
    };
  }

  /**
   * Zastępuje zapasy (kategorie, miejsca, produkty, partie) danymi z pliku.
   * Sprzęty, dokumenty i konta zostają; miejsca sprzętów są dopasowywane po nazwie.
   */
  async importAll(data) {
    if (!data || !Array.isArray(data.items)) throw new ValidationError('Nieprawidłowy plik importu');
    const items = data.items.map((it) => ({ id: toId(it.id), ...this.#normalizeItem(it, { partial: false }) }));
    const batches = Array.isArray(data.batches) ? data.batches : null;
    return this.transaction(async (c) => {
      const { rows: eqLocs } = await c.query(
        'SELECT e.id, l.name FROM equipment e JOIN locations l ON l.id = e.location_id'
      );
      await c.query('DELETE FROM history; DELETE FROM batches; DELETE FROM receipt_aliases; DELETE FROM items; DELETE FROM categories; DELETE FROM locations;');
      for (const table of ['categories', 'locations']) {
        for (const r of data[table] ?? []) {
          await c.query(`INSERT INTO ${table} (id, name) VALUES ($1, $2)`, [toId(r.id), String(r.name).trim()]);
        }
        await c.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT MAX(id) FROM ${table}), 1))`);
      }
      for (const { id, quantity = 0, expires_at: expiresAt = null, ...it } of items) {
        const row = { ...(id ? { id } : {}), ...it, quantity, expires_at: expiresAt };
        const newId = await this.#insertItem(c, row);
        if (!batches && quantity > 0) {
          await c.query('INSERT INTO batches (item_id, quantity, expires_at) VALUES ($1, $2, $3)', [newId, quantity, expiresAt]);
        }
      }
      await c.query(`SELECT setval(pg_get_serial_sequence('items', 'id'), GREATEST((SELECT MAX(id) FROM items), 1))`);
      if (batches) {
        for (const b of batches) {
          const q = toNumber(b.quantity, 'ilość');
          if (!q) continue;
          await c.query('INSERT INTO batches (item_id, quantity, expires_at) VALUES ($1, $2, $3)', [toId(b.item_id), q, toDate(b.expires_at) ?? null]);
        }
        await c.query('UPDATE items SET quantity = 0, expires_at = NULL');
        const { rows } = await c.query('SELECT id FROM items');
        for (const r of rows) await this.#syncItem(c, r.id);
      }
      for (const e of eqLocs) {
        await c.query('UPDATE equipment SET location_id = (SELECT id FROM locations WHERE lower(name) = lower($1)) WHERE id = $2', [e.name, e.id]);
      }
      return { items: items.length };
    }).catch((err) => {
      throw this.#fkError(err);
    });
  }
}

// ---------- Dopasowanie nazw (paragony) ----------

const STOP = new Set(['szt', 'kg', 'g', 'l', 'ml', 'op', 'opak', 'luz', 'waz', 'x']);
function tokens(text) {
  return nameKey(text).split(' ').filter((t) => t.length >= 3 && !/^\d/.test(t) && !STOP.has(t));
}

/** Część słów z paragonu, które pasują do nazwy produktu (paragony skracają słowa: „MLEK”, „SER ZOLT”). */
function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  let hits = 0;
  for (const t of a) {
    if (b.some((u) => u === t || (Math.min(t.length, u.length) >= 3 && (u.startsWith(t) || t.startsWith(u))))) hits += 1;
  }
  return hits / Math.max(a.length, Math.min(b.length, 3));
}

module.exports = {
  Store, ValidationError, NotFoundError, today, addDays, toBarcode, nameKey, DEFAULT_URL, REASONS, DOC_KINDS,
};
