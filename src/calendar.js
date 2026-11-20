'use strict';
/*
 * Kalendarz domowy: wpisy wspólne (widzi cała rodzina) i prywatne (tylko autor),
 * z przypisaniem do domowników i powtarzaniem (codziennie, co tydzień, co miesiąc, co rok).
 * Lista na zakres dat rozwija powtórzenia i może dołączyć terminy z domu
 * (koniec gwarancji, przegląd sprzętu, koniec ważności leku).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id           SERIAL PRIMARY KEY,
  title        TEXT        NOT NULL,
  notes        TEXT        NOT NULL DEFAULT '',
  starts_on    DATE        NOT NULL,
  ends_on      DATE,
  start_time   TEXT,
  end_time     TEXT,
  category     TEXT        NOT NULL DEFAULT 'other',
  visibility   TEXT        NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'private')),
  for_users    INTEGER[]   NOT NULL DEFAULT '{}',
  repeat       TEXT        NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly')),
  repeat_until DATE,
  owner_id     INTEGER     REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_on);
`;

const CATEGORIES = ['family', 'home', 'health', 'school', 'work', 'birthday', 'trip', 'other'];
const REPEATS = ['none', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly'];
const MAX_RANGE_DAYS = 430;

function install(Store, h) {
  const { ValidationError, NotFoundError, toDate, toId, today, addDays } = h;

  const dayNum = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;
  const fromNum = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  function toTime(value, field) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new ValidationError(`${field}: podaj godzinę w formacie GG:MM`);
    return `${m[1].padStart(2, '0')}:${m[2]}`;
  }

  /** Daty kolejnych wystąpień (początki) w zakresie [from, to], z uwzględnieniem długości wpisu. */
  function occurrences(ev, from, to) {
    const start = ev.starts_on;
    const span = ev.ends_on ? dayNum(ev.ends_on) - dayNum(start) : 0;
    const until = ev.repeat_until && ev.repeat_until < to ? ev.repeat_until : to;
    const fromN = dayNum(from) - span; // wpis wielodniowy zaczęty wcześniej też się liczy
    const out = [];
    const push = (d) => { if (dayNum(d) >= fromN && d <= until) out.push(d); };
    if (ev.repeat === 'none') {
      if (start <= to && dayNum(start) + span >= dayNum(from)) out.push(start);
      return out;
    }
    if (ev.repeat === 'daily' || ev.repeat === 'weekly' || ev.repeat === 'biweekly') {
      const step = { daily: 1, weekly: 7, biweekly: 14 }[ev.repeat];
      const s = dayNum(start);
      let n = s;
      if (fromN > s) n = s + Math.ceil((fromN - s) / step) * step;
      for (; fromNum(n) <= until; n += step) push(fromNum(n));
      return out;
    }
    const [, m0, d0] = start.split('-').map(Number);
    if (ev.repeat === 'monthly') {
      const [fy, fm] = fromNum(Math.max(fromN, dayNum(start))).split('-').map(Number);
      for (let y = fy, m = fm - 1; ; m += 1) {
        if (m > 11) { m = 0; y += 1; }
        const d = `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.min(d0, lastDay(y, m))).padStart(2, '0')}`;
        if (d > until) break;
        if (d >= start) push(d);
      }
      return out;
    }
    // co rok (29 lutego → 28 lutego w latach nieprzestępnych)
    const fy = Number(fromNum(Math.max(fromN, dayNum(start))).slice(0, 4));
    for (let y = fy; ; y += 1) {
      const d = `${y}-${String(m0).padStart(2, '0')}-${String(Math.min(d0, lastDay(y, m0 - 1))).padStart(2, '0')}`;
      if (d > until) break;
      if (d >= start) push(d);
    }
    return out;
  }

  function normalize(input, { partial }) {
    const out = {};
    if (!partial || input.title !== undefined) {
      const title = String(input.title ?? '').trim();
      if (!title) throw new ValidationError('Wpisz, co ma się wydarzyć');
      if (title.length > 200) throw new ValidationError('Tytuł może mieć maksymalnie 200 znaków');
      out.title = title;
    }
    if (!partial || input.starts_on !== undefined) {
      const d = toDate(input.starts_on, 'Data');
      if (!d) throw new ValidationError('Podaj datę');
      out.starts_on = d;
    }
    const ends = toDate(input.ends_on, 'Data końca');
    if (ends !== undefined) out.ends_on = ends;
    const st = toTime(input.start_time, 'Początek');
    if (st !== undefined) out.start_time = st;
    const et = toTime(input.end_time, 'Koniec');
    if (et !== undefined) out.end_time = et;
    if (input.notes !== undefined) out.notes = String(input.notes ?? '').trim().slice(0, 4000);
    if (input.category !== undefined) out.category = CATEGORIES.includes(input.category) ? input.category : 'other';
    if (input.visibility !== undefined) {
      if (!['shared', 'private'].includes(input.visibility)) throw new ValidationError('Nieprawidłowa widoczność');
      out.visibility = input.visibility;
    }
    if (input.repeat !== undefined) {
      if (!REPEATS.includes(input.repeat || 'none')) throw new ValidationError('Nieprawidłowe powtarzanie');
      out.repeat = input.repeat || 'none';
    }
    const until = toDate(input.repeat_until, 'Powtarzaj do');
    if (until !== undefined) out.repeat_until = until;
    if (input.for_users !== undefined) {
      const ids = Array.isArray(input.for_users) ? input.for_users : [];
      out.for_users = [...new Set(ids.map((x) => toId(x)).filter(Boolean))].slice(0, 50);
    }
    return out;
  }

  function check(ev) {
    if (ev.ends_on && ev.ends_on < ev.starts_on) throw new ValidationError('Koniec nie może być przed początkiem');
    if (ev.ends_on === ev.starts_on) ev.ends_on = null;
    if (ev.end_time && !ev.start_time) throw new ValidationError('Podaj też godzinę początku');
    if (!ev.ends_on && ev.start_time && ev.end_time && ev.end_time < ev.start_time) {
      throw new ValidationError('Godzina końca jest przed godziną początku');
    }
    if (ev.repeat_until && ev.repeat_until < ev.starts_on) throw new ValidationError('„Powtarzaj do” jest przed datą wpisu');
    if (ev.repeat === 'none') ev.repeat_until = null;
  }

  const SELECT = `SELECT e.*, u.name AS owner_name FROM events e LEFT JOIN users u ON u.id = e.owner_id`;
  const visible = (alias, param) => `(${alias}.visibility = 'shared' OR ${alias}.owner_id = ${param})`;

  async function fetchOne(store, id, userId, client) {
    const { rows } = await store.q(`${SELECT} WHERE e.id = $1 AND ${visible('e', '$2')}`, [toId(id), userId], client);
    if (!rows.length) throw new NotFoundError('Nie znaleziono wpisu');
    return rows[0];
  }

  /** Terminy z domu: gwarancje, przeglądy i leki (tylko do odczytu). */
  async function homeDates(store, from, to) {
    const out = [];
    const { rows: eq } = await store.q(
      `SELECT id, name, warranty_until, next_service_at FROM equipment
       WHERE warranty_until BETWEEN $1 AND $2 OR next_service_at BETWEEN $1 AND $2`, [from, to]);
    for (const e of eq) {
      if (e.warranty_until && e.warranty_until >= from && e.warranty_until <= to) {
        out.push({ source: 'equipment', ref_id: e.id, title: `Koniec gwarancji: ${e.name}`, date: e.warranty_until, category: 'home' });
      }
      if (e.next_service_at && e.next_service_at >= from && e.next_service_at <= to) {
        out.push({ source: 'equipment', ref_id: e.id, title: `Przegląd: ${e.name}`, date: e.next_service_at, category: 'home' });
      }
    }
    if (typeof store.listMedicines === 'function') {
      for (const m of await store.listMedicines()) {
        for (const p of m.packs) {
          if (p.deadline && p.deadline >= from && p.deadline <= to) {
            out.push({ source: 'medicine', ref_id: m.id, title: `Koniec ważności leku: ${m.name}`, date: p.deadline, category: 'health' });
          }
        }
      }
    }
    return out.map((x) => ({ ...x, id: null, key: `${x.source}-${x.ref_id}-${x.date}-${x.title}`, end_date: null, start_time: null, end_time: null, readonly: true }));
  }

  Object.assign(Store.prototype, {
    /** Wystąpienia wpisów w zakresie dat, posortowane po dniu i godzinie. */
    async listEvents({ from, to, home, mine, user } = {}, { userId }) {
      const f = toDate(from, 'Od') || today();
      const t = toDate(to, 'Do') || addDays(f, 30);
      if (t < f) throw new ValidationError('Zakres dat jest odwrócony');
      if (dayNum(t) - dayNum(f) > MAX_RANGE_DAYS) throw new ValidationError('Zbyt długi zakres dat');
      const params = [userId, t];
      const where = [visible('e', '$1'), 'e.starts_on <= $2'];
      if (mine === '1' || mine === true) where.push('e.owner_id = $1');
      if (user) {
        params.push(toId(user));
        where.push(`(e.owner_id = $${params.length} OR $${params.length} = ANY(e.for_users) OR (e.visibility = 'shared' AND cardinality(e.for_users) = 0))`);
      }
      const { rows } = await this.q(`${SELECT} WHERE ${where.join(' AND ')}`, params);
      const out = [];
      for (const ev of rows) {
        const span = ev.ends_on ? dayNum(ev.ends_on) - dayNum(ev.starts_on) : 0;
        for (const d of occurrences(ev, f, t)) {
          out.push({
            ...ev,
            key: `${ev.id}-${d}`,
            date: d,
            end_date: span ? fromNum(dayNum(d) + span) : null,
            readonly: false,
          });
        }
      }
      if (home === '1' || home === true) out.push(...await homeDates(this, f, t));
      out.sort((a, b) => a.date.localeCompare(b.date)
        || (a.start_time ?? '').localeCompare(b.start_time ?? '') || a.title.localeCompare(b.title, 'pl'));
      return out;
    },

    async getEvent(id, { userId }) {
      return fetchOne(this, id, userId);
    },

    async createEvent(input = {}, { userId }) {
      const data = { visibility: 'shared', repeat: 'none', category: 'other', ...normalize(input, { partial: false }) };
      check(data);
      data.owner_id = userId;
      const cols = Object.keys(data);
      const { rows } = await this.q(
        `INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        cols.map((k) => data[k])
      );
      return this.getEvent(rows[0].id, { userId });
    },

    async updateEvent(id, input = {}, { userId }) {
      const current = await fetchOne(this, id, userId);
      const data = normalize(input, { partial: true });
      // Prywatność może zmienić tylko autor wpisu.
      if (data.visibility && data.visibility !== current.visibility && current.owner_id !== userId) {
        throw new ValidationError('Widoczność może zmienić tylko autor wpisu');
      }
      const merged = { ...current, ...data };
      check(merged);
      for (const k of ['ends_on', 'repeat_until']) if (merged[k] !== current[k]) data[k] = merged[k];
      const cols = Object.keys(data);
      if (cols.length) {
        await this.q(
          `UPDATE events SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1}`,
          [...cols.map((k) => data[k]), current.id]
        );
      }
      return this.getEvent(current.id, { userId });
    },

    async deleteEvent(id, { userId }) {
      const ev = await fetchOne(this, id, userId);
      await this.q('DELETE FROM events WHERE id = $1', [ev.id]);
    },
  });
}

module.exports = { SCHEMA, install, CATEGORIES, REPEATS };
