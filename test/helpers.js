'use strict';

const { Store } = require('../src/db');

const TEST_URL = process.env.TEST_DATABASE_URL || 'postgres://homemanager:homemanager@localhost:5432/homemanager_test';

/** Każdy plik testów dostaje własny, tymczasowy schemat w testowej bazie PostgreSQL. */
async function openTestStore(options = {}) {
  const schema = `t_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  return Store.open({ connectionString: TEST_URL, schema, max: 4, ...options });
}

async function closeTestStore(store) {
  await store.dropSchema();
  await store.close();
}

module.exports = { openTestStore, closeTestStore, TEST_URL };
