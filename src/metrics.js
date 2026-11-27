'use strict';
/*
 * Metryki aplikacji (OpenTelemetry API). Gdy telemetria jest wyłączona, API zwraca puste implementacje –
 * wywołania nic nie kosztują.
 */

const { metrics, trace } = require('@opentelemetry/api');
const pkg = require('../package.json');

const meter = metrics.getMeter('home-manager', pkg.version);

const loginAttempts = meter.createCounter('home_manager.login.attempts', {
  description: 'Próby logowania (result: success, failure, blocked)',
});
const stockChanges = meter.createCounter('home_manager.stock.changes', {
  description: 'Zmiany stanu zasobów (reason: purchase, used, wasted, correction)',
});
const medicineDoses = meter.createCounter('home_manager.medicine.doses', { description: 'Zapisane podania leków' });

/** Liczniki zdarzeń. */
const record = {
  login(result) {
    loginAttempts.add(1, { result });
  },
  stock(reason, n = 1) {
    stockChanges.add(n, { reason: reason || 'other' });
  },
  dose() {
    medicineDoses.add(1);
  },
};

/** Nazwa trasy z wyrażenia regularnego: /^\/api\/items\/(\d+)$/ → /api/items/:id */
function routeName(re) {
  return re.source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/')
    .replace(/\(\\d\+\)/g, ':id')
    .replace(/\(([a-z|-]+)\)/g, '{$1}')
    .replace(/\\/g, '');
}

/** Bieżący ślad HTTP dostaje nazwę trasy (np. „POST /api/medicines/:id/take”) zamiast samego „POST”. */
function nameRequest(method, re) {
  const span = trace.getActiveSpan();
  if (!span) return;
  const route = routeName(re);
  span.updateName(`${method} ${route}`);
  span.setAttribute('http.route', route);
}

/**
 * Stan domu jako wskaźniki (odczytywane przy każdym eksporcie, najczęściej co 30 s):
 * produkty, terminy, apteczka, kalendarz, wydatki i połączenia z bazą.
 */
function observeStore(store, { cacheMs = 30_000 } = {}) {
  let cached = null;
  let at = 0;
  const g = (name, description, unit) => meter.createObservableGauge(name, { description, ...(unit ? { unit } : {}) });
  const gauges = {
    items: g('home_manager.items', 'Produkty w zasobach'),
    lowStock: g('home_manager.items.low_stock', 'Produkty do kupienia (niski stan)'),
    expired: g('home_manager.items.expired', 'Produkty po terminie'),
    expiring: g('home_manager.items.expiring_soon', 'Produkty tracące ważność w 7 dni'),
    medicines: g('home_manager.medicines', 'Leki w apteczce'),
    medExpired: g('home_manager.medicines.expired', 'Leki z opakowaniami po terminie'),
    medExpiring: g('home_manager.medicines.expiring', 'Leki z kończącym się terminem'),
    medLow: g('home_manager.medicines.low', 'Leki – mało lub brak'),
    equipment: g('home_manager.equipment.attention', 'Gwarancje kończące się w 30 dni + przeglądy'),
    spent: g('home_manager.spent.month', 'Wydatki w bieżącym miesiącu', 'PLN'),
    wasted: g('home_manager.wasted.month', 'Wartość zmarnowanych w bieżącym miesiącu', 'PLN'),
    pool: g('home_manager.db.pool.connections', 'Połączenia z bazą (state: total, idle, waiting)'),
    up: g('home_manager.db.up', 'Baza danych odpowiada (1) albo nie (0)'),
  };
  meter.addBatchObservableCallback(async (obs) => {
    let ok = 1;
    try {
      if (!cached || Date.now() - at > cacheMs) {
        cached = await store.stats();
        at = Date.now();
      }
    } catch {
      ok = 0;
    }
    obs.observe(gauges.up, ok);
    const pool = store.pool;
    if (pool) {
      obs.observe(gauges.pool, pool.totalCount ?? 0, { state: 'total' });
      obs.observe(gauges.pool, pool.idleCount ?? 0, { state: 'idle' });
      obs.observe(gauges.pool, pool.waitingCount ?? 0, { state: 'waiting' });
    }
    if (!cached) return;
    const s = cached;
    obs.observe(gauges.items, s.total_items);
    obs.observe(gauges.lowStock, s.low_stock);
    obs.observe(gauges.expired, s.expired);
    obs.observe(gauges.expiring, s.expiring_soon);
    obs.observe(gauges.medicines, s.medicines ?? 0);
    obs.observe(gauges.medExpired, s.med_expired ?? 0);
    obs.observe(gauges.medExpiring, s.med_expiring ?? 0);
    obs.observe(gauges.medLow, s.med_low ?? 0);
    obs.observe(gauges.equipment, (s.warranty_ending ?? 0) + (s.service_due ?? 0));
    obs.observe(gauges.spent, s.spent_month ?? 0);
    obs.observe(gauges.wasted, s.wasted_month ?? 0);
  }, Object.values(gauges));
}

module.exports = { record, observeStore, nameRequest, routeName };
