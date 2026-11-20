'use strict';
/*
 * Domowa apteka: leki, ich opakowania (każde z własną datą ważności i datą otwarcia)
 * oraz dziennik podań („kto, co i kiedy dostał”).
 *
 * Termin opakowania = wcześniejsza z dat: ważność z pudełka albo data otwarcia + „ważny po otwarciu (dni)”
 * (syropy, krople do oczu, maści).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS medicines (
  id                 SERIAL PRIMARY KEY,
  name               TEXT             NOT NULL,
  substance          TEXT             NOT NULL DEFAULT '',
  form               TEXT             NOT NULL DEFAULT '',
  strength           TEXT             NOT NULL DEFAULT '',
  purpose            TEXT             NOT NULL DEFAULT '',
  person             TEXT             NOT NULL DEFAULT '',
  kit                TEXT             NOT NULL DEFAULT '',
  unit               TEXT             NOT NULL DEFAULT 'tabl.',
  min_quantity       DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
  after_opening_days INTEGER          CHECK (after_opening_days IS NULL OR after_opening_days > 0),
  prescription       BOOLEAN          NOT NULL DEFAULT false,
  barcode            TEXT,
  dosage             TEXT             NOT NULL DEFAULT '',
  notes              TEXT             NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS medicine_packs (
  id          SERIAL PRIMARY KEY,
  medicine_id INTEGER          NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  quantity    DOUBLE PRECISION NOT NULL CHECK (quantity >= 0),
  expires_at  DATE,
  opened_at   DATE,
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS medicine_log (
  id          SERIAL PRIMARY KEY,
  medicine_id INTEGER          NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  delta       DOUBLE PRECISION NOT NULL,
  reason      TEXT             NOT NULL,
  person      TEXT             NOT NULL DEFAULT '',
  note        TEXT             NOT NULL DEFAULT '',
  user_id     INTEGER          REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_medicine_packs_med ON medicine_packs(medicine_id);
CREATE INDEX IF NOT EXISTS idx_medicine_log_med   ON medicine_log(medicine_id, created_at);
CREATE INDEX IF NOT EXISTS idx_medicines_barcode  ON medicines(barcode);
`;

/** Ile dni przed końcem terminu lek trafia do „wkrótce traci ważność”. */
const EXPIRING_DAYS = 30;
const LOG_REASONS = ['added', 'taken', 'disposed', 'correction'];

function install(Store, h) {
  const { ValidationError, NotFoundError, toNumber, toDate, toId, toText, toBarcode, today, addDays } = h;

  const round3 = (n) => Math.round(n * 1000) / 1000;

  /** Termin opakowania z uwzględnieniem otwarcia. */
  function packDeadline(pack, afterOpeningDays) {
    const opened = pack.opened_at && afterOpeningDays ? addDays(pack.opened_at, afterOpeningDays) : null;
    if (pack.expires_at && opened) return pack.expires_at < opened ? pack.expires_at : opened;
    return pack.expires_at || opened || null;
  }

  function decorate(med, packs, last) {
    const t = today();
    const soon = addDays(t, EXPIRING_DAYS);
    const list = packs
      .map((p) => {
        const deadline = packDeadline(p, med.after_opening_days);
        return {
          ...p,
          deadline,
          expired: Boolean(deadline && deadline < t),
          expiring: Boolean(deadline && deadline >= t && deadline <= soon),
        };
      })
      .sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') || a.id - b.id);
    const usable = list.filter((p) => !p.expired);
    const quantity = round3(usable.reduce((s, p) => s + p.quantity, 0));
    const expiredQty = round3(list.filter((p) => p.expired).reduce((s, p) => s + p.quantity, 0));
    const next = usable.find((p) => p.deadline)?.deadline ?? null;
    return {
      ...med,
      packs: list,
      quantity,
      expired_quantity: expiredQty,
      next_deadline: next,
      has_expired: list.some((p) => p.expired),
      expiring: usable.some((p) => p.expiring),
      low: med.min_quantity > 0 ? quantity <= med.min_quantity : quantity <= 0,
      opened: list.some((p) => p.opened_at && !p.expired),
      last_taken: last ?? null,
    };
  }

  function normalize(input, { partial }) {
    const out = {};
    if (!partial || input.name !== undefined) {
      const name = String(input.name ?? '').trim();
      if (!name) throw new ValidationError('Nazwa leku jest wymagana');
      if (name.length > 200) throw new ValidationError('Nazwa może mieć maksymalnie 200 znaków');
      out.name = name;
    }
    const days = input.after_opening_days;
    const map = {
      substance: toText(input.substance, 200),
      form: toText(input.form, 60),
      strength: toText(input.strength, 60),
      purpose: toText(input.purpose, 300),
      person: toText(input.person, 100),
      kit: toText(input.kit, 100),
      unit: input.unit === undefined ? undefined : toText(input.unit, 20) || 'szt.',
      min_quantity: input.min_quantity === undefined ? undefined : toNumber(input.min_quantity, 'stan minimalny') ?? 0,
      after_opening_days: days === undefined ? undefined
        : days === null || days === '' ? null
          : (() => {
            const n = Number(days);
            if (!Number.isInteger(n) || n <= 0 || n > 3650) throw new ValidationError('„Ważny po otwarciu” to liczba dni (1–3650)');
            return n;
          })(),
      prescription: input.prescription === undefined ? undefined : Boolean(input.prescription) && input.prescription !== 'false',
      barcode: toBarcode(input.barcode),
      dosage: input.dosage === undefined ? undefined : String(input.dosage ?? '').trim().slice(0, 1000),
      notes: input.notes === undefined ? undefined : String(input.notes ?? '').trim().slice(0, 4000),
    };
    for (const [k, v] of Object.entries(map)) if (v !== undefined) out[k] = v;
    return out;
  }

  function normalizePack(input, { partial }) {
    const out = {};
    if (!partial || input.quantity !== undefined) {
      out.quantity = toNumber(input.quantity, 'ilość', { required: !partial });
    }
    const exp = toDate(input.expires_at, 'Data ważności');
    if (exp !== undefined) out.expires_at = exp;
    const opened = toDate(input.opened_at, 'Data otwarcia');
    if (opened !== undefined) out.opened_at = opened;
    return out;
  }

  async function lockMedicine(c, id) {
    const { rows } = await c.query('SELECT * FROM medicines WHERE id = $1 FOR UPDATE', [toId(id)]);
    if (!rows.length) throw new NotFoundError('Nie znaleziono leku');
    return rows[0];
  }

  async function log(c, { medicineId, delta, reason, person = '', note = '', userId = null }) {
    const { rows } = await c.query(
      `INSERT INTO medicine_log (medicine_id, delta, reason, person, note, user_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [medicineId, round3(delta), LOG_REASONS.includes(reason) ? reason : 'correction', person ?? '', note ?? '', userId]
    );
    return rows[0].id;
  }

  Object.assign(Store.prototype, {
    async listMedicines({ q, status, person, kit } = {}, client = this.pool) {
      const where = [];
      const params = [];
      if (q) {
        params.push(`%${String(q).replace(/[\\%_]/g, '\\$&')}%`, String(q).trim());
        where.push(`(m.name ILIKE $1 OR m.substance ILIKE $1 OR m.purpose ILIKE $1 OR m.person ILIKE $1
                     OR m.notes ILIKE $1 OR m.barcode = $2)`);
      }
      if (person) {
        params.push(String(person));
        where.push(`m.person = $${params.length}`);
      }
      if (kit) {
        params.push(String(kit));
        where.push(`m.kit = $${params.length}`);
      }
      const { rows: meds } = await this.q(
        `SELECT m.* FROM medicines m ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY lower(m.name), m.id`,
        params,
        client
      );
      if (!meds.length) return [];
      const ids = meds.map((m) => m.id);
      const [{ rows: packs }, { rows: last }] = await Promise.all([
        this.q('SELECT id, medicine_id, quantity, expires_at, opened_at FROM medicine_packs WHERE medicine_id = ANY($1) AND quantity > 0', [ids], client),
        this.q(
          `SELECT DISTINCT ON (l.medicine_id) l.medicine_id, l.created_at, l.delta, l.person, u.name AS user_name
           FROM medicine_log l LEFT JOIN users u ON u.id = l.user_id
           WHERE l.medicine_id = ANY($1) AND l.reason = 'taken'
           ORDER BY l.medicine_id, l.created_at DESC, l.id DESC`,
          [ids],
          client
        ),
      ]);
      const lastBy = new Map(last.map(({ medicine_id: id, ...r }) => [id, { ...r, amount: -r.delta }]));
      let list = meds.map((m) => decorate(m, packs.filter((p) => p.medicine_id === m.id), lastBy.get(m.id)));
      if (status === 'expired') list = list.filter((m) => m.has_expired);
      else if (status === 'expiring') list = list.filter((m) => m.expiring);
      else if (status === 'low') list = list.filter((m) => m.low);
      return list;
    },

    async getMedicine(id, client = this.pool) {
      const { rows } = await this.q('SELECT * FROM medicines WHERE id = $1', [toId(id)], client);
      if (!rows.length) throw new NotFoundError('Nie znaleziono leku');
      const [{ rows: packs }, { rows: logRows }] = await Promise.all([
        this.q('SELECT id, medicine_id, quantity, expires_at, opened_at FROM medicine_packs WHERE medicine_id = $1 AND quantity > 0', [rows[0].id], client),
        this.q(
          `SELECT l.id, l.delta, l.reason, l.person, l.note, l.created_at, u.name AS user_name
           FROM medicine_log l LEFT JOIN users u ON u.id = l.user_id
           WHERE l.medicine_id = $1 ORDER BY l.created_at DESC, l.id DESC LIMIT 50`,
          [rows[0].id],
          client
        ),
      ]);
      const lastTaken = logRows.find((l) => l.reason === 'taken');
      const med = decorate(rows[0], packs, lastTaken && { created_at: lastTaken.created_at, amount: -lastTaken.delta, person: lastTaken.person, user_name: lastTaken.user_name });
      return { ...med, log: logRows };
    },

    /** Nowy lek; opcjonalnie od razu z pierwszym opakowaniem (`quantity`, `expires_at`). */
    async createMedicine(input = {}, { userId = null } = {}) {
      const data = normalize(input, { partial: false });
      const pack = input.quantity !== undefined && input.quantity !== '' && input.quantity !== null
        ? normalizePack(input, { partial: false }) : null;
      return this.transaction(async (c) => {
        const cols = Object.keys(data);
        const { rows } = await c.query(
          `INSERT INTO medicines (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          cols.map((k) => data[k])
        );
        const id = rows[0].id;
        if (pack && pack.quantity > 0) {
          await c.query('INSERT INTO medicine_packs (medicine_id, quantity, expires_at, opened_at) VALUES ($1, $2, $3, $4)',
            [id, pack.quantity, pack.expires_at ?? null, pack.opened_at ?? null]);
          await log(c, { medicineId: id, delta: pack.quantity, reason: 'added', userId });
        }
        return this.getMedicine(id, c);
      });
    },

    async updateMedicine(id, input = {}) {
      const data = normalize(input, { partial: true });
      const cols = Object.keys(data);
      if (cols.length) {
        const { rowCount } = await this.q(
          `UPDATE medicines SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1}`,
          [...cols.map((k) => data[k]), toId(id)]
        );
        if (!rowCount) throw new NotFoundError('Nie znaleziono leku');
      }
      return this.getMedicine(id);
    },

    async deleteMedicine(id) {
      const { rowCount } = await this.q('DELETE FROM medicines WHERE id = $1', [toId(id)]);
      if (!rowCount) throw new NotFoundError('Nie znaleziono leku');
    },

    async addMedicinePack(medicineId, input = {}, { userId = null } = {}) {
      const pack = normalizePack(input, { partial: false });
      if (!(pack.quantity > 0)) throw new ValidationError('Podaj ilość w opakowaniu');
      return this.transaction(async (c) => {
        const med = await lockMedicine(c, medicineId);
        await c.query('INSERT INTO medicine_packs (medicine_id, quantity, expires_at, opened_at) VALUES ($1, $2, $3, $4)',
          [med.id, pack.quantity, pack.expires_at ?? null, pack.opened_at ?? null]);
        await log(c, { medicineId: med.id, delta: pack.quantity, reason: 'added', userId });
        return this.getMedicine(med.id, c);
      });
    },

    async updateMedicinePack(packId, input = {}, { userId = null } = {}) {
      const data = normalizePack(input, { partial: true });
      return this.transaction(async (c) => {
        const { rows } = await c.query('SELECT * FROM medicine_packs WHERE id = $1 FOR UPDATE', [toId(packId)]);
        if (!rows.length) throw new NotFoundError('Nie znaleziono opakowania');
        const old = rows[0];
        const cols = Object.keys(data);
        if (cols.length) {
          await c.query(
            `UPDATE medicine_packs SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`,
            [...cols.map((k) => data[k]), old.id]
          );
        }
        if (data.quantity !== undefined && data.quantity !== old.quantity) {
          await log(c, { medicineId: old.medicine_id, delta: data.quantity - old.quantity, reason: 'correction', userId });
        }
        if (data.quantity === 0) await c.query('DELETE FROM medicine_packs WHERE id = $1', [old.id]);
        return this.getMedicine(old.medicine_id, c);
      });
    },

    /** Utylizacja opakowania (np. przeterminowane – do zwrotu w aptece). */
    async removeMedicinePack(packId, { userId = null } = {}) {
      return this.transaction(async (c) => {
        const { rows } = await c.query('DELETE FROM medicine_packs WHERE id = $1 RETURNING *', [toId(packId)]);
        if (!rows.length) throw new NotFoundError('Nie znaleziono opakowania');
        if (rows[0].quantity > 0) {
          await log(c, { medicineId: rows[0].medicine_id, delta: -rows[0].quantity, reason: 'disposed', userId });
        }
        return this.getMedicine(rows[0].medicine_id, c);
      });
    },

    /**
     * Podanie / przyjęcie leku. Najpierw z już otwartego opakowania, potem z tego o najkrótszym terminie;
     * przeterminowanych nie rusza. Otwiera opakowanie (data otwarcia = dziś), jeśli było zamknięte.
     */
    async takeMedicine(medicineId, input = {}, { userId = null } = {}) {
      const amount = toNumber(input.amount ?? 1, 'ilość', { required: true });
      if (!(amount > 0)) throw new ValidationError('Podaj ilość większą od zera');
      const person = toText(input.person ?? '', 100);
      const note = toText(input.note ?? '', 300);
      return this.transaction(async (c) => {
        const med = await lockMedicine(c, medicineId);
        const { rows } = await c.query('SELECT * FROM medicine_packs WHERE medicine_id = $1 AND quantity > 0 FOR UPDATE', [med.id]);
        const t = today();
        const usable = rows
          .map((p) => ({ ...p, deadline: packDeadline(p, med.after_opening_days) }))
          .filter((p) => !p.deadline || p.deadline >= t)
          .sort((a, b) => (Number(Boolean(b.opened_at)) - Number(Boolean(a.opened_at)))
            || (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') || a.id - b.id);
        const available = round3(usable.reduce((s, p) => s + p.quantity, 0));
        if (available < amount) {
          const expired = rows.length > usable.length;
          throw new ValidationError(available
            ? `Za mało leku (zostało ${available} ${med.unit})`
            : expired ? 'Zostały tylko przeterminowane opakowania – nie podawaj ich, oddaj do apteki' : 'Brak tego leku w apteczce');
        }
        let left = amount;
        for (const p of usable) {
          if (left <= 0) break;
          const take = Math.min(p.quantity, left);
          left = round3(left - take);
          const rest = round3(p.quantity - take);
          if (rest <= 0) await c.query('DELETE FROM medicine_packs WHERE id = $1', [p.id]);
          else await c.query('UPDATE medicine_packs SET quantity = $1, opened_at = COALESCE(opened_at, $2) WHERE id = $3', [rest, t, p.id]);
        }
        const logId = await log(c, { medicineId: med.id, delta: -amount, reason: 'taken', person, note, userId });
        return { ...(await this.getMedicine(med.id, c)), log_id: logId };
      });
    },

    /** Cofnięcie podania – ilość wraca do otwartego (albo nowego) opakowania. */
    async undoMedicineLog(logId) {
      return this.transaction(async (c) => {
        const { rows } = await c.query('SELECT * FROM medicine_log WHERE id = $1 FOR UPDATE', [toId(logId)]);
        if (!rows.length) throw new NotFoundError('Nie znaleziono wpisu');
        const entry = rows[0];
        if (entry.reason !== 'taken') throw new ValidationError('Cofnąć można tylko podanie leku');
        const med = await lockMedicine(c, entry.medicine_id);
        const { rows: packs } = await c.query(
          'SELECT id FROM medicine_packs WHERE medicine_id = $1 AND quantity > 0 ORDER BY (opened_at IS NULL), expires_at NULLS LAST, id LIMIT 1',
          [med.id]
        );
        if (packs.length) await c.query('UPDATE medicine_packs SET quantity = quantity + $1 WHERE id = $2', [-entry.delta, packs[0].id]);
        else await c.query('INSERT INTO medicine_packs (medicine_id, quantity, opened_at) VALUES ($1, $2, $3)', [med.id, -entry.delta, today()]);
        await c.query('DELETE FROM medicine_log WHERE id = $1', [entry.id]);
        return this.getMedicine(med.id, c);
      });
    },

    /** Usuwa wszystkie przeterminowane opakowania (do oddania w aptece). */
    async disposeExpiredMedicines({ userId = null } = {}) {
      return this.transaction(async (c) => {
        const t = today();
        const { rows } = await c.query(
          `SELECT p.*, m.after_opening_days, m.name, m.unit FROM medicine_packs p JOIN medicines m ON m.id = p.medicine_id
           WHERE p.quantity > 0 FOR UPDATE OF p`
        );
        const expired = rows.filter((p) => {
          const d = packDeadline(p, p.after_opening_days);
          return d && d < t;
        });
        for (const p of expired) {
          await c.query('DELETE FROM medicine_packs WHERE id = $1', [p.id]);
          await log(c, { medicineId: p.medicine_id, delta: -p.quantity, reason: 'disposed', note: 'Przeterminowane', userId });
        }
        return { packs: expired.length, medicines: [...new Set(expired.map((p) => p.name))] };
      });
    },

    /** Ostatnie podania leków (dziennik domowy). */
    async medicineJournal({ limit = 30 } = {}) {
      const n = Math.min(Math.max(Number(limit) || 30, 1), 200);
      const { rows } = await this.q(
        `SELECT l.id, l.medicine_id, m.name, m.unit, -l.delta AS amount, l.person, l.note, l.created_at, u.name AS user_name
         FROM medicine_log l JOIN medicines m ON m.id = l.medicine_id LEFT JOIN users u ON u.id = l.user_id
         WHERE l.reason = 'taken' ORDER BY l.created_at DESC, l.id DESC LIMIT $1`,
        [n]
      );
      return rows;
    },

    /** Podpowiedzi do formularza: osoby, apteczki, postaci leków już użyte w domu. */
    async medicineSuggestions() {
      const { rows } = await this.q(
        `SELECT
           ARRAY(SELECT DISTINCT person FROM medicines WHERE person <> '' UNION SELECT DISTINCT person FROM medicine_log WHERE person <> '' ORDER BY 1) AS persons,
           ARRAY(SELECT DISTINCT kit FROM medicines WHERE kit <> '' ORDER BY 1) AS kits,
           ARRAY(SELECT DISTINCT form FROM medicines WHERE form <> '' ORDER BY 1) AS forms`
      );
      return rows[0];
    },

    async medicineStats() {
      const list = await this.listMedicines();
      return {
        medicines: list.length,
        med_expired: list.filter((m) => m.has_expired).length,
        med_expiring: list.filter((m) => m.expiring).length,
        med_low: list.filter((m) => m.low).length,
      };
    },

    async exportMedicines() {
      const [meds, packs] = await Promise.all([
        this.q('SELECT * FROM medicines ORDER BY id'),
        this.q('SELECT medicine_id, quantity, expires_at, opened_at FROM medicine_packs WHERE quantity > 0 ORDER BY id'),
      ]);
      return { medicines: meds.rows, medicine_packs: packs.rows };
    },

    /** Zastępuje apteczkę danymi z kopii (w transakcji importu). */
    async importMedicines(c, data) {
      const meds = data.medicines.map((m) => ({ id: toId(m.id), ...normalize(m, { partial: false }) }));
      await c.query('DELETE FROM medicines');
      for (const { id, ...m } of meds) {
        const row = { ...(id ? { id } : {}), ...m };
        const cols = Object.keys(row);
        await c.query(`INSERT INTO medicines (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((k) => row[k]));
      }
      await c.query(`SELECT setval(pg_get_serial_sequence('medicines', 'id'), GREATEST((SELECT MAX(id) FROM medicines), 1))`);
      for (const p of data.medicine_packs ?? []) {
        const pack = normalizePack(p, { partial: false });
        if (!pack.quantity) continue;
        await c.query('INSERT INTO medicine_packs (medicine_id, quantity, expires_at, opened_at) VALUES ($1, $2, $3, $4)',
          [toId(p.medicine_id), pack.quantity, pack.expires_at ?? null, pack.opened_at ?? null]);
      }
      return meds.length;
    },
  });
}

module.exports = { SCHEMA, install, EXPIRING_DAYS };
