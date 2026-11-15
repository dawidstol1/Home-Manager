'use strict';

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS locations (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  location_id  INTEGER REFERENCES locations(id)  ON DELETE SET NULL,
  quantity     REAL    NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit         TEXT    NOT NULL DEFAULT 'szt.',
  min_quantity REAL    NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
  price        REAL             CHECK (price IS NULL OR price >= 0),
  expires_at   TEXT,
  notes        TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  delta      REAL    NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_id);
CREATE INDEX IF NOT EXISTS idx_items_location ON items(location_id);
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
  return value;
}

function toId(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError('Nieprawidłowy identyfikator');
  return n;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function plain(row) {
  return row ? { ...row } : row;
}

class Store {
  constructor(filename = ':memory:', { seed = true } = {}) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    if (seed) this.seedDefaults();
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  seedDefaults() {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM categories').get();
    if (n === 0) {
      const ins = this.db.prepare('INSERT INTO categories (name) VALUES (?)');
      DEFAULT_CATEGORIES.forEach((c) => ins.run(c));
    }
    const { n: m } = this.db.prepare('SELECT COUNT(*) AS n FROM locations').get();
    if (m === 0) {
      const ins = this.db.prepare('INSERT INTO locations (name) VALUES (?)');
      DEFAULT_LOCATIONS.forEach((l) => ins.run(l));
    }
  }

  // ---------- Słowniki (kategorie / lokalizacje) ----------

  #dictTable(kind) {
    if (kind !== 'categories' && kind !== 'locations') throw new NotFoundError();
    return kind;
  }

  listDict(kind) {
    const table = this.#dictTable(kind);
    const fk = kind === 'categories' ? 'category_id' : 'location_id';
    return this.db
      .prepare(
        `SELECT d.id, d.name, COUNT(i.id) AS item_count
         FROM ${table} d LEFT JOIN items i ON i.${fk} = d.id
         GROUP BY d.id ORDER BY d.name COLLATE NOCASE`
      )
      .all()
      .map(plain);
  }

  createDict(kind, name) {
    const table = this.#dictTable(kind);
    const clean = String(name ?? '').trim();
    if (!clean) throw new ValidationError('Nazwa jest wymagana');
    try {
      const { lastInsertRowid } = this.db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(clean);
      return { id: Number(lastInsertRowid), name: clean, item_count: 0 };
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new ValidationError(`"${clean}" już istnieje`);
      throw err;
    }
  }

  deleteDict(kind, id) {
    const table = this.#dictTable(kind);
    const { changes } = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(toId(id));
    if (!changes) throw new NotFoundError();
  }

  // ---------- Zasoby ----------

  listItems({ q, category_id, location_id, status } = {}) {
    const where = [];
    const params = [];
    if (q) {
      where.push('(i.name LIKE ? OR i.notes LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (category_id) {
      where.push('i.category_id = ?');
      params.push(toId(category_id));
    }
    if (location_id) {
      where.push('i.location_id = ?');
      params.push(toId(location_id));
    }
    if (status === 'low') {
      where.push('i.min_quantity > 0 AND i.quantity <= i.min_quantity');
    } else if (status === 'expiring') {
      where.push('i.expires_at IS NOT NULL AND i.expires_at <= ?');
      params.push(addDays(today(), 7));
    } else if (status === 'expired') {
      where.push('i.expires_at IS NOT NULL AND i.expires_at < ?');
      params.push(today());
    }
    const sql = `${ITEM_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY i.name COLLATE NOCASE`;
    return this.db.prepare(sql).all(...params).map(plain);
  }

  getItem(id) {
    const row = this.db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(toId(id));
    if (!row) throw new NotFoundError('Nie znaleziono zasobu');
    return plain(row);
  }

  #normalizeItem(input, { partial }) {
    const out = {};
    if (!partial || input.name !== undefined) {
      const name = String(input.name ?? '').trim();
      if (!name) throw new ValidationError('Nazwa zasobu jest wymagana');
      out.name = name;
    }
    const map = {
      category_id: toId(input.category_id),
      location_id: toId(input.location_id),
      quantity: toNumber(input.quantity, 'ilość'),
      min_quantity: toNumber(input.min_quantity, 'stan minimalny'),
      price: input.price === undefined ? undefined : toNumber(input.price, 'cena', { allowNull: true }),
      expires_at: toDate(input.expires_at),
      unit: input.unit === undefined ? undefined : String(input.unit).trim() || 'szt.',
      notes: input.notes === undefined ? undefined : String(input.notes),
    };
    for (const [k, v] of Object.entries(map)) if (v !== undefined) out[k] = v;
    return out;
  }

  createItem(input) {
    const data = this.#normalizeItem(input ?? {}, { partial: false });
    const cols = Object.keys(data);
    return this.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare(`INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => data[c]));
      const id = Number(lastInsertRowid);
      if (data.quantity) this.#logHistory(id, data.quantity, 'Utworzenie');
      return this.getItem(id);
    });
  }

  updateItem(id, input) {
    const current = this.getItem(id);
    const data = this.#normalizeItem(input ?? {}, { partial: true });
    const cols = Object.keys(data);
    if (!cols.length) return current;
    return this.transaction(() => {
      this.db
        .prepare(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .run(...cols.map((c) => data[c]), current.id);
      if (data.quantity !== undefined && data.quantity !== current.quantity) {
        this.#logHistory(current.id, data.quantity - current.quantity, 'Edycja');
      }
      return this.getItem(current.id);
    });
  }

  deleteItem(id) {
    const { changes } = this.db.prepare('DELETE FROM items WHERE id = ?').run(toId(id));
    if (!changes) throw new NotFoundError('Nie znaleziono zasobu');
  }

  /** Zmienia stan o delta (dodatnia = uzupełnienie, ujemna = zużycie). */
  adjustQuantity(id, delta, note = '') {
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) throw new ValidationError('Zmiana ilości musi być niezerową liczbą');
    const item = this.getItem(id);
    const next = Math.round((item.quantity + d) * 1000) / 1000;
    if (next < 0) throw new ValidationError(`Brak wystarczającej ilości (dostępne: ${item.quantity} ${item.unit})`);
    return this.transaction(() => {
      this.db.prepare("UPDATE items SET quantity = ?, updated_at = datetime('now') WHERE id = ?").run(next, item.id);
      this.#logHistory(item.id, d, note || (d > 0 ? 'Uzupełnienie' : 'Zużycie'));
      return this.getItem(item.id);
    });
  }

  #logHistory(itemId, delta, note) {
    this.db.prepare('INSERT INTO history (item_id, delta, note) VALUES (?, ?, ?)').run(itemId, delta, String(note));
  }

  getHistory(id) {
    const item = this.getItem(id);
    return this.db
      .prepare('SELECT id, delta, note, created_at FROM history WHERE item_id = ? ORDER BY id DESC LIMIT 100')
      .all(item.id)
      .map(plain);
  }

  // ---------- Raporty ----------

  shoppingList() {
    return this.listItems({ status: 'low' }).map((i) => ({
      ...i,
      to_buy: Math.max(i.min_quantity * 2 - i.quantity, i.min_quantity - i.quantity, 1),
    }));
  }

  stats() {
    const t = today();
    const soon = addDays(t, 7);
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_items,
           COALESCE(SUM(price * quantity), 0) AS total_value,
           SUM(CASE WHEN min_quantity > 0 AND quantity <= min_quantity THEN 1 ELSE 0 END) AS low_stock,
           SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < ? THEN 1 ELSE 0 END) AS expired,
           SUM(CASE WHEN expires_at IS NOT NULL AND expires_at >= ? AND expires_at <= ? THEN 1 ELSE 0 END) AS expiring_soon
         FROM items`
      )
      .get(t, t, soon);
    const byCategory = this.db
      .prepare(
        `SELECT COALESCE(c.name, 'Bez kategorii') AS name, COUNT(*) AS count
         FROM items i LEFT JOIN categories c ON c.id = i.category_id
         GROUP BY c.id ORDER BY count DESC`
      )
      .all()
      .map(plain);
    return {
      total_items: row.total_items,
      total_value: Math.round(row.total_value * 100) / 100,
      low_stock: row.low_stock ?? 0,
      expired: row.expired ?? 0,
      expiring_soon: row.expiring_soon ?? 0,
      by_category: byCategory,
    };
  }

  // ---------- Import / eksport ----------

  exportAll() {
    return {
      version: 1,
      exported_at: new Date().toISOString(),
      categories: this.listDict('categories').map(({ id, name }) => ({ id, name })),
      locations: this.listDict('locations').map(({ id, name }) => ({ id, name })),
      items: this.db.prepare('SELECT * FROM items ORDER BY id').all().map(plain),
    };
  }

  importAll(data) {
    if (!data || !Array.isArray(data.items)) throw new ValidationError('Nieprawidłowy plik importu');
    return this.transaction(() => {
      this.db.exec('DELETE FROM history; DELETE FROM items; DELETE FROM categories; DELETE FROM locations;');
      const insDict = (table, rows) => {
        const st = this.db.prepare(`INSERT INTO ${table} (id, name) VALUES (?, ?)`);
        (rows ?? []).forEach((r) => st.run(toId(r.id), String(r.name)));
      };
      insDict('categories', data.categories);
      insDict('locations', data.locations);
      for (const it of data.items) {
        const clean = this.#normalizeItem(it, { partial: false });
        const cols = Object.keys(clean);
        this.db
          .prepare(`INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
          .run(...cols.map((c) => clean[c]));
      }
      return { items: data.items.length };
    });
  }
}

module.exports = { Store, ValidationError, NotFoundError, today, addDays };
