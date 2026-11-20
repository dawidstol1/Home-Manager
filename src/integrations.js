'use strict';
/*
 * Integracje (Home Assistant, Domoticz):
 *  - klucze API – stałe, nazwane, do odwołania; w bazie tylko skrót klucza,
 *  - adresy, które mogą osadzać aplikację w ramce (panel w HA, strona „Custom” w Domoticzu),
 *  - jedno zwięzłe podsumowanie stanu domu dla czujników.
 */

const crypto = require('node:crypto');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_tokens (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  token_hash   TEXT        NOT NULL UNIQUE,
  hint         TEXT        NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
`;

const TOKEN_PREFIX = 'hm_';
const MAX_TOKENS_PER_USER = 20;

const isApiToken = (token) => typeof token === 'string' && token.startsWith(TOKEN_PREFIX);
const newApiToken = () => TOKEN_PREFIX + crypto.randomBytes(30).toString('base64url');

/** Adres strony, która może osadzać aplikację: schemat + host (+ port), bez ścieżki. */
function normalizeOrigin(value, ValidationError) {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ValidationError(`„${raw}” nie jest adresem (np. http://192.168.1.10:8123)`);
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.pathname !== '/' && u.pathname !== '')) {
    throw new ValidationError(`„${raw}”: podaj sam adres strony, np. https://ha.example.pl albo http://192.168.1.10:8123`);
  }
  return u.origin;
}

function install(Store, h) {
  const { ValidationError, NotFoundError, toId, today, addDays } = h;
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

  Object.assign(Store.prototype, {
    // ----- Klucze API -----
    async listApiTokens(userId) {
      const { rows } = await this.q(
        `SELECT id, name, hint, created_at, last_used_at FROM api_tokens WHERE user_id = $1 ORDER BY id`,
        [userId]
      );
      return rows;
    },

    /** Tworzy klucz i zwraca go jedyny raz (w bazie zostaje tylko skrót). */
    async createApiToken(userId, name) {
      const clean = String(name ?? '').trim().slice(0, 60);
      if (!clean) throw new ValidationError('Nazwij klucz, np. „Home Assistant”');
      const { rows: count } = await this.q('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = $1', [userId]);
      if (count[0].n >= MAX_TOKENS_PER_USER) throw new ValidationError('Masz już zbyt wiele kluczy – usuń nieużywane');
      const token = newApiToken();
      const { rows } = await this.q(
        `INSERT INTO api_tokens (user_id, name, token_hash, hint) VALUES ($1, $2, $3, $4)
         RETURNING id, name, hint, created_at, last_used_at`,
        [userId, clean, sha(token), token.slice(-4)]
      );
      return { ...rows[0], token };
    },

    async deleteApiToken(userId, id) {
      const { rowCount } = await this.q('DELETE FROM api_tokens WHERE id = $1 AND user_id = $2', [toId(id), userId]);
      if (!rowCount) throw new NotFoundError('Nie znaleziono klucza');
    },

    /** Użytkownik dla klucza API (aktualizuje „ostatnio użyty” najwyżej raz na 5 minut). */
    async getApiTokenUser(token) {
      const { rows } = await this.q(
        `SELECT u.id, u.name, u.login, u.role, u.created_at, t.id AS token_id,
                (t.last_used_at IS NULL OR t.last_used_at < now() - interval '5 minutes') AS stale
         FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1`,
        [sha(token)]
      );
      if (!rows.length) return null;
      const { stale, token_id: tokenId, ...user } = rows[0];
      if (stale) await this.q('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [tokenId]);
      return { ...user, via_api_token: true };
    },

    // ----- Ustawienia -----
    async getSetting(key, fallback = null) {
      const { rows } = await this.q('SELECT value FROM settings WHERE key = $1', [key]);
      return rows.length ? rows[0].value : fallback;
    },

    async setSetting(key, value) {
      await this.q(
        `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)]
      );
      return value;
    },

    async getEmbedOrigins() {
      const v = await this.getSetting('embed_origins', []);
      return Array.isArray(v) ? v : [];
    },

    async setEmbedOrigins(list) {
      if (!Array.isArray(list)) throw new ValidationError('Podaj listę adresów');
      if (list.length > 20) throw new ValidationError('Maksymalnie 20 adresów');
      const clean = [...new Set(list.map((x) => normalizeOrigin(x, ValidationError)).filter(Boolean))];
      return this.setSetting('embed_origins', clean);
    },

    // ----- Podsumowanie dla czujników -----
    async integrationSummary({ userId }) {
      const t = today();
      const [stats, shopping, expired, expiring, meds, events] = await Promise.all([
        this.stats(),
        this.shoppingList(),
        this.listItems({ status: 'expired' }),
        this.listItems({ status: 'expiring' }),
        this.listMedicines(),
        this.listEvents({ from: t, to: addDays(t, 30), home: '1' }, { userId }),
      ]);
      const nextEvent = events.find((e) => !e.readonly && (e.date > t || (e.date === t && e.start_time)));
      const ev = (e) => ({
        title: e.title, date: e.date, end_date: e.end_date, start_time: e.start_time, end_time: e.end_time,
        category: e.category, private: e.visibility === 'private', from_home: Boolean(e.readonly),
      });
      return {
        generated_at: new Date().toISOString(),
        stats: {
          total_items: stats.total_items,
          total_value: stats.total_value,
          low_stock: stats.low_stock,
          expired: stats.expired,
          expiring_soon: stats.expiring_soon,
          warranty_ending: stats.warranty_ending,
          service_due: stats.service_due,
          spent_month: stats.spent_month,
          wasted_month: stats.wasted_month,
          medicines: stats.medicines,
          med_expired: stats.med_expired,
          med_expiring: stats.med_expiring,
          med_low: stats.med_low,
          events_today: events.filter((e) => e.date <= t && (e.end_date ?? e.date) >= t).length,
        },
        shopping: shopping.map((i) => ({ id: i.id, name: i.name, to_buy: i.to_buy, quantity: i.quantity, unit: i.unit, location: i.location })),
        expired_items: expired.filter((i) => i.expires_at < t).map((i) => ({ id: i.id, name: i.name, expires_at: i.expires_at })),
        expiring_items: expiring.filter((i) => i.expires_at >= t).map((i) => ({ id: i.id, name: i.name, expires_at: i.expires_at })),
        medicines: {
          expired: meds.filter((m) => m.has_expired).map((m) => ({ id: m.id, name: m.name })),
          expiring: meds.filter((m) => m.expiring).map((m) => ({ id: m.id, name: m.name, deadline: m.next_deadline })),
          low: meds.filter((m) => m.low).map((m) => ({ id: m.id, name: m.name, quantity: m.quantity, unit: m.unit })),
        },
        events_today: events.filter((e) => e.date <= t && (e.end_date ?? e.date) >= t).map(ev),
        next_event: nextEvent ? ev(nextEvent) : null,
      };
    },
  });
}

module.exports = { SCHEMA, install, isApiToken, normalizeOrigin };
