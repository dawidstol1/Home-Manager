'use strict';
/* Zastępuje sterownik `pg` bazą PGlite (PostgreSQL w WebAssembly) – ten sam kod Store działa w przeglądarce. */
let db = null;
const KEEP = [20, 1082, 1184]; // parsery typów nadpisywane przez Store

// Jedno połączenie PGlite: transakcja trzyma blokadę, zapytania spoza niej czekają.
let chain = Promise.resolve();
function lock() {
  let release;
  const next = new Promise((r) => { release = r; });
  const wait = chain;
  chain = chain.then(() => next);
  return wait.then(() => release);
}

function isMulti(sql) {
  return /;\s*\S/.test(sql.trim().replace(/;\s*$/, ''));
}

async function run(sql, params, parsers) {
  if ((!params || !params.length) && isMulti(sql)) {
    const res = await db.exec(sql, { parsers });
    const last = res[res.length - 1] || { rows: [] };
    return { rows: last.rows, rowCount: last.affectedRows ?? last.rows.length };
  }
  const res = await db.query(sql, params || [], { parsers });
  return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
}

class Pool {
  constructor(opts = {}) {
    this.parsers = {};
    const t = opts.types;
    if (t) for (const oid of KEEP) this.parsers[oid] = (v) => t.getTypeParser(oid, 'text')(v);
  }
  async query(sql, params) {
    const release = await lock();
    try {
      return await run(sql, params, this.parsers);
    } finally {
      release();
    }
  }
  async connect() {
    const release = await lock();
    const parsers = this.parsers;
    return {
      query: (sql, params) => run(sql, params, parsers),
      release,
    };
  }
  async end() {}
}

module.exports = {
  Pool,
  types: { getTypeParser: () => (v) => v },
  __setDb(instance) { db = instance; },
};
