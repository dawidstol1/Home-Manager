'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Aplikacja otwarta w ramce (panel Home Assistant, strona w Domoticzu): ciasteczka z innej strony bywają
// blokowane (Safari, aplikacje mobilne), więc sesję trzymamy w pamięci tej ramki i wysyłamy jako nagłówek.
const EMBEDDED = (() => { try { return window.self !== window.top; } catch { return true; } })();
const tokenStore = {
  get() { try { return EMBEDDED ? localStorage.getItem('hm-token') : null; } catch { return null; } },
  set(t) { try { if (EMBEDDED && t) localStorage.setItem('hm-token', t); } catch { /* brak pamięci */ } },
  clear() { try { localStorage.removeItem('hm-token'); } catch { /* brak pamięci */ } },
};
const authHeaders = () => { const t = tokenStore.get(); return t ? { Authorization: `Bearer ${t}` } : {}; };

const VIEWS = ['dashboard', 'calendar', 'items', 'pharmacy', 'shopping', 'equipment', 'expenses', 'settings'];
const VIEW_TITLES = {
  dashboard: 'Pulpit', calendar: 'Kalendarz', items: 'Zasoby', pharmacy: 'Domowa apteka', shopping: 'Lista zakupów',
  equipment: 'Sprzęty i dokumenty', expenses: 'Wydatki', settings: 'Ustawienia',
};
const state = { categories: [], locations: [], users: [], currentView: 'dashboard', user: null, months: 6 };

// ---------- Narzędzia ----------

/** Wywołanie API. `raw` – wysyła treść bez zamiany na JSON (pliki). */
async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...authHeaders(), ...(raw ? headers : body ? { 'Content-Type': 'application/json', ...headers } : headers) },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) {
    tokenStore.clear();
    showAuth(false);
    throw new Error('Zaloguj się ponownie');
  }
  if (!res.ok) throw new Error(data.error || `Błąd ${res.status}`);
  return data;
}

const isAdmin = () => state.user?.role === 'admin';
const fmtTime = (ts) => new Date(`${String(ts).replace(' ', 'T')}Z`).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });
const fmtDate = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('pl-PL') : '');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const fmtNum = (n) => Number(n).toLocaleString('pl-PL', { maximumFractionDigits: 3 });
const fmtMoney = (n) => Number(n).toLocaleString('pl-PL', { style: 'currency', currency: 'PLN' });

function todayStr() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function daysUntil(date) {
  return Math.round((Date.parse(date) - Date.parse(todayStr())) / 86400000);
}

function expiryBadge(date) {
  if (!date) return '<span class="muted">—</span>';
  const d = daysUntil(date);
  const label = new Date(date).toLocaleDateString('pl-PL');
  if (d < 0) return `${label} <span class="badge danger">po terminie</span>`;
  if (d <= 7) return `${label} <span class="badge warn">${d === 0 ? 'dziś' : `za ${d} d.`}</span>`;
  return label;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

/** Ikona z zestawu w index.html. */
const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/**
 * Potwierdzenie w oknie aplikacji (zamiast confirm/prompt przeglądarki).
 * Zwraca true/false, a z `input` – wpisany tekst albo null.
 */
function ask(text, { title = 'Na pewno?', ok = 'OK', danger = false, input = null, inputType = 'text' } = {}) {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  const field = $('#confirm-input');
  field.hidden = input === null;
  field.type = inputType;
  field.value = typeof input === 'string' ? input : '';
  const okBtn = $('#confirm-ok');
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger', danger);
  okBtn.classList.toggle('primary', !danger);
  dlg.returnValue = '';
  dlg.showModal();
  if (input !== null) { field.focus(); field.select(); } else okBtn.focus();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      const confirmed = dlg.returnValue === 'ok';
      resolve(input !== null ? (confirmed ? field.value : null) : confirmed);
    }, { once: true });
  });
}

function emptyLi(text) {
  return `<li class="empty-li">${esc(text)}</li>`;
}

// ---------- Układ listy (kafelki / tabela) ----------

function getLayout() {
  try { return localStorage.getItem('hm-layout') === 'table' ? 'table' : 'tiles'; } catch { return 'tiles'; }
}
function setLayout(layout) {
  try { localStorage.setItem('hm-layout', layout); } catch { /* np. tryb prywatny */ }
  applyLayout();
  loadItems().catch((e) => toast(e.message));
}
function applyLayout() {
  const layout = getLayout();
  $('#items-tiles').hidden = layout !== 'tiles';
  $('#items-table').hidden = layout !== 'table';
  $$('[data-layout]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === layout)));
}

// ---------- Nawigacja ----------

function showView(name) {
  state.currentView = name;
  const narrow = matchMedia('(max-width: 900px)').matches;
  const navView = narrow && ['equipment', 'expenses', 'shopping'].includes(name) ? 'settings' : name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === navView));
  $('#page-title').textContent = narrow && name === 'settings' ? 'Więcej' : VIEW_TITLES[name];
  const date = new Date().toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#page-eyebrow').textContent = date.charAt(0).toUpperCase() + date.slice(1);
  document.body.dataset.view = name;
  window.scrollTo({ top: 0 });
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  location.hash = name;
  refresh();
}

function refresh() {
  if (!state.user) return Promise.resolve();
  const views = {
    dashboard: loadDashboard, calendar: loadCalendar, items: loadItems, pharmacy: loadPharmacy, shopping: loadShopping,
    equipment: loadEquipment, expenses: loadExpenses, settings: loadSettings,
  };
  updateShopBadge();
  return views[state.currentView]().catch((e) => toast(e.message));
}

// ---------- Słowniki ----------

async function loadDicts() {
  [state.categories, state.locations] = await Promise.all([api('/categories'), api('/locations')]);
  const fill = (sel, items, emptyLabel) => {
    const current = sel.value;
    sel.innerHTML = `<option value="">${emptyLabel}</option>` +
      items.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('');
    sel.value = current;
  };
  fill($('#f-category'), state.categories, 'Wszystkie kategorie');
  fill($('#f-location'), state.locations, 'Wszystkie lokalizacje');
  fill($('#item-form [name=category_id]'), state.categories, '— brak —');
  fill($('#item-form [name=location_id]'), state.locations, '— brak —');
  renderLocationChips();
}

/** Szybki wybór miejsca: Wszystkie / Kuchnia / Spiżarnia… z liczbą produktów. */
function renderLocationChips() {
  const current = $('#f-location').value;
  const total = state.locations.reduce((s, l) => s + Number(l.item_count || 0), 0);
  const chip = (id, label, count) =>
    `<button type="button" class="chip-btn" data-loc="${id}" aria-pressed="${String(String(id) === current)}">${esc(label)}${count != null ? ` <span class="chip-count">${count}</span>` : ''}</button>`;
  $('#loc-chips').innerHTML = chip('', 'Wszystkie', null) +
    state.locations.filter((l) => Number(l.item_count) > 0 || String(l.id) === current).map((l) => chip(l.id, l.name, l.item_count)).join('');
  if (!total) $('#loc-chips').innerHTML = '';
}

async function updateShopBadge() {
  try {
    const stats = await api('/stats');
    const set = (sel, n) => {
      const b = $(sel);
      b.textContent = n;
      b.hidden = !n;
    };
    set('#shop-badge', stats.low_stock);
    set('#shop-badge-hub', stats.low_stock);
    const t = todayStr();
    set('#cal-badge', (await api(`/events?from=${t}&to=${t}`)).length);
    set('#eq-badge', stats.warranty_ending + stats.service_due);
    set('#eq-badge-hub', stats.warranty_ending + stats.service_due);
    set('#med-badge', stats.med_expired + stats.med_expiring);
  } catch { /* licznik jest tylko podpowiedzią */ }
}

// ---------- Pulpit ----------

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Dobranoc';
  if (h < 12) return 'Dzień dobry';
  if (h < 18) return 'Miłego dnia';
  return 'Dobry wieczór';
}

const plural = (n, one, few, many) => {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n === 1) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
};

async function loadDashboard() {
  const [stats, low, expiring, equipment, meds] = await Promise.all([
    api('/stats'), api('/items?status=low'), api('/items?status=expiring'), api('/equipment'), api('/medicines'),
  ]);

  // Powitanie i podsumowanie dnia.
  $('#hero-greet').textContent = `${greeting()}, ${state.user?.name ?? ''}`.replace(/, $/, '');
  const notes = [];
  if (stats.expired) notes.push(`<strong>${stats.expired}</strong> ${plural(stats.expired, 'produkt jest', 'produkty są', 'produktów jest')} po terminie`);
  if (stats.expiring_soon) notes.push(`<strong>${stats.expiring_soon}</strong> ${plural(stats.expiring_soon, 'traci', 'tracą', 'traci')} ważność w tym tygodniu`);
  if (stats.low_stock) notes.push(`<strong>${stats.low_stock}</strong> ${plural(stats.low_stock, 'pozycja', 'pozycje', 'pozycji')} do kupienia`);
  if (stats.med_expired) notes.push(`<strong>${stats.med_expired}</strong> ${plural(stats.med_expired, 'lek', 'leki', 'leków')} po terminie`);
  $('#hero-sub').innerHTML = notes.length
    ? `${notes.slice(0, 3).join(' · ')}.`
    : 'Wszystko pod kontrolą – zapasy uzupełnione, terminy w porządku.';

  const tile = ({ label, value, cls = '', ico, view }) => {
    const inner = `<span class="s-ico">${icon(ico)}</span><span class="label">${label}</span><span class="value">${value}</span>`;
    return view
      ? `<button type="button" class="stat ${cls}" data-goto="${view}">${inner}</button>`
      : `<div class="stat ${cls}">${inner}</div>`;
  };
  $('#stats').innerHTML = [
    { label: 'Zasoby w domu', value: stats.total_items, cls: 'c-primary', ico: 'box', view: 'items' },
    { label: 'Wartość zapasów', value: fmtMoney(stats.total_value), cls: 'c-ok', ico: 'tag' },
    { label: 'Do kupienia', value: stats.low_stock, cls: stats.low_stock ? 'warn' : '', ico: 'cart', view: 'shopping' },
    { label: 'Ważne ≤ 7 dni', value: stats.expiring_soon, cls: stats.expiring_soon ? 'warn' : '', ico: 'clock', view: 'items' },
    { label: 'Przeterminowane', value: stats.expired, cls: stats.expired ? 'danger' : '', ico: 'alert', view: 'items' },
    { label: 'Leki w apteczce', value: stats.medicines, cls: stats.med_expired ? 'danger' : 'c-med', ico: 'pill', view: 'pharmacy' },
    { label: 'Wydatki w tym miesiącu', value: fmtMoney(stats.spent_month), cls: 'c-sky', ico: 'receipt', view: 'expenses' },
    { label: 'Zmarnowane w tym mies.', value: fmtMoney(stats.wasted_month), cls: stats.wasted_month ? 'warn' : '', ico: 'trash', view: 'expenses' },
  ].map(tile).join('');

  const t0 = todayStr();
  const upcoming = await api(`/events?from=${t0}&to=${isoAdd(t0, 6)}&home=1`);
  $('#dash-cal').innerHTML = renderAgenda(spreadDays(upcoming, t0, isoAdd(t0, 6)), { from: t0, to: isoAdd(t0, 6), skipEmpty: true, limit: 8 })
    || '<p class="agenda-empty">Nic zaplanowanego na najbliższy tydzień. Dodaj wpis w kalendarzu – zobaczy go cała rodzina.</p>';

  const alerts = equipmentAlerts(equipment);
  $('#dash-eq-card').hidden = !alerts.length;
  $('#dash-eq').innerHTML = alerts.map((a) => `<li data-eq-id="${a.id}" class="clickable"><span>${esc(a.name)}</span>${a.badge}</li>`).join('');

  const medAlerts = meds.filter((m) => m.has_expired || m.expiring || (m.low && m.min_quantity > 0));
  $('#dash-med-card').hidden = !meds.length;
  $('#dash-med').innerHTML = medAlerts.length
    ? medAlerts.slice(0, 6).map((m) => `<li data-med-id="${m.id}" class="clickable">
        <span class="li-main"><span class="med-ico ${formIcon(m.form).cls}" style="width:32px;height:32px;border-radius:10px">${icon(formIcon(m.form).ico)}</span><span>${esc(m.name)}</span></span>
        ${medStatusBadge(m)}</li>`).join('')
    : emptyLi('Apteczka w porządku – żadnych leków po terminie');

  $('#dash-low').innerHTML = low.length
    ? low.map((i) => `<li><span class="li-main">${thumb(i)}<span>${esc(i.name)}</span></span><span class="badge warn">${fmtNum(i.quantity)} / min ${fmtNum(i.min_quantity)} ${esc(i.unit)}</span></li>`).join('')
    : emptyLi('Wszystkie zapasy na odpowiednim poziomie');

  $('#dash-expiring').innerHTML = expiring.length
    ? expiring.sort((a, b) => a.expires_at.localeCompare(b.expires_at))
      .map((i) => `<li><span class="li-main">${thumb(i)}<span>${esc(i.name)}</span></span><span>${expiryBadge(i.expires_at)}</span></li>`).join('')
    : emptyLi('Brak produktów z bliskim terminem ważności');

  const max = Math.max(1, ...stats.by_category.map((c) => c.count));
  $('#dash-categories').innerHTML = stats.by_category.length
    ? stats.by_category.map((c) => `
        <div class="bar-row">
          <span>${esc(c.name)}</span>
          <div class="bar-track"><div class="bar" style="width:${(c.count / max) * 100}%"></div></div>
          <span class="count">${c.count}</span>
        </div>`).join('')
    : '<p class="muted">Dodaj pierwszy zasób w zakładce „Zasoby”.</p>';
}

// ---------- Integracje ----------

async function loadIntegrations() {
  const [tokens, embed] = await Promise.all([api('/tokens'), api('/settings/embed')]);
  $('#token-list').innerHTML = tokens.length
    ? tokens.map((t) => `<li data-token="${t.id}">
        <span class="li-main">${icon('key')}<span>${esc(t.name)} <span class="muted small">· …${esc(t.hint)}</span>
          <span class="li-sub">utworzony ${fmtTime(t.created_at)} · ${t.last_used_at ? `ostatnio użyty ${fmtTime(t.last_used_at)}` : 'jeszcze nieużyty'}</span></span></span>
        <button type="button" class="btn sm danger" data-token-del>Usuń</button>
      </li>`).join('')
    : emptyLi('Brak kluczy. Utwórz klucz i wklej go w ustawieniach wtyczki.');
  const area = $('#embed-form').elements.origins;
  if (document.activeElement !== area) area.value = embed.origins.join('\n');
  area.readOnly = !isAdmin();
  $('#embed-note').textContent = isAdmin() ? '' : 'Adresy zmienia administrator.';
}

async function createToken(e) {
  e.preventDefault();
  const form = e.target;
  try {
    const t = await api('/tokens', { method: 'POST', body: { name: form.elements.name.value } });
    form.reset();
    $('#token-new').hidden = false;
    $('#token-value').value = t.token;
    $('#token-value').select();
    loadIntegrations();
  } catch (err) {
    toast(err.message);
  }
}

async function onTokenClick(e) {
  const del = e.target.closest('[data-token-del]');
  if (!del) return;
  const li = del.closest('[data-token]');
  if (!(await ask('Wtyczki, które go używają, przestaną działać.', { title: 'Usunąć klucz?', ok: 'Usuń', danger: true }))) return;
  try {
    await api(`/tokens/${li.dataset.token}`, { method: 'DELETE' });
    toast('Usunięto klucz');
    loadIntegrations();
  } catch (err) {
    toast(err.message);
  }
}

async function saveEmbed(e) {
  e.preventDefault();
  const origins = e.target.elements.origins.value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  try {
    const res = await api('/settings/embed', { method: 'PUT', body: { origins } });
    e.target.elements.origins.value = res.origins.join('\n');
    toast('Zapisano adresy');
  } catch (err) {
    toast(err.message);
  }
}

/** W ramce obrazki i pliki dokumentów pobieramy z nagłówkiem sesji (bez ciasteczka by nie przeszły). */
function setupEmbeddedFiles() {
  if (!EMBEDDED) return;
  document.body.classList.add('embedded');
  const blobs = new Map();
  const blobFor = async (url) => {
    if (!blobs.has(url)) {
      blobs.set(url, fetch(url, { headers: authHeaders() }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`Błąd ${r.status}`)))).then((b) => URL.createObjectURL(b)));
    }
    return blobs.get(url);
  };
  const fix = (img) => {
    const src = img.getAttribute('src');
    if (!src || !src.startsWith('/api/documents/')) return;
    img.removeAttribute('src');
    blobFor(src).then((u) => { img.src = u; }).catch(() => {});
  };
  new MutationObserver((list) => {
    for (const m of list) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') fix(n);
        n.querySelectorAll?.('img[src^="/api/documents/"]').forEach(fix);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="/api/documents/"]');
    if (!a) return;
    e.preventDefault();
    const win = window.open('', '_blank');
    blobFor(a.getAttribute('href')).then((u) => {
      if (win) win.location = u;
      else location.href = u;
    }).catch((err) => { win?.close(); toast(err.message); });
  });
}

// ---------- Kalendarz ----------

const CAT = {
  family: 'Rodzina', home: 'Dom', health: 'Zdrowie', school: 'Szkoła',
  work: 'Praca', birthday: 'Urodziny', trip: 'Wyjazd', other: 'Inne',
};
const REPEAT_LABEL = { daily: 'codziennie', weekly: 'co tydzień', biweekly: 'co 2 tygodnie', monthly: 'co miesiąc', yearly: 'co rok' };
const MONTHS_FULL = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'];
const cal = { year: 0, month: 0, selected: '', mode: 'month', who: 'all', events: [], editing: null };

const isoAdd = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const isoDow = (d) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = poniedziałek
const initials = (name = '') => name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const USER_GRADS = [
  'linear-gradient(135deg,#6a5cff,#b35cff)', 'linear-gradient(135deg,#ec4899,#f97316)', 'linear-gradient(135deg,#10b981,#0ea5e9)',
  'linear-gradient(135deg,#f59e0b,#ef4444)', 'linear-gradient(135deg,#0ea5e9,#6366f1)', 'linear-gradient(135deg,#14b8a6,#84cc16)',
];
function userAvatar(id) {
  const idx = state.users.findIndex((u) => u.id === id);
  const u = state.users[idx];
  if (!u) return '';
  return `<span class="avatar" style="background:${USER_GRADS[idx % USER_GRADS.length]}" title="${esc(u.name)}">${esc(initials(u.name))}</span>`;
}

function dayLabel(d, { weekday = true } = {}) {
  const t = todayStr();
  const base = new Date(`${d}T00:00:00`).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', ...(weekday ? { weekday: 'long' } : {}) });
  if (d === t) return `Dziś · ${base}`;
  if (d === isoAdd(t, 1)) return `Jutro · ${base}`;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Wpisy rozłożone na dni (wpis wielodniowy pojawia się w każdym swoim dniu). */
function spreadDays(events, from, to) {
  const byDay = new Map();
  for (const e of events) {
    const last = e.end_date && e.end_date < to ? e.end_date : (e.end_date || e.date);
    for (let d = e.date < from ? from : e.date; d <= last && d <= to; d = isoAdd(d, 1)) {
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(e);
    }
  }
  return byDay;
}

function evTime(e, day) {
  if (e.end_date) {
    if (day === e.date) return e.start_time ? `${e.start_time}<small>start</small>` : '<span>od</span><small>dziś</small>';
    if (day === e.end_date) return '<span>do</span><small>dziś</small>';
    return '<span>·</span><small>cały dzień</small>';
  }
  if (!e.start_time) return '<span>—</span><small>cały dzień</small>';
  return `${e.start_time}${e.end_time ? `<small>do ${e.end_time}</small>` : ''}`;
}

function evRow(e, day) {
  const who = e.for_users?.length ? e.for_users.map(userAvatar).join('') : '';
  const meta = [
    e.readonly ? `<span>${icon(e.source === 'medicine' ? 'pill' : 'wrench')}z domu</span>` : `<span>${esc(CAT[e.category] ?? 'Inne')}</span>`,
    e.repeat && e.repeat !== 'none' ? `<span>${icon('repeat')}${REPEAT_LABEL[e.repeat]}</span>` : '',
    e.visibility === 'private' ? `<span>${icon('lock')}tylko Ty</span>` : '',
    !e.readonly && e.visibility !== 'private' && !e.for_users?.length ? `<span>${icon('users')}cała rodzina</span>` : '',
    e.notes ? `<span>${esc(e.notes.length > 40 ? `${e.notes.slice(0, 40)}…` : e.notes)}</span>` : '',
  ].filter(Boolean).join('');
  return `<button type="button" class="ev ev-${esc(e.category)}${e.readonly ? ' home' : ''}" data-ev="${e.id ?? ''}" data-src="${e.readonly ? esc(e.source) : ''}" data-ref="${e.ref_id ?? ''}">
    <span class="ev-time">${evTime(e, day)}</span>
    <span class="ev-body"><span class="ev-title">${esc(e.title)}</span><span class="ev-meta">${meta}</span></span>
    <span class="ev-who">${who}</span>
  </button>`;
}

function renderAgenda(byDay, { from, to, skipEmpty = false, limit = Infinity }) {
  let html = '';
  let count = 0;
  for (let d = from; d <= to && count < limit; d = isoAdd(d, 1)) {
    const list = byDay.get(d) ?? [];
    if (!list.length && skipEmpty) continue;
    html += `<div class="agenda-day"><div class="agenda-date${d === todayStr() ? ' today' : ''}">${dayLabel(d)}</div>
      ${list.length ? list.map((e) => evRow(e, d)).join('') : '<p class="agenda-empty">Nic zaplanowanego.</p>'}</div>`;
    count += list.length || 1;
  }
  return html;
}

async function loadCalendar() {
  if (!cal.year) {
    const t = todayStr();
    cal.year = Number(t.slice(0, 4));
    cal.month = Number(t.slice(5, 7)) - 1;
    cal.selected = t;
  }
  const first = `${cal.year}-${String(cal.month + 1).padStart(2, '0')}-01`;
  const days = new Date(Date.UTC(cal.year, cal.month + 1, 0)).getUTCDate();
  const last = `${first.slice(0, 8)}${String(days).padStart(2, '0')}`;
  const gridFrom = isoAdd(first, -isoDow(first));
  const gridTo = isoAdd(last, 6 - isoDow(last));
  const listFrom = cal.mode === 'list' ? (todayStr() > first && todayStr() <= last ? todayStr() : first) : gridFrom;
  const listTo = cal.mode === 'list' ? isoAdd(listFrom, 59) : gridTo;

  const params = new URLSearchParams({ from: listFrom, to: listTo });
  if ($('#cal-home').checked) params.set('home', '1');
  if (cal.who === 'mine') params.set('mine', '1');
  else if (cal.who !== 'all') params.set('user', cal.who);
  cal.events = await api(`/events?${params}`);

  $('#cal-title').textContent = cal.mode === 'list'
    ? `${dayLabel(listFrom, { weekday: false }).replace(/^(Dziś|Jutro) · /, '')} – ${new Date(`${listTo}T00:00:00`).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' })}`
    : `${MONTHS_FULL[cal.month]} ${cal.year}`;
  $$('[data-cal-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.calMode === cal.mode)));
  $('#cal-month').hidden = cal.mode !== 'month';
  $('#cal-list').hidden = cal.mode !== 'list';

  const chip = (value, label, extra = '') => `<button type="button" class="chip-btn person" data-cal-who="${value}" aria-pressed="${cal.who === String(value)}">${extra}${esc(label)}</button>`;
  $('#cal-filters').innerHTML = chip('all', 'Wszystko') + chip('mine', 'Moje wpisy')
    + state.users.map((u) => chip(u.id, u.name, userAvatar(u.id).replace('class="avatar"', 'class="avatar"'))).join('');

  const byDay = spreadDays(cal.events, listFrom, listTo);
  if (cal.mode === 'list') {
    $('#cal-agenda').innerHTML = renderAgenda(byDay, { from: listFrom, to: listTo, skipEmpty: true })
      || '<p class="agenda-empty">Brak wpisów w najbliższych 60 dniach.</p>';
    return;
  }
  const t = todayStr();
  let cells = '';
  for (let d = gridFrom; d <= gridTo; d = isoAdd(d, 1)) {
    const list = byDay.get(d) ?? [];
    const cls = [d.slice(0, 7) !== first.slice(0, 7) ? 'out' : '', d === t ? 'today' : '', d === cal.selected ? 'selected' : '', isoDow(d) >= 5 ? 'weekend' : ''].join(' ');
    const pills = list.slice(0, 3).map((e) => `<span class="cal-pill ev-${esc(e.category)}${e.readonly ? ' home' : ''}">${e.start_time && !e.end_date ? `<span class="t">${e.start_time}</span>` : ''}${esc(e.title)}</span>`).join('');
    const more = list.length > 3 ? `<span class="cal-more">+${list.length - 3} więcej</span>` : '';
    const dots = list.slice(0, 4).map((e) => `<span class="cal-dot ev-${esc(e.category)}"></span>`).join('');
    cells += `<button type="button" class="cal-cell ${cls}" data-day="${d}" aria-label="${dayLabel(d)}${list.length ? `, ${list.length} ${plural(list.length, 'wpis', 'wpisy', 'wpisów')}` : ''}">
      <span class="cal-num">${Number(d.slice(8))}</span>${pills}${more}<span class="cal-dots">${dots}</span></button>`;
  }
  $('#cal-grid').innerHTML = cells;
  renderCalDay(byDay);
}

function renderCalDay(byDay = spreadDays(cal.events, cal.selected, cal.selected)) {
  const d = cal.selected;
  const label = dayLabel(d);
  const [prefix, rest] = label.includes(' · ') ? label.split(' · ') : ['', label];
  $('#cal-day-week').textContent = prefix || new Date(`${d}T00:00:00`).toLocaleDateString('pl-PL', { weekday: 'long' }).replace(/^./, (c) => c.toUpperCase());
  $('#cal-day-title').textContent = prefix ? rest : new Date(`${d}T00:00:00`).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' });
  const list = byDay.get(d) ?? [];
  $('#cal-day-list').innerHTML = list.length
    ? list.map((e) => evRow(e, d)).join('')
    : '<p class="agenda-empty">Wolny dzień. Dotknij „+”, żeby coś zaplanować.</p>';
}

function moveMonth(delta) {
  cal.month += delta;
  if (cal.month < 0) { cal.month = 11; cal.year -= 1; }
  if (cal.month > 11) { cal.month = 0; cal.year += 1; }
  const first = `${cal.year}-${String(cal.month + 1).padStart(2, '0')}-01`;
  if (cal.selected.slice(0, 7) !== first.slice(0, 7)) cal.selected = first;
  loadCalendar().catch((e) => toast(e.message));
}

function openEvent(ev = null, date = null) {
  const form = $('#event-form');
  form.reset();
  $('#event-error').hidden = true;
  cal.editing = ev;
  const v = ev ?? { starts_on: date || cal.selected || todayStr(), category: 'family', visibility: 'shared', repeat: 'none', for_users: [] };
  form.elements.id.value = ev?.id ?? '';
  form.elements.title.value = v.title ?? '';
  form.elements.starts_on.value = v.starts_on;
  form.elements.ends_on.value = v.ends_on ?? '';
  form.elements.all_day.checked = !v.start_time;
  form.elements.start_time.value = v.start_time ?? '';
  form.elements.end_time.value = v.end_time ?? '';
  form.elements.repeat.value = v.repeat;
  form.elements.repeat_until.value = v.repeat_until ?? '';
  form.elements.notes.value = v.notes ?? '';
  form.dataset.category = v.category;
  form.dataset.visibility = v.visibility;
  form.dataset.users = JSON.stringify(v.for_users ?? []);
  $('#event-dialog-title').textContent = ev ? 'Edytuj wpis' : 'Nowy wpis';
  $('#event-owner').textContent = ev?.owner_name ? `Dodał(a): ${ev.owner_name}` : 'Wspólny kalendarz domu';
  $('#event-delete').hidden = !ev;
  $('#event-repeat-note').hidden = !ev || ev.repeat === 'none';
  // Prywatność wpisu może zmienić tylko jego autor.
  const canVis = !ev || ev.owner_id === state.user.id;
  $$('#event-vis button').forEach((b) => { b.disabled = !canVis; });
  syncEventForm();
  $('#event-dialog').showModal();
  if (!ev) form.elements.title.focus();
}

function syncEventForm() {
  const form = $('#event-form');
  const allDay = form.elements.all_day.checked;
  $$('#event-form [data-time]').forEach((el) => { el.hidden = allDay; });
  $('#event-form [data-until]').hidden = form.elements.repeat.value === 'none';
  const cat = form.dataset.category;
  $('#event-ico').className = `ev-ico lg ev-${cat}`;
  $('#event-ico').innerHTML = icon(cat === 'health' ? 'cross' : cat === 'home' ? 'home' : cat === 'birthday' ? 'sparkle' : cat === 'trip' ? 'pin' : cat === 'school' ? 'book' : 'calendar');
  $('#event-cats').innerHTML = Object.entries(CAT).map(([k, l]) => `<button type="button" class="chip-btn cat ev-${k}" data-cat="${k}" aria-pressed="${k === cat}">${l}</button>`).join('');
  const users = JSON.parse(form.dataset.users || '[]');
  $('#event-users').innerHTML = state.users.map((u) => `<button type="button" class="chip-btn person" data-user-pick="${u.id}" aria-pressed="${users.includes(u.id)}">${userAvatar(u.id)}${esc(u.name)}</button>`).join('');
  $$('#event-vis [data-vis]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.vis === form.dataset.visibility)));
}

async function saveEvent(e) {
  e.preventDefault();
  const form = e.target;
  const f = form.elements;
  const allDay = f.all_day.checked;
  const body = {
    title: f.title.value,
    starts_on: f.starts_on.value,
    ends_on: f.ends_on.value || null,
    start_time: allDay ? null : f.start_time.value || null,
    end_time: allDay ? null : f.end_time.value || null,
    repeat: f.repeat.value,
    repeat_until: f.repeat.value === 'none' ? null : f.repeat_until.value || null,
    notes: f.notes.value,
    category: form.dataset.category,
    for_users: JSON.parse(form.dataset.users || '[]'),
  };
  if (!cal.editing || cal.editing.owner_id === state.user.id) body.visibility = form.dataset.visibility;
  const id = f.id.value;
  try {
    const saved = await api(id ? `/events/${id}` : '/events', { method: id ? 'PUT' : 'POST', body });
    $('#event-dialog').close();
    toast(id ? 'Zapisano zmiany' : `Dodano do kalendarza: ${saved.title}`);
    cal.selected = saved.starts_on;
    if (state.currentView === 'calendar') {
      cal.year = Number(saved.starts_on.slice(0, 4));
      cal.month = Number(saved.starts_on.slice(5, 7)) - 1;
    }
    refresh();
  } catch (err) {
    $('#event-error').textContent = err.message;
    $('#event-error').hidden = false;
  }
}

async function deleteEvent() {
  const ev = cal.editing;
  if (!ev) return;
  const extra = ev.repeat !== 'none' ? ' Znikną wszystkie powtórzenia.' : '';
  if (!(await ask(`Wpis zniknie z kalendarza.${extra}`, { title: `Usunąć „${ev.title}”?`, ok: 'Usuń', danger: true }))) return;
  try {
    await api(`/events/${ev.id}`, { method: 'DELETE' });
    $('#event-dialog').close();
    toast('Usunięto wpis');
    refresh();
  } catch (err) {
    toast(err.message);
  }
}

/** Kliknięcie wpisu na liście: własny wpis → edycja, termin z domu → odpowiedni widok. */
async function onEventClick(e) {
  const row = e.target.closest('.ev');
  if (!row) return;
  if (row.dataset.src === 'medicine') {
    showView('pharmacy');
    return api(`/medicines/${row.dataset.ref}`).then(openMedicine).catch((err) => toast(err.message));
  }
  if (row.dataset.src === 'equipment') {
    showView('equipment');
    return openEquipment(row.dataset.ref).catch((err) => toast(err.message));
  }
  try {
    openEvent(await api(`/events/${row.dataset.ev}`));
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Domowa apteka ----------

const pharm = { filter: '', person: '', list: [], suggestions: { persons: [], kits: [], forms: [] }, current: null, takeId: null };

/** Ikona i kolor zależnie od postaci leku. */
function formIcon(form = '') {
  const f = form.toLowerCase();
  if (/syrop|zawies|płyn|plyn|roztw/.test(f)) return { ico: 'bottle', cls: 'f-bottle' };
  if (/krop/.test(f)) return { ico: 'drop', cls: 'f-drop' };
  if (/maś|mas|krem|żel|zel/.test(f)) return { ico: 'tube', cls: 'f-tube' };
  if (/aerozol|spray|inhal/.test(f)) return { ico: 'spray', cls: 'f-spray' };
  if (/plast|opatr|banda/.test(f)) return { ico: 'bandage', cls: 'f-bandage' };
  return { ico: 'pill', cls: '' };
}

function medStatusBadge(m) {
  if (m.has_expired) return `<span class="badge danger">${m.quantity > 0 ? 'część po terminie' : 'po terminie'}</span>`;
  if (m.expiring) {
    const d = daysUntil(m.next_deadline);
    return `<span class="badge warn">${d === 0 ? 'ważny do dziś' : `ważny ${d} d.`}</span>`;
  }
  if (m.quantity <= 0) return '<span class="badge">brak</span>';
  if (m.low) return '<span class="badge warn">mało</span>';
  return '';
}

/** „dziś 14:05”, „wczoraj 9:30”, „12.11 18:00” + ile godzin temu. */
function whenTaken(ts) {
  const d = new Date(`${String(ts).replace(' ', 'T')}Z`);
  const mins = Math.round((Date.now() - d) / 60000);
  const time = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  const dayDiff = Math.round((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 86400000);
  const day = dayDiff === 0 ? 'dziś' : dayDiff === 1 ? 'wczoraj' : d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
  const ago = mins < 60 ? `${Math.max(mins, 1)} min temu` : mins < 48 * 60 ? `${Math.round(mins / 60)} h temu` : '';
  return { label: `${day} ${time}`, ago, mins };
}

async function loadPharmacy() {
  const params = new URLSearchParams();
  const q = $('#med-q').value.trim();
  if (q) params.set('q', q);
  if (pharm.person) params.set('person', pharm.person);
  const [all, list, sug] = await Promise.all([
    api('/medicines'),
    api(`/medicines?${params}${pharm.filter ? `&status=${pharm.filter}` : ''}`),
    api('/medicines/suggestions'),
  ]);
  pharm.list = list;
  pharm.suggestions = sug;
  $('#med-persons').innerHTML = sug.persons.map((p) => `<option value="${esc(p)}">`).join('');
  $('#med-kits').innerHTML = sug.kits.map((k) => `<option value="${esc(k)}">`).join('');

  // Pasek: przeterminowane do oddania w aptece.
  const expired = all.filter((m) => m.has_expired);
  $('#med-expired-banner').hidden = !expired.length;
  $('#med-expired-title').textContent = expired.length
    ? `${expired.length} ${plural(expired.length, 'lek', 'leki', 'leków')} po terminie: ${expired.slice(0, 3).map((m) => m.name).join(', ')}${expired.length > 3 ? '…' : ''}`
    : '';

  const count = (fn) => all.filter(fn).length;
  const chip = (value, label, n, cls = '') =>
    `<button type="button" class="chip-btn ${cls}" data-med-filter="${value}" aria-pressed="${pharm.filter === value}">${cls ? '<span class="chip-dot"></span>' : ''}${label}${n != null ? ` <span class="chip-count">${n}</span>` : ''}</button>`;
  const persons = [...new Set(all.map((m) => m.person).filter(Boolean))];
  $('#med-filters').innerHTML = [
    chip('', 'Wszystkie', all.length),
    count((m) => m.has_expired) ? chip('expired', 'Po terminie', count((m) => m.has_expired), 'c-danger') : '',
    count((m) => m.expiring) ? chip('expiring', 'Kończy się termin', count((m) => m.expiring), 'c-warn') : '',
    count((m) => m.low) ? chip('low', 'Mało / brak', count((m) => m.low), 'c-warn') : '',
    ...persons.map((p) => `<button type="button" class="chip-btn" data-med-person="${esc(p)}" aria-pressed="${pharm.person === p}">${icon('user')}${esc(p)}</button>`),
  ].join('');

  $('#med-empty').hidden = list.length > 0;
  $('#med-empty-text').textContent = all.length
    ? 'Żaden lek nie pasuje do wyszukiwania.'
    : 'Dodaj leki, które masz w domu – aplikacja przypomni o terminach, podpowie, co podać na gorączkę czy ból głowy, i zapamięta, kto co dostał.';
  $('#med-list').innerHTML = list.map(medCard).join('');
}

function medCard(m) {
  const f = formIcon(m.form);
  const tags = m.purpose.split(/[,;]+/).map((t) => t.trim()).filter(Boolean).slice(0, 4);
  const last = m.last_taken ? whenTaken(m.last_taken.created_at) : null;
  const cls = m.has_expired ? 'expired' : m.expiring ? 'expiring' : m.quantity <= 0 ? 'empty' : '';
  return `
    <article class="med-card ${cls}" data-med-id="${m.id}" tabindex="0">
      <div class="med-top">
        <span class="med-ico ${f.cls}">${icon(f.ico)}</span>
        <div class="med-title">
          <h3>${esc(m.name)}${m.prescription ? '<span class="rx" title="Lek na receptę">Rx</span>' : ''}</h3>
          <div class="med-sub">${esc([m.strength, m.form, m.substance && m.substance.toLowerCase() !== m.name.toLowerCase() ? m.substance : ''].filter(Boolean).join(' · ') || ' ')}</div>
        </div>
        ${medStatusBadge(m)}
      </div>
      ${tags.length ? `<div class="med-tags">${tags.map((t) => `<span class="med-tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="med-meta">
        ${m.person ? `<span>${icon('user')}${esc(m.person)}</span>` : ''}
        ${m.kit ? `<span>${icon('pin')}${esc(m.kit)}</span>` : ''}
        ${m.next_deadline ? `<span>${icon('clock')}do ${fmtDate(m.next_deadline)}</span>` : ''}
      </div>
      ${last ? `<div class="med-last">${icon('history')}Ostatnio: ${last.label}${last.ago ? ` (${last.ago})` : ''}${m.last_taken.person ? ` · ${esc(m.last_taken.person)}` : ''}</div>` : ''}
      <div class="med-foot">
        <span class="med-qty"><strong>${fmtNum(m.quantity)} ${esc(m.unit)}</strong><span>${m.packs.filter((p) => !p.expired).length} ${plural(m.packs.filter((p) => !p.expired).length, 'opakowanie', 'opakowania', 'opakowań')}${m.opened ? ' · otwarte' : ''}</span></span>
        <button type="button" class="btn sm primary med" data-med-take="${m.id}" ${m.quantity > 0 ? '' : 'disabled'}>${icon('check')}Podaj</button>
      </div>
    </article>`;
}

function openMedicine(med = null, prefill = {}) {
  const form = $('#med-form');
  form.reset();
  $('#med-error').hidden = true;
  pharm.current = med;
  const values = med ?? { unit: 'tabl.', min_quantity: 0, ...prefill };
  for (const el of form.elements) {
    if (!el.name || !(el.name in values)) continue;
    if (el.type === 'checkbox') el.checked = Boolean(values[el.name]);
    else el.value = values[el.name] ?? '';
  }
  form.elements.id.value = med?.id ?? '';
  $('#med-dialog-title').textContent = med ? med.name : 'Nowy lek';
  const f = formIcon(values.form);
  $('#med-form-ico').className = `med-ico lg ${f.cls}`;
  $('#med-form-ico').innerHTML = icon(f.ico);
  $('#med-first').hidden = Boolean(med);
  $('#med-delete').hidden = !med;
  renderPacks(med);
  $('#med-dialog').showModal();
  if (!med) form.elements.name.focus();
}

function renderPacks(med) {
  $('#med-packs').hidden = !med;
  $('#med-log-box').hidden = !med?.log?.length;
  if (!med) return;
  $('#med-packs-sum').textContent = `do użycia: ${fmtNum(med.quantity)} ${med.unit}${med.expired_quantity ? ` · po terminie: ${fmtNum(med.expired_quantity)}` : ''}`;
  $('#med-pack-list').innerHTML = med.packs.length
    ? med.packs.map((p) => `
      <li data-pack="${p.id}" class="${p.expired ? 'danger' : p.expiring ? 'warn' : ''}">
        <label>Ilość<input type="number" min="0" step="any" value="${p.quantity}" data-pf="quantity" aria-label="Ilość"></label>
        <label>Ważne do<input type="date" value="${p.expires_at ?? ''}" data-pf="expires_at"></label>
        <label>Otwarte<input type="date" value="${p.opened_at ?? ''}" data-pf="opened_at"></label>
        <button type="button" class="btn sm danger" data-pack-del title="Utylizuj opakowanie">${icon('trash')}</button>
        <span class="pack-info">${p.deadline ? `termin: <strong>${fmtDate(p.deadline)}</strong>` : 'bez terminu'}
          ${p.opened_at && med.after_opening_days && p.deadline !== p.expires_at ? `<span class="badge">${med.after_opening_days} dni po otwarciu</span>` : ''}
          ${p.expired ? '<span class="badge danger">po terminie – oddaj w aptece</span>' : p.expiring ? '<span class="badge warn">kończy się termin</span>' : ''}</span>
      </li>`).join('')
    : `<li class="muted small" style="border:0;display:block">Brak opakowań – dodaj nowe poniżej.</li>`;
  const LOG = { added: ['plus', 'Dodano'], taken: ['check', 'Podano'], disposed: ['trash', 'Zutylizowano'], correction: ['edit', 'Korekta'] };
  $('#med-log').innerHTML = (med.log ?? []).slice(0, 12).map((l) => `
    <li data-log="${l.id}">
      <span class="li-main">${icon(LOG[l.reason]?.[0] ?? 'edit')}<span>${LOG[l.reason]?.[1] ?? l.reason}${l.person ? ` · ${esc(l.person)}` : ''}${l.note ? ` · <span class="muted">${esc(l.note)}</span>` : ''}
        <span class="li-sub">${fmtTime(l.created_at)}${l.user_name ? ` · ${esc(l.user_name)}` : ''}</span></span></span>
      <span class="row nowrap"><strong class="${l.delta > 0 ? 'delta-pos' : ''}">${l.delta > 0 ? '+' : ''}${fmtNum(l.delta)} ${esc(med.unit)}</strong>
      ${l.reason === 'taken' ? `<button type="button" class="btn sm" data-log-undo="${l.id}">Cofnij</button>` : ''}</span>
    </li>`).join('');
}

async function medApi(path, opts) {
  try {
    const med = await api(path, opts);
    pharm.current = med;
    renderPacks(med);
    loadPharmacy().catch(() => {});
    updateShopBadge();
    return med;
  } catch (err) {
    toast(err.message);
    return null;
  }
}

async function saveMedicine(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  const { id } = data;
  delete data.id;
  data.prescription = form.elements.prescription.checked;
  data.after_opening_days = data.after_opening_days || null;
  if (id) {
    delete data.quantity;
    delete data.expires_at;
  } else if (!data.quantity) {
    delete data.quantity;
    delete data.expires_at;
  }
  try {
    await api(id ? `/medicines/${id}` : '/medicines', { method: id ? 'PUT' : 'POST', body: data });
    $('#med-dialog').close();
    toast(id ? 'Zapisano zmiany' : `Dodano do apteczki: ${data.name}`);
    refresh();
  } catch (err) {
    $('#med-error').textContent = err.message;
    $('#med-error').hidden = false;
  }
}

async function deleteMedicine() {
  const med = pharm.current;
  if (!med) return;
  if (!(await ask('Lek zniknie z apteczki razem z historią podań.', { title: `Usunąć „${med.name}”?`, ok: 'Usuń', danger: true }))) return;
  try {
    await api(`/medicines/${med.id}`, { method: 'DELETE' });
    $('#med-dialog').close();
    toast('Usunięto lek');
    refresh();
  } catch (err) {
    toast(err.message);
  }
}

async function onPackChange(e) {
  const input = e.target.closest('[data-pf]');
  if (!input) return;
  const id = input.closest('[data-pack]').dataset.pack;
  const value = input.dataset.pf === 'quantity' ? Number(input.value) : (input.value || null);
  await medApi(`/medicine-packs/${id}`, { method: 'PATCH', body: { [input.dataset.pf]: value } });
}

async function onPackClick(e) {
  const del = e.target.closest('[data-pack-del]');
  if (del) {
    if (!(await ask('Przeterminowane i niepotrzebne leki oddaj w aptece – nie wyrzucaj ich do kosza.', { title: 'Usunąć opakowanie z apteczki?', ok: 'Usuń', danger: true }))) return;
    await medApi(`/medicine-packs/${del.closest('[data-pack]').dataset.pack}`, { method: 'DELETE' });
  }
}

async function addPack() {
  if (!pharm.current) return;
  const qty = Number($('#pack-add-qty').value);
  if (!(qty > 0)) return toast('Podaj ilość w nowym opakowaniu');
  const med = await medApi(`/medicines/${pharm.current.id}/packs`, {
    method: 'POST', body: { quantity: qty, expires_at: $('#pack-add-date').value || null },
  });
  if (med) {
    $('#pack-add-qty').value = '';
    $('#pack-add-date').value = '';
    toast('Dodano opakowanie');
  }
}

async function undoMedLog(id) {
  const med = await medApi(`/medicine-log/${id}/undo`, { method: 'POST' });
  if (med) toast('Cofnięto podanie');
}

async function openTake(id) {
  const med = await api(`/medicines/${id}`);
  pharm.takeId = med.id;
  const form = $('#take-form');
  form.reset();
  $('#take-error').hidden = true;
  const f = formIcon(med.form);
  $('#take-ico').className = `med-ico lg ${f.cls}`;
  $('#take-ico').innerHTML = icon(f.ico);
  $('#take-title').textContent = `Podaj: ${med.name}`;
  $('#take-sub').textContent = `Zostało ${fmtNum(med.quantity)} ${med.unit}${med.strength ? ` · ${med.strength}` : ''}`;
  $('#take-unit').textContent = med.unit;
  form.elements.amount.value = med.unit === 'ml' ? 5 : 1;
  form.elements.person.value = med.person && !/wszy|dorośli|dzieci/i.test(med.person) ? med.person : '';
  $('#take-dosage').hidden = !med.dosage;
  $('#take-dosage').innerHTML = med.dosage ? `<strong>Dawkowanie:</strong> ${esc(med.dosage)}` : '';
  const last = med.last_taken;
  const lastBox = $('#take-last');
  lastBox.hidden = !last;
  if (last) {
    const w = whenTaken(last.created_at);
    lastBox.classList.toggle('recent', w.mins < 4 * 60);
    lastBox.innerHTML = `${icon('clock')}<span>Ostatnio podano <strong>${w.label}</strong>${w.ago ? ` (${w.ago})` : ''}: ${fmtNum(last.amount)} ${esc(med.unit)}${last.person ? ` – ${esc(last.person)}` : ''}${last.user_name ? ` <span class="muted">· zapisał(a) ${esc(last.user_name)}</span>` : ''}.${w.mins < 4 * 60 ? ' Sprawdź odstęp między dawkami.' : ''}</span>`;
  }
  const persons = [...new Set([...pharm.suggestions.persons, ...state.users.map((u) => u.name)])].slice(0, 8);
  $('#take-persons').innerHTML = persons.map((p) => `<button type="button" class="chip-btn" data-take-person="${esc(p)}" aria-pressed="${form.elements.person.value === p}">${esc(p)}</button>`).join('');
  $('#take-dialog').showModal();
}

async function saveTake(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    const med = await api(`/medicines/${pharm.takeId}/take`, { method: 'POST', body: { amount: Number(data.amount), person: data.person, note: data.note } });
    $('#take-dialog').close();
    toast(`Zapisano: ${med.name}, ${fmtNum(Number(data.amount))} ${med.unit}${data.person ? ` – ${data.person}` : ''}`);
    refresh();
  } catch (err) {
    $('#take-error').textContent = err.message;
    $('#take-error').hidden = false;
  }
}

async function openJournal() {
  const rows = await api('/medicines/journal?limit=60');
  $('#journal-list').innerHTML = rows.length
    ? rows.map((r) => {
      const w = whenTaken(r.created_at);
      return `<li data-log="${r.id}">
        <span class="li-main"><span class="med-ico" style="width:34px;height:34px;border-radius:11px">${icon('pill')}</span>
          <span><strong>${esc(r.name)}</strong> · ${fmtNum(r.amount)} ${esc(r.unit)}${r.person ? ` – ${esc(r.person)}` : ''}
          <span class="li-sub">${r.note ? `${esc(r.note)} · ` : ''}${r.user_name ? `zapisał(a) ${esc(r.user_name)}` : ''}</span></span></span>
        <span class="j-time">${w.label}${w.ago ? `<br>${w.ago}` : ''}</span>
      </li>`;
    }).join('')
    : emptyLi('Jeszcze nikt nie dostał leku – podania zapisujesz przyciskiem „Podaj”.');
  $('#journal-dialog').showModal();
}

async function disposeExpired() {
  if (!(await ask('Opakowania po terminie znikną z apteczki. Same leki oddaj w aptece do pojemnika na przeterminowane leki.', { title: 'Usunąć przeterminowane opakowania?', ok: 'Usuń z apteczki', danger: true }))) return;
  try {
    const res = await api('/medicines/dispose-expired', { method: 'POST' });
    toast(`Usunięto ${res.packs} ${plural(res.packs, 'opakowanie', 'opakowania', 'opakowań')}`);
    refresh();
  } catch (err) {
    toast(err.message);
  }
}

/** Skan kodu w aptece: znany lek → okno leku, nowy → formularz z kodem. */
async function scanMedicine() {
  const code = await Scanner.scanBarcode();
  if (!code) return;
  const found = (await api(`/medicines?q=${encodeURIComponent(code)}`)).filter((m) => m.barcode === code);
  if (found.length) openMedicine(await api(`/medicines/${found[0].id}`));
  else openMedicine(null, { barcode: code });
}

// ---------- Motyw ----------

function getTheme() {
  try { return localStorage.getItem('hm-theme') || 'system'; } catch { return 'system'; }
}
function setTheme(theme) {
  try { localStorage.setItem('hm-theme', theme); } catch { /* tryb prywatny */ }
  applyTheme();
}
function applyTheme() {
  const t = getTheme();
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('#theme-btn').innerHTML = icon(dark ? 'sun' : 'moon');
  $$('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === t)));
}

// ---------- Zasoby ----------

async function loadItems() {
  const params = new URLSearchParams();
  const q = $('#f-q').value.trim();
  if (q) params.set('q', q);
  if ($('#f-category').value) params.set('category_id', $('#f-category').value);
  if ($('#f-location').value) params.set('location_id', $('#f-location').value);
  if ($('#f-status').value) params.set('status', $('#f-status').value);

  const items = await api(`/items?${params}`);
  $('#items-empty').hidden = items.length > 0;
  $$('#loc-chips [data-loc]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.loc === $('#f-location').value)));
  $('#items-tiles').innerHTML = items.map((i) => {
    const low = i.min_quantity > 0 && i.quantity <= i.min_quantity;
    const expired = i.expires_at && daysUntil(i.expires_at) < 0;
    const soon = i.expires_at && !expired && daysUntil(i.expires_at) <= 7;
    return `
      <article class="tile ${expired ? 'expired' : low ? 'low' : ''}" data-id="${i.id}">
        <button type="button" class="tile-photo" data-act="edit" aria-label="Edytuj ${esc(i.name)}">${thumb(i, 'tile-img')}</button>
        <div class="tile-body">
          <h3 class="tile-name item-name">${esc(i.name)}</h3>
          <div class="tile-meta">
            ${i.location ? `<span>${esc(i.location)}</span>` : ''}
            ${expired ? '<span class="badge danger">po terminie</span>' : soon ? `<span class="badge warn">${daysUntil(i.expires_at) === 0 ? 'ważne dziś' : `ważne ${daysUntil(i.expires_at)} d.`}</span>` : ''}
            ${low ? '<span class="badge warn">mało</span>' : ''}
            ${i.batch_count > 1 ? `<span class="badge">${i.batch_count} partie</span>` : ''}
          </div>
          <div class="tile-qty">
            <button class="btn sm qty-btn" data-act="dec" aria-label="Zużyj 1" ${i.quantity < 1 ? 'disabled' : ''}>−</button>
            <span class="amount">${fmtNum(i.quantity)} ${esc(i.unit)}</span>
            <button class="btn sm qty-btn" data-act="inc" aria-label="Dodaj 1">+</button>
          </div>
        </div>
      </article>`;
  }).join('');
  $('#items-body').innerHTML = items.map((i) => {
    const low = i.min_quantity > 0 && i.quantity <= i.min_quantity;
    const expired = i.expires_at && daysUntil(i.expires_at) < 0;
    return `
      <tr class="${expired ? 'expired' : low ? 'low' : ''}" data-id="${i.id}">
        <td>
          <div class="item-cell">
            ${thumb(i)}
            <div>
              <div class="item-name">${esc(i.name)}</div>
              ${i.notes ? `<div class="item-notes">${esc(i.notes)}</div>` : ''}
            </div>
          </div>
        </td>
        <td class="${i.category ? '' : 'nil'}">${esc(i.category ?? '—')}</td>
        <td class="${i.location ? '' : 'nil'}">${esc(i.location ?? '—')}</td>
        <td class="num">${fmtNum(i.quantity)} ${esc(i.unit)} ${low ? '<span class="badge warn">mało</span>' : ''}</td>
        <td class="${i.expires_at ? '' : 'nil'}">${expiryBadge(i.expires_at)}${i.batch_count > 1 ? ` <span class="badge">${i.batch_count} partie</span>` : ''}</td>
        <td class="actions">
          <button class="btn sm" data-act="dec" title="Zużyj 1">−</button>
          <button class="btn sm" data-act="inc" title="Dodaj 1">+</button>
          <button class="btn sm" data-act="edit">Edytuj</button>
          <button class="btn sm" data-act="waste" title="Wyrzuć 1 (zmarnowane)" ${i.quantity <= 0 ? 'disabled' : ''}>🗑 1</button>
          <button class="btn sm" data-act="history">Historia</button>
          <button class="btn sm danger" data-act="delete">Usuń</button>
        </td>
      </tr>`;
  }).join('');
}

/** Miniatura produktu: zdjęcie z serwera albo pierwsza litera nazwy. */
function thumb(i, cls = 'thumb') {
  if (i.image) return `<img class="${cls}" src="/images/${encodeURIComponent(i.image)}" alt="" loading="lazy">`;
  return `<span class="${cls} thumb-empty" aria-hidden="true">${esc((i.name || '?').trim().charAt(0).toUpperCase())}</span>`;
}

/** Podgląd zdjęcia w formularzu: zapisane zdjęcie, podpowiedź z bazy produktów albo nic. */
function renderFormPhoto(item, previewUrl) {
  const box = $('#item-photo');
  const src = item?.image ? `/images/${encodeURIComponent(item.image)}?v=${Date.now()}` : previewUrl;
  $('#item-photo-img').hidden = !src;
  if (src) $('#item-photo-img').src = src;
  else $('#item-photo-img').removeAttribute('src');
  $('#item-photo-note').textContent = item?.image
    ? 'Zdjęcie z Open Food Facts.'
    : previewUrl
      ? 'Zdjęcie z Open Food Facts zapisze się po dodaniu produktu.'
      : item
        ? (item.barcode ? 'Brak zdjęcia – spróbuj pobrać je z internetu.' : 'Dodaj kod kreskowy, aby pobrać zdjęcie z internetu.')
        : 'Zdjęcie pobierze się samo, jeśli produkt z tym kodem jest w Open Food Facts.';
  $('#item-photo-fetch').hidden = !item?.barcode;
  $('#item-photo-remove').hidden = !item?.image;
  box.dataset.id = item?.id ?? '';
}

async function fetchItemPhoto() {
  const id = $('#item-photo').dataset.id;
  if (!id) return;
  const btn = $('#item-photo-fetch');
  btn.disabled = true;
  $('#item-photo-note').textContent = 'Szukam zdjęcia w Open Food Facts…';
  try {
    const { item, found } = await api(`/items/${id}/image`, { method: 'POST' });
    renderFormPhoto(item);
    if (!found) $('#item-photo-note').textContent = 'Nie znaleziono zdjęcia dla tego kodu w Open Food Facts.';
    refresh();
  } catch (err) {
    $('#item-photo-note').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function removeItemPhoto() {
  const id = $('#item-photo').dataset.id;
  if (!id) return;
  try {
    renderFormPhoto(await api(`/items/${id}/image`, { method: 'DELETE' }));
    refresh();
  } catch (err) {
    toast(err.message);
  }
}

async function fillMissingPhotos() {
  const btn = $('#btn-fill-photos');
  btn.disabled = true;
  $('#fill-photos-status').textContent = 'Pobieram zdjęcia… to może chwilę potrwać.';
  try {
    const { checked, found } = await api('/images/fill', { method: 'POST' });
    $('#fill-photos-status').textContent = checked
      ? `Sprawdzono ${checked} ${checked === 1 ? 'kod' : 'kodów'}, pobrano ${found} ${found === 1 ? 'zdjęcie' : 'zdjęć'}.`
      : 'Wszystkie produkty z kodem kreskowym mają już zdjęcia.';
  } catch (err) {
    $('#fill-photos-status').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Partie ----------

const REASON_ICON = { initial: '📥', purchase: '🛒', used: '✅', wasted: '🗑', correction: '✏️' };
let formItem = null;

function renderBatches(item) {
  formItem = item;
  const box = $('#item-batches');
  const form = $('#item-form');
  const multi = (item?.batches?.length ?? 0) > 1;
  box.hidden = !item;
  $$('[data-single]', form).forEach((el) => { el.hidden = multi; });
  if (!item) return;
  form.elements.quantity.value = item.quantity;
  form.elements.expires_at.value = item.expires_at ?? '';
  $('#batches-sum').textContent = `razem ${fmtNum(item.quantity)} ${item.unit}`;
  $('#batch-list').innerHTML = item.batches.length
    ? item.batches.map((b) => {
      const d = b.expires_at ? daysUntil(b.expires_at) : null;
      const cls = d == null ? '' : d < 0 ? 'danger' : d <= 7 ? 'warn' : '';
      return `<li data-batch="${b.id}" class="${cls}">
        <input type="number" min="0" step="any" value="${b.quantity}" data-bf="quantity" aria-label="Ilość w partii">
        <span class="muted small">${esc(item.unit)}</span>
        <input type="date" value="${b.expires_at ?? ''}" data-bf="expires_at" aria-label="Data ważności partii">
        <span class="batch-acts">
          <button type="button" class="btn sm" data-bact="used" title="Cała partia zużyta">✅</button>
          <button type="button" class="btn sm danger" data-bact="wasted" title="Wyrzuć całą partię">🗑</button>
        </span>
      </li>`;
    }).join('')
    : '<li class="muted small">Brak na stanie – dodaj partię poniżej.</li>';
  $('#batch-add-qty').value = '';
  $('#batch-add-date').value = '';
  $('#batch-add-total').value = '';
}

async function batchApi(path, opts) {
  try {
    const item = await api(path, opts);
    renderBatches(item);
    refresh();
  } catch (err) {
    toast(err.message);
    if (formItem) renderBatches(await api(`/items/${formItem.id}`));
  }
}

function onBatchChange(e) {
  const input = e.target.closest('[data-bf]');
  if (!input) return;
  const id = input.closest('[data-batch]').dataset.batch;
  const value = input.dataset.bf === 'quantity' ? Number(input.value) : (input.value || null);
  batchApi(`/batches/${id}`, { method: 'PATCH', body: { [input.dataset.bf]: value } });
}

async function onBatchClick(e) {
  const btn = e.target.closest('[data-bact]');
  if (!btn) return;
  const id = btn.closest('[data-batch]').dataset.batch;
  const reason = btn.dataset.bact;
  if (reason === 'wasted' && !(await ask('Partia trafi do statystyki zmarnowanych.', { title: 'Wyrzucić całą partię?', ok: 'Wyrzuć', danger: true }))) return;
  batchApi(`/batches/${id}?reason=${reason}`, { method: 'DELETE' });
}

function addBatch() {
  if (!formItem) return;
  const qty = Number($('#batch-add-qty').value);
  if (!(qty > 0)) return toast('Podaj ilość nowej partii');
  const total = $('#batch-add-total').value;
  batchApi(`/items/${formItem.id}/adjust`, {
    method: 'POST',
    body: { delta: qty, expires_at: $('#batch-add-date').value || null, ...(total ? { total: Number(total) } : {}) },
  });
}

function openItemDialog(item = null, prefill = {}) {
  const form = $('#item-form');
  form.reset();
  $('#item-error').hidden = true;
  $('#item-dialog-title').textContent = item ? 'Edytuj zasób' : 'Nowy zasób';
  const { image_url: _preview, ...prefillValues } = prefill;
  const values = item ?? { quantity: 1, unit: 'szt.', min_quantity: 0, ...prefillValues };
  for (const el of form.elements) {
    if (el.name && el.name in values) el.value = values[el.name] ?? '';
  }
  form.elements.id.value = item?.id ?? '';
  renderFormPhoto(item, item ? null : prefill.image_url);
  renderBatches(item);
  $('#item-delete').hidden = !item;
  $('#item-dialog').showModal();
  form.elements.name.focus();
}

async function deleteFromForm() {
  const id = $('#item-form').elements.id.value;
  if (!id) return;
  const name = $('#item-form').elements.name.value;
  if (!(await ask('Produkt zniknie razem z historią.', { title: `Usunąć „${name}”?`, ok: 'Usuń', danger: true }))) return;
  try {
    await api(`/items/${id}`, { method: 'DELETE' });
    $('#item-dialog').close();
    toast('Usunięto zasób');
    loadDicts().then(refresh);
  } catch (err) {
    toast(err.message);
  }
}

async function saveItem(e) {
  e.preventDefault();
  const form = e.target;
  const fd = Object.fromEntries(new FormData(form));
  const { id, ...data } = fd;
  data.price = data.price === '' ? null : data.price;
  data.expires_at = data.expires_at || null;
  data.category_id = data.category_id || null;
  data.location_id = data.location_id || null;
  // Przy kilku partiach ilość i daty zmienia się w partiach, nie w polach formularza.
  if (id && (formItem?.batches?.length ?? 0) > 1) {
    delete data.quantity;
    delete data.expires_at;
  }
  try {
    const saved = await api(id ? `/items/${id}` : '/items', { method: id ? 'PUT' : 'POST', body: data });
    $('#item-dialog').close();
    toast(id ? 'Zapisano zmiany' : 'Dodano zasób');
    refresh();
    // Zdjęcie z internetu pobiera się w tle – odśwież listę, gdy już będzie.
    if (saved.barcode && !saved.image) setTimeout(refresh, 2500);
  } catch (err) {
    $('#item-error').textContent = err.message;
    $('#item-error').hidden = false;
  }
}

async function onItemAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const act = btn.dataset.act;
  try {
    if (act === 'inc' || act === 'dec' || act === 'waste') {
      const updated = await api(`/items/${id}/adjust`, {
        method: 'POST',
        body: act === 'inc' ? { delta: 1 } : { delta: -1, reason: act === 'waste' ? 'wasted' : 'used' },
      });
      if (act === 'waste') toast(`🗑 ${updated.name}: wyrzucono 1 ${updated.unit}`);
      refresh();
    } else if (act === 'edit') {
      openItemDialog(await api(`/items/${id}`));
    } else if (act === 'history') {
      const [item, hist] = await Promise.all([api(`/items/${id}`), api(`/items/${id}/history`)]);
      $('#history-title').textContent = `Historia: ${item.name}`;
      $('#history-list').innerHTML = hist.length
        ? hist.map((h) => `<li>
            <span>
              <span>${REASON_ICON[h.reason] ?? ''} ${esc(h.note)}${h.amount != null ? ` · ${fmtMoney(h.amount)}` : ''}</span><br>
              <span class="muted small">${fmtTime(h.created_at)}${h.user_name ? ` · ${esc(h.user_name)}` : ''}${h.expires_at ? ` · partia ${fmtDate(h.expires_at)}` : ''}</span>
            </span>
            <span class="${h.delta > 0 ? 'delta-pos' : 'delta-neg'}">${h.delta > 0 ? '+' : ''}${fmtNum(h.delta)} ${esc(item.unit)}</span>
          </li>`).join('')
        : emptyLi('Brak zmian');
      $('#history-dialog').showModal();
    } else if (act === 'delete') {
      const name = btn.closest('[data-id]').querySelector('.item-name').textContent;
      if (!(await ask('Produkt zniknie razem z historią.', { title: `Usunąć „${name}”?`, ok: 'Usuń', danger: true }))) return;
      await api(`/items/${id}`, { method: 'DELETE' });
      toast('Usunięto zasób');
      refresh();
    }
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Skanowanie etykiet ----------

/** Skanuje kod: znany produkt → szybkie akcje, nowy → formularz z podpowiedzią. */
async function scanFlow() {
  const code = await Scanner.scanBarcode();
  if (!code) return;
  try {
    const res = await api(`/barcode/${encodeURIComponent(code)}`);
    if (res.items.length) {
      showScanResult(res.barcode, res.items);
    } else {
      openNewFromScan(res.barcode, res.product);
    }
  } catch (err) {
    toast(err.message);
  }
}

function openNewFromScan(barcode, product) {
  const prefill = { barcode };
  if (product) {
    prefill.name = product.name;
    const cat = state.categories.find((c) => c.name === product.category_hint);
    if (cat) prefill.category_id = cat.id;
    if (product.quantity) prefill.notes = `Opakowanie: ${product.quantity}`;
    if (product.image_url) prefill.image_url = product.image_url;
    toast(`Rozpoznano: ${product.name}`);
  } else {
    toast('Nowy kod – uzupełnij nazwę produktu');
  }
  openItemDialog(null, prefill);
}

function showScanResult(barcode, items) {
  const dialog = $('#scan-result-dialog');
  $('#scan-result-title').textContent = items.length === 1 ? items[0].name : `Znaleziono ${items.length} pozycje`;
  $('#scan-result-code').textContent = `Kod: ${barcode}`;
  const render = (list) => {
    $('#scan-result-list').innerHTML = list.map((i) => `
      <li data-id="${i.id}">
        <span class="item-cell">${thumb(i)}<span><strong>${esc(i.name)}</strong><br>
          <span class="muted">${esc(i.location ?? 'bez lokalizacji')} · ${fmtNum(i.quantity)} ${esc(i.unit)}</span></span></span>
        <span class="row">
          <button class="btn sm" data-scan-act="dec" title="Zużyj 1" ${i.quantity < 1 ? 'disabled' : ''}>−</button>
          <button class="btn sm" data-scan-act="inc" title="Dodaj 1">+</button>
          <button class="btn sm" data-scan-act="edit">Edytuj</button>
        </span>
      </li>`).join('');
  };
  render(items);

  $('#scan-result-list').onclick = async (e) => {
    const btn = e.target.closest('button[data-scan-act]');
    if (!btn) return;
    const id = Number(btn.closest('li').dataset.id);
    try {
      if (btn.dataset.scanAct === 'edit') {
        dialog.close();
        openItemDialog(await api(`/items/${id}`));
        return;
      }
      const updated = await api(`/items/${id}/adjust`, {
        method: 'POST',
        body: { delta: btn.dataset.scanAct === 'inc' ? 1 : -1, note: 'Skan' },
      });
      items = items.map((i) => (i.id === id ? updated : i));
      render(items);
      toast(`${updated.name}: ${fmtNum(updated.quantity)} ${updated.unit}`);
      refresh();
    } catch (err) {
      toast(err.message);
    }
  };
  $('#scan-result-new').onclick = () => {
    dialog.close();
    openItemDialog(null, { barcode, name: items[0]?.name ?? '', category_id: items[0]?.category_id ?? '' });
  };
  dialog.showModal();
}

async function scanBarcodeIntoForm() {
  const code = await Scanner.scanBarcode();
  if (!code) return;
  const form = $('#item-form');
  form.elements.barcode.value = code;
  if (form.elements.name.value.trim()) return;
  try {
    const res = await api(`/barcode/${encodeURIComponent(code)}`);
    const name = res.product?.name ?? res.items[0]?.name;
    if (name) {
      form.elements.name.value = name;
      toast(`Rozpoznano: ${name}`);
    }
  } catch { /* podpowiedź nazwy jest opcjonalna */ }
}

async function scanExpiryIntoForm() {
  const date = await Scanner.scanExpiry((text) => api('/expiry/parse', { method: 'POST', body: { text } }));
  if (date) $('#item-form').elements.expires_at.value = date;
}

// ---------- Lista zakupów ----------

let shoppingCache = [];
async function loadShopping() {
  shoppingCache = await api('/shopping-list');
  $('#shopping-list').innerHTML = shoppingCache.length
    ? shoppingCache.map((i) => `
        <li data-id="${i.id}">
          <span><strong>${esc(i.name)}</strong> <span class="muted">· ${esc(i.location ?? 'bez lokalizacji')} · jest ${fmtNum(i.quantity)} ${esc(i.unit)}</span></span>
          <span class="row">
            <span>kup ${fmtNum(i.to_buy)} ${esc(i.unit)}</span>
            <button class="btn sm primary" data-buy="${i.to_buy}">Kupione ✓</button>
          </span>
        </li>`).join('')
    : emptyLi('Lista zakupów jest pusta 🎉');
}

async function onShoppingAction(e) {
  const btn = e.target.closest('button[data-buy]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  try {
    await api(`/items/${id}/adjust`, { method: 'POST', body: { delta: Number(btn.dataset.buy), note: 'Zakup' } });
    toast('Uzupełniono stan');
    refresh();
  } catch (err) {
    toast(err.message);
  }
}

async function copyShopping() {
  if (!shoppingCache.length) return toast('Lista jest pusta');
  const text = shoppingCache.map((i) => `- ${i.name}: ${fmtNum(i.to_buy)} ${i.unit}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Skopiowano do schowka');
  } catch {
    await ask('Zaznacz i skopiuj tekst poniżej.', { title: 'Lista zakupów', input: text, ok: 'Zamknij' });
  }
}

// ---------- Ustawienia ----------

async function loadSettings() {
  await Promise.all([loadDicts(), loadUsers(), loadIntegrations()]);
  const render = (kind, items) => {
    $(`#dict-${kind}`).innerHTML = items.length
      ? items.map((d) => `
          <li>
            <span>${esc(d.name)} <span class="muted">(${d.item_count})</span></span>
            <button class="btn sm danger" data-del-dict="${kind}" data-id="${d.id}" data-name="${esc(d.name)}">Usuń</button>
          </li>`).join('')
      : emptyLi('Brak pozycji');
  };
  render('categories', state.categories);
  render('locations', state.locations);
}

async function onDictSubmit(e) {
  e.preventDefault();
  const form = e.target;
  try {
    await api(`/${form.dataset.dict}`, { method: 'POST', body: { name: form.elements.name.value } });
    form.reset();
    toast('Dodano');
    loadSettings();
  } catch (err) {
    toast(err.message);
  }
}

async function onDictDelete(e) {
  const btn = e.target.closest('button[data-del-dict]');
  if (!btn) return;
  if (!(await ask('Powiązane zasoby pozostaną bez przypisania.', { title: `Usunąć „${btn.dataset.name}”?`, ok: 'Usuń', danger: true }))) return;
  try {
    await api(`/${btn.dataset.delDict}/${btn.dataset.id}`, { method: 'DELETE' });
    toast('Usunięto');
    loadSettings();
  } catch (err) {
    toast(err.message);
  }
}

async function exportData() {
  const data = await api('/export');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `zasoby-domowe-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importData(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!(await ask('Zapasy i apteczka zostaną zastąpione danymi z pliku.', { title: 'Zaimportować kopię?', ok: 'Importuj', danger: true }))) return;
  try {
    const data = JSON.parse(await file.text());
    const res = await api('/import', { method: 'POST', body: data });
    toast(`Zaimportowano ${res.items} zasobów${res.medicines != null ? ` i ${res.medicines} leków` : ''}`);
    loadSettings();
  } catch (err) {
    toast(`Import nieudany: ${err.message}`);
  }
}

// ---------- Szybkie zużycie skanerem ----------

function openQuick() {
  $('#quick-log').innerHTML = '';
  $('#quick-dialog').showModal();
}

/** Skanuje kolejne kody, aż użytkownik zamknie skaner; każdy kod to −1 szt. */
async function quickScanLoop() {
  const dialog = $('#quick-dialog');
  for (;;) {
    const code = await Scanner.scanBarcode();
    if (!code || !dialog.open) break;
    const reason = $('input[name=quick-reason]:checked').value;
    try {
      const res = await api('/consume', { method: 'POST', body: { barcode: code, reason } });
      const li = document.createElement('li');
      li.dataset.history = res.history_ids.join(',');
      li.innerHTML = `
        <span class="item-cell">${thumb(res.item)}<span><strong>${esc(res.item.name)}</strong><br>
          <span class="muted small">${reason === 'wasted' ? '🗑 wyrzucono' : '✅ zużyto'} ${fmtNum(res.taken)} ${esc(res.item.unit)} · zostało ${fmtNum(res.item.quantity)}</span></span></span>
        <button type="button" class="btn sm" data-undo>Cofnij</button>`;
      $('#quick-log').prepend(li);
      toast(`${res.item.name}: zostało ${fmtNum(res.item.quantity)} ${res.item.unit}`);
    } catch (err) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="form-error">${esc(code)}: ${esc(err.message)}</span>`;
      $('#quick-log').prepend(li);
      toast(err.message);
    }
    // Krótka pauza, żeby ten sam kod nie został odczytany od razu drugi raz.
    await new Promise((r) => setTimeout(r, 700));
  }
  refresh();
}

async function onQuickUndo(e) {
  const btn = e.target.closest('[data-undo]');
  if (!btn) return;
  const li = btn.closest('li');
  try {
    const ids = li.dataset.history.split(',').reverse();
    let item;
    for (const id of ids) item = await api(`/history/${id}/undo`, { method: 'POST' });
    li.classList.add('undone');
    btn.replaceWith(Object.assign(document.createElement('span'), { className: 'muted small', textContent: 'cofnięto' }));
    toast(`Cofnięto: ${item.name} (${fmtNum(item.quantity)} ${item.unit})`);
    refresh();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Paragony ----------

let receiptItems = [];

async function openReceipt() {
  $('#receipt-step1').hidden = false;
  $('#receipt-step1-actions').hidden = false;
  $('#receipt-form').hidden = true;
  $('#receipt-paste').hidden = true;
  $('#receipt-status').textContent = '';
  $('#receipt-text').value = '';
  $('#receipt-dialog').showModal();
  receiptItems = await api('/items').catch(() => []);
}

async function receiptFromPhoto(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const status = $('#receipt-status');
  try {
    const text = await Scanner.recognizeReceipt(file, (msg) => { status.textContent = msg; });
    await parseReceiptText(text);
  } catch (err) {
    status.textContent = `Nie udało się odczytać zdjęcia: ${err.message ?? err}`;
  }
}

async function parseReceiptText(text) {
  const status = $('#receipt-status');
  if (!text.trim()) {
    status.textContent = 'Nie rozpoznano tekstu – zrób wyraźniejsze zdjęcie.';
    return;
  }
  status.textContent = 'Dopasowuję pozycje do produktów…';
  const parsed = await api('/receipts/parse', { method: 'POST', body: { text } });
  if (!parsed.lines.length) {
    status.textContent = 'Nie znaleziono pozycji na paragonie. Spróbuj zdjęcia z bliska, płasko i przy lepszym świetle – albo dodaj pozycje ręcznie.';
  }
  showReceiptForm(parsed, text);
}

function showReceiptForm(parsed, text) {
  $('#receipt-step1').hidden = true;
  $('#receipt-step1-actions').hidden = true;
  const form = $('#receipt-form');
  form.hidden = false;
  form.elements.shop.value = parsed.shop ?? '';
  form.elements.date.value = parsed.date ?? todayStr();
  form.elements.total.value = parsed.total ?? '';
  $('#receipt-raw').textContent = text;
  $('#receipt-error').hidden = true;
  $('#receipt-lines').innerHTML = '';
  for (const line of parsed.lines) addReceiptLine(line);
  if (!parsed.lines.length) addReceiptLine({});
  updateReceiptSummary();
}

function receiptTargetOptions(match) {
  const selected = match?.item_id ? String(match.item_id) : 'new';
  return `<option value="skip">— pomiń —</option>
    <option value="new" ${selected === 'new' ? 'selected' : ''}>➕ Nowy produkt</option>
    ${receiptItems.map((i) => `<option value="${i.id}" ${String(i.id) === selected ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}`;
}

function addReceiptLine(line = {}) {
  const div = document.createElement('div');
  div.className = 'rline';
  const match = line.match;
  div.innerHTML = `
    <input class="rl-name" value="${esc(line.name ?? '')}" placeholder="Nazwa z paragonu" aria-label="Nazwa">
    <input class="rl-qty" type="number" step="any" min="0" value="${line.quantity ?? 1}" aria-label="Ilość">
    <input class="rl-total" type="number" step="0.01" min="0" value="${line.total ?? ''}" placeholder="zł" aria-label="Kwota">
    <select class="rl-target" aria-label="Produkt">${receiptTargetOptions(match)}</select>
    <input class="rl-date" type="date" aria-label="Data ważności (opcjonalnie)" title="Data ważności (opcjonalnie)">
    <button type="button" class="btn sm rl-del" title="Usuń pozycję" aria-label="Usuń pozycję">✕</button>
    <span class="rl-hint muted small">${match ? (match.remembered ? '✓ zapamiętane dopasowanie' : `podobne: ${esc(match.name)}`) : 'brak dopasowania – zostanie dodany jako nowy produkt'}</span>`;
  $('#receipt-lines').append(div);
}

function updateReceiptSummary() {
  const rows = $$('#receipt-lines .rline');
  const active = rows.filter((r) => $('.rl-target', r).value !== 'skip');
  const sum = active.reduce((s, r) => s + (Number($('.rl-total', r).value) || 0), 0);
  const total = Number($('#receipt-form').elements.total.value) || null;
  const created = active.filter((r) => $('.rl-target', r).value === 'new').length;
  $('#receipt-summary').textContent =
    `${active.length} poz. do zapisu (${created} nowe produkty) · suma pozycji ${fmtMoney(sum)}` +
    (total && Math.abs(total - sum) > 0.01 ? ` · ⚠️ różni się od sumy paragonu (${fmtMoney(total)})` : '');
}

async function saveReceipt(e) {
  e.preventDefault();
  const form = e.target;
  const lines = $$('#receipt-lines .rline')
    .filter((r) => $('.rl-target', r).value !== 'skip')
    .map((r) => {
      const target = $('.rl-target', r).value;
      const name = $('.rl-name', r).value.trim();
      const total = $('.rl-total', r).value;
      return {
        name,
        quantity: Number($('.rl-qty', r).value) || 1,
        total: total === '' ? null : Number(total),
        expires_at: $('.rl-date', r).value || null,
        ...(target === 'new'
          ? { create: { name: name || 'Produkt z paragonu', category_id: state.categories.find((c) => c.name === 'Żywność')?.id ?? null } }
          : { item_id: Number(target) }),
      };
    });
  try {
    const res = await api('/receipts', {
      method: 'POST',
      body: { shop: form.elements.shop.value, date: form.elements.date.value, total: form.elements.total.value || null, lines },
    });
    $('#receipt-dialog').close();
    toast(`Zapisano paragon: ${res.lines} poz.${res.created ? `, ${res.created} nowe produkty` : ''}`);
    loadDicts().then(refresh);
  } catch (err) {
    $('#receipt-error').textContent = err.message;
    $('#receipt-error').hidden = false;
  }
}

async function showReceiptDetails(id) {
  const r = await api(`/receipts/${id}`);
  $('#receipt-view-title').textContent = `${r.shop || 'Paragon'} · ${fmtDate(r.purchased_on)}`;
  $('#receipt-view-lines').innerHTML = r.lines.map((l) => `
    <li><span>${esc(l.name)} <span class="muted">× ${fmtNum(l.quantity)} ${esc(l.unit)}</span></span><span>${l.amount != null ? fmtMoney(l.amount) : '—'}</span></li>`).join('') +
    (r.total != null ? `<li><strong>Suma</strong><strong>${fmtMoney(r.total)}</strong></li>` : '');
  $('#receipt-view-dialog').showModal();
}

// ---------- Wydatki ----------

const MONTHS = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
const monthLabel = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]}${m === 1 ? ` ${String(y).slice(2)}` : ''}`;
};

/** Wykres słupkowy jednej serii (jedna oś, wartości w podpowiedzi i w tabeli). */
function columnChart(el, rows, key, label) {
  const max = Math.max(...rows.map((r) => r[key]), 0);
  const last = rows.at(-1);
  el.setAttribute('aria-label', `${label}: ${rows.map((r) => `${monthLabel(r.month)} ${fmtMoney(r[key])}`).join(', ')}`);
  if (!max) {
    el.innerHTML = '<p class="muted chart-empty">Brak danych w tym okresie.</p>';
    return;
  }
  el.innerHTML = `
    <div class="col-head"><span class="col-now">${fmtMoney(last[key])}</span><span class="muted small">w tym miesiącu</span></div>
    <div class="cols" style="--n:${rows.length}">
      ${rows.map((r) => `
        <div class="col" tabindex="0" data-tip="${monthLabel(r.month)}: ${fmtMoney(r[key])}">
          <div class="col-bar" style="height:${(r[key] / max) * 100}%"></div>
        </div>`).join('')}
    </div>
    <div class="cols-axis" style="--n:${rows.length}">${rows.map((r) => `<span>${monthLabel(r.month)}</span>`).join('')}</div>`;
}

async function loadExpenses() {
  $$('[data-months]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.months) === state.months)));
  const rep = await api(`/reports?months=${state.months}`);
  const avg = rep.totals.spent / rep.months;
  $('#exp-stats').innerHTML = [
    [`Wydatki (${rep.months} mies.)`, fmtMoney(rep.totals.spent), 'c-primary', 'receipt'],
    ['Średnio miesięcznie', fmtMoney(avg), 'c-sky', 'chart'],
    ['Zmarnowane', fmtMoney(rep.totals.wasted), rep.totals.wasted ? 'warn' : 'c-ok', 'trash'],
    ['Wyrzucone razy', rep.totals.wasted_count, rep.totals.wasted_count ? 'warn' : 'c-ok', 'alert'],
    ['Zakup sprzętów', fmtMoney(rep.totals.equipment), '', 'wrench'],
  ].map(([l, v, c, ico]) => `<div class="stat ${c}"><span class="s-ico">${icon(ico)}</span><span class="label">${l}</span><span class="value">${v}</span></div>`).join('');

  columnChart($('#chart-spent'), rep.monthly, 'spent', 'Wydatki na zakupy');
  columnChart($('#chart-wasted'), rep.monthly, 'wasted', 'Zmarnowane');
  $('#exp-table').innerHTML = `<thead><tr><th>Miesiąc</th><th class="num">Wydatki</th><th class="num">Zmarnowane</th><th class="num">Wyrzucone razy</th><th class="num">Sprzęty</th></tr></thead>
    <tbody>${rep.monthly.map((r) => `<tr><td>${r.month}</td><td class="num">${fmtMoney(r.spent)}</td><td class="num">${fmtMoney(r.wasted)}</td><td class="num">${r.wasted_count}</td><td class="num">${fmtMoney(r.equipment)}</td></tr>`).join('')}</tbody>`;

  const maxCat = Math.max(1, ...rep.by_category.map((c) => c.amount));
  $('#exp-categories').innerHTML = rep.by_category.length
    ? rep.by_category.map((c) => `
        <div class="bar-row">
          <span>${esc(c.name)}</span>
          <div class="bar-track"><div class="bar" style="width:${(c.amount / maxCat) * 100}%"></div></div>
          <span class="count money">${fmtMoney(c.amount)}</span>
        </div>`).join('')
    : '<p class="muted">Zeskanuj paragon albo podawaj cenę przy zakupach, a tu zobaczysz, na co idą pieniądze.</p>';

  $('#exp-wasted').innerHTML = rep.wasted_items.length
    ? rep.wasted_items.map((w) => `<li><span>${esc(w.name)} <span class="muted small">· ${w.times}× · ${fmtNum(w.quantity)} ${esc(w.unit)}</span></span><span>${w.amount ? fmtMoney(w.amount) : '—'}</span></li>`).join('')
    : emptyLi('Nic nie zmarnowano 🎉');

  $('#exp-receipts').innerHTML = rep.receipts.length
    ? rep.receipts.map((r) => `<li class="clickable" data-receipt="${r.id}"><span>${esc(r.shop || 'Paragon')} <span class="muted small">· ${fmtDate(r.purchased_on)} · ${r.line_count} poz.${r.user_name ? ` · ${esc(r.user_name)}` : ''}</span></span><span>${r.total != null ? fmtMoney(r.total) : ''}</span></li>`).join('')
    : emptyLi('Brak zeskanowanych paragonów');

  $('#exp-users').innerHTML = rep.by_user.length
    ? rep.by_user.map((u) => `<li><span>${esc(u.name)}</span><span class="muted small">kupił(a) za ${fmtMoney(u.spent)} · zużył(a) ${u.used_count}×</span></li>`).join('')
    : emptyLi('Brak aktywności');
}

// ---------- Sprzęty i dokumenty ----------

const DOC_ICON = { receipt: '🧾', warranty: '📜', manual: '📘', invoice: '🧾', photo: '📷', other: '📎' };
const DOC_LABEL = { receipt: 'Paragon', warranty: 'Gwarancja', manual: 'Instrukcja', invoice: 'Faktura', photo: 'Zdjęcie', other: 'Dokument' };

function warrantyBadge(e) {
  if (!e.warranty_until) return '';
  const d = daysUntil(e.warranty_until);
  if (d < 0) return '<span class="badge">gwarancja wygasła</span>';
  if (d <= 30) return `<span class="badge warn">gwarancja: ${d === 0 ? 'dziś' : `${d} d.`}</span>`;
  return `<span class="badge ok">gwarancja do ${fmtDate(e.warranty_until)}</span>`;
}

function serviceBadge(e) {
  if (!e.next_service_at) return '';
  const d = daysUntil(e.next_service_at);
  if (d < 0) return '<span class="badge danger">przegląd zaległy</span>';
  if (d <= 14) return `<span class="badge warn">przegląd za ${d} d.</span>`;
  return `<span class="badge">przegląd ${fmtDate(e.next_service_at)}</span>`;
}

function equipmentAlerts(list) {
  const out = [];
  for (const e of list) {
    if (e.next_service_at && daysUntil(e.next_service_at) <= 14) out.push({ id: e.id, name: e.name, badge: serviceBadge(e), sort: e.next_service_at });
    if (e.warranty_until && daysUntil(e.warranty_until) >= 0 && daysUntil(e.warranty_until) <= 30) out.push({ id: e.id, name: e.name, badge: warrantyBadge(e), sort: e.warranty_until });
  }
  return out.sort((a, b) => a.sort.localeCompare(b.sort));
}

const fmtSize = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);
const docUrl = (id, download = false) => `/api/documents/${id}/file${download ? '?download=1' : ''}`;

async function loadEquipment() {
  const q = $('#eq-q').value.trim();
  const list = await api(`/equipment${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  $('#eq-empty').hidden = list.length > 0;
  $('#eq-list').innerHTML = list.map((e) => `
    <article class="eq-card" data-eq-id="${e.id}" tabindex="0" role="button" aria-label="${esc(e.name)}">
      ${e.photo_document_id
        ? `<img class="eq-photo" src="${docUrl(e.photo_document_id)}" alt="" loading="lazy">`
        : `<span class="eq-photo thumb-empty" aria-hidden="true">${esc(e.name.charAt(0).toUpperCase())}</span>`}
      <div class="eq-body">
        <h3>${esc(e.name)}</h3>
        <div class="muted small">${esc([e.brand, e.model].filter(Boolean).join(' ') || '—')}${e.location ? ` · ${esc(e.location)}` : ''}</div>
        <div class="tile-meta">${warrantyBadge(e)} ${serviceBadge(e)} ${e.document_count ? `<span class="badge">📎 ${e.document_count}</span>` : ''}</div>
      </div>
    </article>`).join('');
}

function fillEqLocations() {
  $('#eq-form [name=location_id]').innerHTML = '<option value="">— brak —</option>' +
    state.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
}

async function openEquipment(id = null) {
  const form = $('#eq-form');
  form.reset();
  fillEqLocations();
  $('#eq-error').hidden = true;
  $('#doc-status').textContent = 'PDF, zdjęcia lub tekst, do 25 MB.';
  const e = id ? await api(`/equipment/${id}`) : null;
  renderEquipmentForm(e);
  $('#eq-dialog').showModal();
  if (!e) form.elements.name.focus();
}

function renderEquipmentForm(e) {
  const form = $('#eq-form');
  $('#eq-dialog-title').textContent = e ? e.name : 'Nowy sprzęt';
  for (const el of form.elements) {
    if (el.name && e && el.name in e) el.value = e[el.name] ?? '';
  }
  form.elements.id.value = e?.id ?? '';
  $('#eq-delete').hidden = !e;
  $('#eq-docs').hidden = !e;
  $('#eq-docs-hint').hidden = !!e;
  if (!e) return;
  $('#eq-doc-list').innerHTML = e.documents.length
    ? e.documents.map((d) => `
      <li data-doc="${d.id}">
        <a class="doc-link" href="${docUrl(d.id)}" target="_blank" rel="noopener">
          ${d.kind === 'photo' && d.mime.startsWith('image/') && !d.mime.includes('hei')
            ? `<img class="thumb" src="${docUrl(d.id)}" alt="" loading="lazy">`
            : `<span class="thumb thumb-empty doc-ico" aria-hidden="true">${DOC_ICON[d.kind] ?? '📎'}</span>`}
          <span><strong>${esc(d.title || DOC_LABEL[d.kind] || 'Dokument')}</strong><br>
            <span class="muted small">${esc(d.original_name || '')} · ${fmtSize(d.size)}${d.user_name ? ` · ${esc(d.user_name)}` : ''}</span></span>
        </a>
        <span class="row nowrap">
          <a class="btn sm" href="${docUrl(d.id, true)}" title="Pobierz" aria-label="Pobierz">⬇</a>
          <button type="button" class="btn sm danger" data-doc-del title="Usuń" aria-label="Usuń dokument">✕</button>
        </span>
      </li>`).join('')
    : '<li class="muted small">Brak dokumentów – dodaj paragon, kartę gwarancyjną albo instrukcję.</li>';
}

async function saveEquipment(e) {
  e.preventDefault();
  const form = e.target;
  const { id, ...data } = Object.fromEntries(new FormData(form));
  for (const k of ['location_id', 'purchase_date', 'warranty_until', 'next_service_at', 'price']) data[k] = data[k] || null;
  try {
    const saved = await api(id ? `/equipment/${id}` : '/equipment', { method: id ? 'PUT' : 'POST', body: data });
    toast(id ? 'Zapisano zmiany' : 'Dodano sprzęt – możesz teraz dodać dokumenty');
    renderEquipmentForm(saved);
    refresh();
    if (id) $('#eq-dialog').close();
  } catch (err) {
    $('#eq-error').textContent = err.message;
    $('#eq-error').hidden = false;
  }
}

async function uploadDocs(e) {
  const files = [...e.target.files];
  e.target.value = '';
  const id = $('#eq-form').elements.id.value;
  if (!files.length || !id) return;
  const status = $('#doc-status');
  const kind = $('#doc-kind').value;
  let ok = 0;
  for (const [n, file] of files.entries()) {
    status.textContent = `Wysyłanie ${n + 1}/${files.length}: ${file.name}…`;
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error('plik większy niż 25 MB');
      const params = new URLSearchParams({ kind, name: file.name });
      await api(`/equipment/${id}/documents?${params}`, {
        method: 'POST', raw: file, headers: { 'Content-Type': file.type || 'application/octet-stream' },
      });
      ok += 1;
    } catch (err) {
      toast(`${file.name}: ${err.message}`);
    }
  }
  status.textContent = `Dodano ${ok} z ${files.length}.`;
  renderEquipmentForm(await api(`/equipment/${id}`));
  refresh();
}

async function onDocClick(e) {
  const btn = e.target.closest('[data-doc-del]');
  if (!btn) return;
  if (!(await ask('Plik zostanie usunięty z serwera.', { title: 'Usunąć dokument?', ok: 'Usuń', danger: true }))) return;
  const id = btn.closest('[data-doc]').dataset.doc;
  try {
    await api(`/documents/${id}`, { method: 'DELETE' });
    renderEquipmentForm(await api(`/equipment/${$('#eq-form').elements.id.value}`));
    refresh();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteEquipment() {
  const form = $('#eq-form');
  if (!(await ask('Sprzęt zostanie usunięty razem ze wszystkimi dokumentami.', { title: `Usunąć „${form.elements.name.value}”?`, ok: 'Usuń', danger: true }))) return;
  try {
    await api(`/equipment/${form.elements.id.value}`, { method: 'DELETE' });
    $('#eq-dialog').close();
    toast('Usunięto sprzęt');
    refresh();
  } catch (err) {
    toast(err.message);
  }
}

function setWarrantyYears(e) {
  const years = Number(e.target.value);
  e.target.value = '';
  if (!years) return;
  const form = $('#eq-form');
  const base = form.elements.purchase_date.value || todayStr();
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  form.elements.warranty_until.value = d.toISOString().slice(0, 10);
}

// ---------- Konta ----------

let authMode = 'login';

function showAuth(setup) {
  state.user = null;
  authMode = setup ? 'setup' : 'login';
  document.body.classList.add('locked');
  $('#auth-screen').hidden = false;
  $('#auth-title').textContent = setup ? 'Witaj! Utwórz konto' : 'Zaloguj się';
  $('#auth-intro').textContent = setup
    ? 'To pierwsze uruchomienie. Utwórz konto administratora – potem dodasz domowników w zakładce „Więcej”.'
    : 'Manager zasobów domowych';
  $$('[data-setup]').forEach((el) => { el.hidden = !setup; });
  const form = $('#auth-form');
  form.elements.name.required = setup;
  form.elements.password2.required = setup;
  form.elements.password.autocomplete = setup ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = setup ? 'Utwórz konto' : 'Zaloguj';
  $('#auth-error').hidden = true;
  (setup ? form.elements.name : form.elements.login).focus();
}

function setUser(user) {
  state.user = user;
  document.body.classList.remove('locked');
  document.body.classList.toggle('is-admin', user.role === 'admin');
  $('#auth-screen').hidden = true;
  const initials = user.name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  $('#user-chip').hidden = false;
  $('#user-chip').innerHTML = `<span class="avatar" aria-hidden="true">${esc(initials)}</span>
    <span class="uc-text"><strong>${esc(user.name)}</strong><span>${user.role === 'admin' ? 'Administrator' : 'Domownik'}</span></span>${icon('chevron')}`;
  $('#avatar-btn').hidden = false;
  $('#avatar-btn').textContent = initials;
}

async function submitAuth(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  const err = $('#auth-error');
  err.hidden = true;
  if (authMode === 'setup' && data.password !== data.password2) {
    err.textContent = 'Hasła się różnią';
    err.hidden = false;
    return;
  }
  try {
    const res = await api(authMode === 'setup' ? '/auth/setup' : '/auth/login', {
      method: 'POST', body: { name: data.name, login: data.login, password: data.password },
    });
    form.reset();
    tokenStore.set(res.token);
    setUser(res.user);
    await startApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
}

async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  tokenStore.clear();
  // Usuń dane zapamiętane do pracy offline – następna osoba na tym urządzeniu ich nie zobaczy.
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('api-')).map((k) => caches.delete(k)));
  }
  showAuth(false);
}

async function loadUsers() {
  state.users = await api('/users');
  const me = state.user;
  $('#me-info').innerHTML = `<strong>${esc(me.name)}</strong> <span class="muted">(${esc(me.login)} · ${me.role === 'admin' ? 'administrator' : 'domownik'})</span>`;
  $('#users-list').innerHTML = state.users.map((u) => `
    <li data-user="${u.id}">
      <span>${esc(u.name)} <span class="muted small">· ${esc(u.login)}${u.role === 'admin' ? ' · administrator' : ''}${u.id === me.id ? ' · to Ty' : ''}</span></span>
      ${isAdmin() && u.id !== me.id ? `<span class="row nowrap">
        <button type="button" class="btn sm" data-user-act="password">Nowe hasło</button>
        <button type="button" class="btn sm" data-user-act="role">${u.role === 'admin' ? 'Zwykły' : 'Admin'}</button>
        <button type="button" class="btn sm danger" data-user-act="delete">Usuń</button>
      </span>` : ''}
    </li>`).join('');
}

async function onUserAction(e) {
  const btn = e.target.closest('[data-user-act]');
  if (!btn) return;
  const id = btn.closest('[data-user]').dataset.user;
  const u = state.users.find((x) => String(x.id) === id);
  try {
    if (btn.dataset.userAct === 'password') {
      const password = await ask('Minimum 8 znaków. Przekaż je domownikowi.', { title: `Nowe hasło dla ${u.name}`, input: '', inputType: 'password', ok: 'Ustaw hasło' });
      if (!password) return;
      await api(`/users/${id}`, { method: 'PATCH', body: { password } });
      toast(`Zmieniono hasło – ${u.name} musi zalogować się ponownie`);
    } else if (btn.dataset.userAct === 'role') {
      await api(`/users/${id}`, { method: 'PATCH', body: { role: u.role === 'admin' ? 'member' : 'admin' } });
      toast('Zmieniono uprawnienia');
    } else {
      if (!(await ask('Historia zmian zostanie, bez imienia.', { title: `Usunąć konto ${u.name}?`, ok: 'Usuń', danger: true }))) return;
      await api(`/users/${id}`, { method: 'DELETE' });
      toast('Usunięto konto');
    }
    loadUsers();
  } catch (err) {
    toast(err.message);
  }
}

async function addUser(e) {
  e.preventDefault();
  const form = e.target;
  try {
    const u = await api('/users', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
    form.reset();
    toast(`Dodano: ${u.name}. Przekaż login i hasło domownikowi.`);
    loadUsers();
  } catch (err) {
    toast(err.message);
  }
}

async function changePassword(e) {
  e.preventDefault();
  const form = e.target;
  try {
    await api('/auth/password', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
    form.reset();
    toast('Hasło zmienione. Inne urządzenia zostały wylogowane.');
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Inicjalizacja ----------

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);

function bindEvents() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
  on('#btn-add', 'click', () => openItemDialog());
  on('#btn-scan', 'click', scanFlow);
  on('#form-scan-barcode', 'click', scanBarcodeIntoForm);
  on('#form-scan-expiry', 'click', scanExpiryIntoForm);
  on('#item-form', 'submit', saveItem);
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  on('#items-body', 'click', onItemAction);
  on('#items-tiles', 'click', onItemAction);
  $$('[data-layout]').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.layout)));
  on('#loc-chips', 'click', (e) => {
    const b = e.target.closest('[data-loc]');
    if (!b) return;
    $('#f-location').value = b.dataset.loc;
    loadItems().catch((err) => toast(err.message));
  });
  on('#fab-scan', 'click', scanFlow);
  on('#item-delete', 'click', deleteFromForm);
  applyLayout();
  on('#f-q', 'input', debounce(loadItems, 250));
  ['#f-category', '#f-location', '#f-status'].forEach((s) => on(s, 'change', loadItems));
  on('#shopping-list', 'click', onShoppingAction);
  on('#btn-copy-shopping', 'click', copyShopping);
  $$('.inline-form').forEach((f) => f.addEventListener('submit', onDictSubmit));
  on('#view-settings', 'click', onDictDelete);
  on('#btn-export', 'click', () => exportData().catch((e) => toast(e.message)));
  on('#item-photo-fetch', 'click', fetchItemPhoto);
  on('#item-photo-remove', 'click', removeItemPhoto);
  on('#btn-fill-photos', 'click', fillMissingPhotos);
  on('#import-file', 'change', importData);

  // Partie
  on('#batch-list', 'change', onBatchChange);
  on('#batch-list', 'click', onBatchClick);
  on('#batch-add-btn', 'click', addBatch);

  // Szybkie zużycie
  on('#btn-quick', 'click', openQuick);
  on('#quick-scan', 'click', quickScanLoop);
  on('#quick-log', 'click', onQuickUndo);

  // Paragony
  $$('[data-open-receipt]').forEach((b) => b.addEventListener('click', openReceipt));
  on('#receipt-photo', 'change', receiptFromPhoto);
  on('#receipt-paste-toggle', 'click', () => { $('#receipt-paste').hidden = !$('#receipt-paste').hidden; });
  on('#receipt-parse-btn', 'click', () => parseReceiptText($('#receipt-text').value).catch((e) => toast(e.message)));
  on('#receipt-form', 'submit', saveReceipt);
  on('#receipt-form', 'input', updateReceiptSummary);
  on('#receipt-form', 'change', (e) => {
    if (e.target.matches('.rl-target')) {
      const r = e.target.closest('.rline');
      $('.rl-hint', r).textContent = e.target.value === 'new' ? 'zostanie dodany jako nowy produkt' : e.target.value === 'skip' ? 'pominięte' : '';
      r.classList.toggle('skipped', e.target.value === 'skip');
    }
    updateReceiptSummary();
  });
  on('#receipt-lines', 'click', (e) => {
    if (e.target.closest('.rl-del')) {
      e.target.closest('.rline').remove();
      updateReceiptSummary();
    }
  });
  on('#receipt-add-line', 'click', () => { addReceiptLine({}); updateReceiptSummary(); });
  on('#receipt-back', 'click', () => {
    $('#receipt-form').hidden = true;
    $('#receipt-step1').hidden = false;
    $('#receipt-step1-actions').hidden = false;
    $('#receipt-status').textContent = '';
  });
  on('#exp-receipts', 'click', (e) => {
    const li = e.target.closest('[data-receipt]');
    if (li) showReceiptDetails(li.dataset.receipt).catch((err) => toast(err.message));
  });

  // Wydatki
  $$('[data-months]').forEach((b) => b.addEventListener('click', () => {
    state.months = Number(b.dataset.months);
    loadExpenses().catch((e) => toast(e.message));
  }));

  // Sprzęty
  on('#btn-add-eq', 'click', () => openEquipment());
  on('#eq-q', 'input', debounce(() => loadEquipment().catch((e) => toast(e.message)), 250));
  const openEq = (e) => {
    const card = e.target.closest('[data-eq-id]');
    if (card) openEquipment(card.dataset.eqId).catch((err) => toast(err.message));
  };
  on('#eq-list', 'click', openEq);
  on('#eq-list', 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEq(e); } });
  on('#dash-eq', 'click', openEq);
  on('#eq-form', 'submit', saveEquipment);
  on('#eq-delete', 'click', deleteEquipment);
  on('#doc-file', 'change', uploadDocs);
  on('#doc-camera', 'change', (e) => { $('#doc-kind').value = $('#doc-kind').value || 'photo'; uploadDocs(e); });
  on('#eq-doc-list', 'click', onDocClick);
  on('#eq-warranty-years', 'change', setWarrantyYears);

  // Integracje
  on('#token-form', 'submit', createToken);
  on('#token-list', 'click', onTokenClick);
  on('#embed-form', 'submit', saveEmbed);
  on('#token-copy', 'click', async () => {
    const v = $('#token-value').value;
    try {
      await navigator.clipboard.writeText(v);
      toast('Skopiowano klucz');
    } catch {
      $('#token-value').select();
      toast('Zaznaczono – skopiuj ręcznie');
    }
  });
  setupEmbeddedFiles();
  // Podpowiedzi przy ikonach menu (gdy menu jest zwinięte do samych ikon).
  $$('.tab').forEach((t) => { t.title = (t.querySelector('.lbl-desktop') || t.querySelector('span:not(.tab-badge)'))?.textContent || ''; });

  // Kalendarz
  on('#cal-prev', 'click', () => moveMonth(-1));
  on('#cal-next', 'click', () => moveMonth(1));
  on('#cal-today', 'click', () => {
    const t = todayStr();
    cal.year = Number(t.slice(0, 4));
    cal.month = Number(t.slice(5, 7)) - 1;
    cal.selected = t;
    loadCalendar().catch((e) => toast(e.message));
  });
  $$('[data-cal-mode]').forEach((b) => b.addEventListener('click', () => {
    cal.mode = b.dataset.calMode;
    loadCalendar().catch((e) => toast(e.message));
  }));
  on('#cal-home', 'change', () => loadCalendar().catch((e) => toast(e.message)));
  on('#cal-filters', 'click', (e) => {
    const b = e.target.closest('[data-cal-who]');
    if (!b) return;
    cal.who = b.dataset.calWho;
    loadCalendar().catch((err) => toast(err.message));
  });
  on('#cal-grid', 'click', (e) => {
    const cell = e.target.closest('[data-day]');
    if (!cell) return;
    if (cal.selected === cell.dataset.day && matchMedia('(min-width: 641px)').matches) return openEvent(null, cell.dataset.day);
    cal.selected = cell.dataset.day;
    $$('#cal-grid .cal-cell').forEach((c) => c.classList.toggle('selected', c === cell));
    renderCalDay();
    if (matchMedia('(max-width: 1100px)').matches) $('.cal-day').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  on('#cal-day-add', 'click', () => openEvent(null, cal.selected));
  on('#btn-event-add', 'click', () => openEvent(null, cal.selected || todayStr()));
  ['#cal-day-list', '#cal-agenda', '#dash-cal'].forEach((sel) => on(sel, 'click', onEventClick));
  on('#event-form', 'submit', saveEvent);
  on('#event-form', 'change', (e) => {
    if (['all_day', 'repeat'].includes(e.target.name)) syncEventForm();
    if (e.target.name === 'starts_on') {
      const f = e.target.form.elements;
      if (f.ends_on.value && f.ends_on.value < f.starts_on.value) f.ends_on.value = '';
    }
  });
  on('#event-form', 'click', (e) => {
    const form = $('#event-form');
    const cat = e.target.closest('[data-cat]');
    const pick = e.target.closest('[data-user-pick]');
    const vis = e.target.closest('[data-vis]');
    if (cat) form.dataset.category = cat.dataset.cat;
    else if (pick) {
      const id = Number(pick.dataset.userPick);
      const users = JSON.parse(form.dataset.users || '[]');
      form.dataset.users = JSON.stringify(users.includes(id) ? users.filter((x) => x !== id) : [...users, id]);
    } else if (vis && !vis.disabled) form.dataset.visibility = vis.dataset.vis;
    else return;
    syncEventForm();
  });
  on('#event-delete', 'click', deleteEvent);

  // Apteka
  on('#btn-med-add', 'click', () => openMedicine());
  on('#btn-med-scan', 'click', () => scanMedicine().catch((e) => toast(e.message)));
  on('#btn-med-journal', 'click', () => openJournal().catch((e) => toast(e.message)));
  on('#btn-med-dispose', 'click', disposeExpired);
  on('#med-q', 'input', debounce(() => loadPharmacy().catch((e) => toast(e.message)), 250));
  on('#med-filters', 'click', (e) => {
    const f = e.target.closest('[data-med-filter]');
    const p = e.target.closest('[data-med-person]');
    if (f) { pharm.filter = f.dataset.medFilter; pharm.person = ''; }
    else if (p) pharm.person = pharm.person === p.dataset.medPerson ? '' : p.dataset.medPerson;
    else return;
    loadPharmacy().catch((err) => toast(err.message));
  });
  const onMedList = (e) => {
    const take = e.target.closest('[data-med-take]');
    if (take) return openTake(take.dataset.medTake).catch((err) => toast(err.message));
    const card = e.target.closest('[data-med-id]');
    if (card) api(`/medicines/${card.dataset.medId}`).then((m) => openMedicine(m)).catch((err) => toast(err.message));
  };
  on('#med-list', 'click', onMedList);
  on('#med-list', 'keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.med-card')) onMedList(e); });
  on('#dash-med', 'click', onMedList);
  on('#med-form', 'submit', saveMedicine);
  on('#med-form', 'input', (e) => {
    if (e.target.name !== 'form') return;
    const f = formIcon(e.target.value);
    $('#med-form-ico').className = `med-ico lg ${f.cls}`;
    $('#med-form-ico').innerHTML = icon(f.ico);
    const unit = e.target.form.elements.unit;
    if (!pharm.current && ['tabl.', 'ml', 'kaps.', 'szt.', 'g', ''].includes(unit.value)) {
      unit.value = f.ico === 'bottle' || f.ico === 'drop' ? 'ml' : f.ico === 'tube' ? 'g' : /kaps/i.test(e.target.value) ? 'kaps.' : f.ico === 'pill' ? 'tabl.' : 'szt.';
    }
  });
  on('#med-delete', 'click', deleteMedicine);
  on('#med-pack-list', 'change', onPackChange);
  on('#med-pack-list', 'click', onPackClick);
  on('#pack-add-btn', 'click', addPack);
  on('#med-log', 'click', (e) => {
    const b = e.target.closest('[data-log-undo]');
    if (b) undoMedLog(b.dataset.logUndo);
  });
  on('#med-scan-barcode', 'click', async () => {
    const code = await Scanner.scanBarcode();
    if (code) $('#med-form').elements.barcode.value = code;
  });
  on('#med-scan-expiry', 'click', async () => {
    const date = await Scanner.scanExpiry((text) => api('/expiry/parse', { method: 'POST', body: { text } }));
    if (date) $('#med-form').elements.expires_at.value = date;
  });
  on('#take-form', 'submit', saveTake);
  on('#take-form', 'click', (e) => {
    const step = e.target.closest('[data-step]');
    const form = $('#take-form');
    if (step) {
      const unit = $('#take-unit').textContent;
      const inc = unit === 'ml' ? 2.5 : unit === 'g' ? 0.5 : 1;
      form.elements.amount.value = Math.max(0, Number(form.elements.amount.value || 0) + Number(step.dataset.step) * inc);
    }
    const person = e.target.closest('[data-take-person]');
    if (person) {
      const same = form.elements.person.value === person.dataset.takePerson;
      form.elements.person.value = same ? '' : person.dataset.takePerson;
      $$('[data-take-person]').forEach((b) => b.setAttribute('aria-pressed', String(!same && b === person)));
    }
  });

  // Pulpit: szybkie akcje i przejścia
  on('#view-dashboard', 'click', (e) => {
    const q = e.target.closest('[data-quick]');
    if (!q) return;
    const act = q.dataset.quick;
    if (act === 'scan') scanFlow();
    else if (act === 'consume') { openQuick(); }
    else if (act === 'receipt') openReceipt();
    else if (act === 'medicine') showView('pharmacy');
  });
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g && state.user) showView(g.dataset.goto);
  });

  // Motyw
  on('#theme-btn', 'click', () => {
    const dark = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    setTheme(dark ? 'light' : 'dark');
  });
  on('#theme-seg', 'click', (e) => {
    const b = e.target.closest('[data-theme-set]');
    if (b) setTheme(b.dataset.themeSet);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  applyTheme();

  // Konta
  on('#auth-form', 'submit', submitAuth);
  on('#btn-logout', 'click', logout);
  on('#user-chip', 'click', () => showView('settings'));
  on('#avatar-btn', 'click', () => showView('settings'));
  on('#users-list', 'click', onUserAction);
  on('#user-form', 'submit', addUser);
  on('#password-form', 'submit', changePassword);
}

// Przycisk „wstecz” w przeglądarce / telefonie przełącza zakładki.
window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (state.user && VIEWS.includes(v) && v !== state.currentView) showView(v);
});

async function startApp() {
  await loadDicts();
  state.users = await api('/users').catch(() => []);
  const initial = location.hash.slice(1);
  showView(VIEWS.includes(initial) ? initial : 'dashboard');
}

async function init() {
  bindEvents();
  try {
    const status = await api('/auth/status');
    if (!status.user) return showAuth(status.setup_required);
    setUser(status.user);
    await startApp();
  } catch (e) {
    toast(e.message);
  }
}

init();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  // Gdy na serwerze jest nowa wersja, nowy service worker przejmuje stronę – przeładuj raz, żeby ją pokazać.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    .then((reg) => reg.update())
    .catch((e) => console.warn('Service worker:', e));
}
