'use strict';

/**
 * Warstwa danych na PostgreSQL.
 * Wszystkie metody są asynchroniczne; kształt zwracanych obiektów jest taki sam jak w API
 * (daty ważności jako 'RRRR-MM-DD', znaczniki czasu jako 'RRRR-MM-DD GG:MM:SS' w UTC).
 */

const { Pool, types } = require('pg');

const DEFAULT_URL = 'postgres://homemanager:homemanager@localhost:5432/homemanager';

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

CREATE TABLE IF NOT EXISTS history (
  id         SERIAL PRIMARY KEY,
  item_id    INTEGER          NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  delta      DOUBLE PRECISION NOT NULL,
  note       TEXT             NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS barcode_cache (
  barcode    TEXT PRIMARY KEY,
  data       JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_id);
CREATE INDEX IF NOT EXISTS idx_items_location ON items(location_id);
CREATE INDEX IF NOT EXISTS idx_items_barcode  ON items(barcode);
CREATE INDEX IF NOT EXISTS idx_history_item   ON history(item_id);
`;

const DEFAULT_CATEGORIES = ['Żywność', 'Chemia domowa', 'Kosmetyki', 'Leki', 'Narzędzia', 'Elektronika', 'Inne'];
const DEFAULT_LOCATIONS = ['Kuchnia', 'Spiżarnia', 'Łazienka', 'Garaż', 'Piwnica'];

const ITEM_SELECT = `
  SELECT i.*, c.name AS category, l.name AS location
  FROM items i
  LEFT JOIN categories c ON c.id = i.category_id
  LEFT JOIN locations  l ON l.id = i.location_id
`;

// Typy PostgreSQL → wartości JS zgodne z API.
const pad = (n) => String(n).padStart(2, '0');
const TYPE_PARSERS = {
  20: (v) => Number(v), // int8 (COUNT, SUM po int)
  1082: (v) => v, // date → 'RRRR-MM-DD' bez stref czasowych
  1184: (v) => {
    // timestamptz → 'RRRR-MM-DD GG:MM:SS' (UTC), jak wcześniej w SQLite
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

function toNumber(value, field, { required = false, allowNull = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`Pole "${field}" jest wymagane`);
    return allowNull ? null : undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError(`Pole "${field}" musi być nieujemną liczbą`);
  }
  return n;
}

function toDate(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ValidationError('Data ważności musi mieć format RRRR-MM-DD');
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new ValidationError('Nieprawidłowa data ważności');
  return value;
}

function toId(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new ValidationError('Nieprawidłowy identyfikator');
  return n;
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

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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

  async getItem(id, client = this.pool) {
    const { rows } = await this.q(`${ITEM_SELECT} WHERE i.id = $1`, [toId(id)], client);
    if (!rows.length) throw new NotFoundError('Nie znaleziono zasobu');
    return rows[0];
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

  async createItem(input) {
    const data = this.#normalizeItem(input ?? {}, { partial: false });
    const cols = Object.keys(data);
    try {
      return await this.transaction(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          cols.map((k) => data[k])
        );
        const id = rows[0].id;
        if (data.quantity) await this.#logHistory(c, id, data.quantity, 'Utworzenie');
        return this.getItem(id, c);
      });
    } catch (err) {
      throw this.#fkError(err);
    }
  }

  async updateItem(id, input) {
    const data = this.#normalizeItem(input ?? {}, { partial: true });
    const cols = Object.keys(data);
    try {
      return await this.transaction(async (c) => {
        const { rows } = await c.query('SELECT quantity FROM items WHERE id = $1 FOR UPDATE', [toId(id)]);
        if (!rows.length) throw new NotFoundError('Nie znaleziono zasobu');
        const current = rows[0];
        if (cols.length) {
          await c.query(
            `UPDATE items SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1}`,
            [...cols.map((k) => data[k]), toId(id)]
          );
          if (data.quantity !== undefined && data.quantity !== current.quantity) {
            await this.#logHistory(c, toId(id), data.quantity - current.quantity, 'Edycja');
          }
        }
        return this.getItem(id, c);
      });
    } catch (err) {
      throw this.#fkError(err);
    }
  }

  async deleteItem(id) {
    const { rowCount } = await this.q('DELETE FROM items WHERE id = $1', [toId(id)]);
    if (!rowCount) throw new NotFoundError('Nie znaleziono zasobu');
  }

  /** Zmienia stan o delta (dodatnia = uzupełnienie, ujemna = zużycie). Atomowo – bez wyścigów między urządzeniami. */
  async adjustQuantity(id, delta, note = '') {
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) throw new ValidationError('Zmiana ilości musi być niezerową liczbą');
    return this.transaction(async (c) => {
      const { rows } = await c.query('SELECT quantity, unit FROM items WHERE id = $1 FOR UPDATE', [toId(id)]);
      if (!rows.length) throw new NotFoundError('Nie znaleziono zasobu');
      const next = Math.round((rows[0].quantity + d) * 1000) / 1000;
      if (next < 0) throw new ValidationError(`Brak wystarczającej ilości (dostępne: ${rows[0].quantity} ${rows[0].unit})`);
      await c.query('UPDATE items SET quantity = $1, updated_at = now() WHERE id = $2', [next, toId(id)]);
      await this.#logHistory(c, toId(id), d, note || (d > 0 ? 'Uzupełnienie' : 'Zużycie'));
      return this.getItem(id, c);
    });
  }

  async #logHistory(client, itemId, delta, note) {
    await client.query('INSERT INTO history (item_id, delta, note) VALUES ($1, $2, $3)', [itemId, delta, String(note).slice(0, 200)]);
  }

  async getHistory(id) {
    const item = await this.getItem(id);
    const { rows } = await this.q(
      'SELECT id, delta, note, created_at FROM history WHERE item_id = $1 ORDER BY id DESC LIMIT 100',
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
    const r = rows[0];
    return {
      total_items: r.total_items,
      total_value: Math.round(r.total_value * 100) / 100,
      low_stock: r.low_stock,
      expired: r.expired,
      expiring_soon: r.expiring_soon,
      by_category: byCategory,
    };
  }

  // ---------- Import / eksport ----------

  async exportAll() {
    const [categories, locations, items] = await Promise.all([
      this.q('SELECT id, name FROM categories ORDER BY id'),
      this.q('SELECT id, name FROM locations ORDER BY id'),
      this.q('SELECT * FROM items ORDER BY id'),
    ]);
    return {
      version: 2,
      exported_at: new Date().toISOString(),
      categories: categories.rows,
      locations: locations.rows,
      items: items.rows,
    };
  }

  async importAll(data) {
    if (!data || !Array.isArray(data.items)) throw new ValidationError('Nieprawidłowy plik importu');
    const items = data.items.map((it) => this.#normalizeItem(it, { partial: false }));
    return this.transaction(async (c) => {
      await c.query('TRUNCATE history, items, categories, locations RESTART IDENTITY CASCADE');
      for (const table of ['categories', 'locations']) {
        for (const r of data[table] ?? []) {
          await c.query(`INSERT INTO ${table} (id, name) VALUES ($1, $2)`, [toId(r.id), String(r.name).trim()]);
        }
        await c.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT MAX(id) FROM ${table}), 1))`);
      }
      for (const it of items) {
        const cols = Object.keys(it);
        await c.query(
          `INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          cols.map((k) => it[k])
        );
      }
      return { items: items.length };
    }).catch((err) => {
      throw this.#fkError(err);
    });
  }
}

module.exports = { Store, ValidationError, NotFoundError, today, addDays, toBarcode, DEFAULT_URL };
