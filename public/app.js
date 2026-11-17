'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const VIEWS = ['dashboard', 'items', 'shopping', 'equipment', 'expenses', 'settings'];
const state = { categories: [], locations: [], users: [], currentView: 'dashboard', user: null, months: 6 };

// ---------- Narzędzia ----------

/** Wywołanie API. `raw` – wysyła treść bez zamiany na JSON (pliki). */
async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: raw ? headers : body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) {
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
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  location.hash = name;
  refresh();
}

function refresh() {
  if (!state.user) return Promise.resolve();
  const views = {
    dashboard: loadDashboard, items: loadItems, shopping: loadShopping,
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
    set('#eq-badge', stats.warranty_ending + stats.service_due);
  } catch { /* licznik jest tylko podpowiedzią */ }
}

// ---------- Pulpit ----------

async function loadDashboard() {
  const [stats, low, expiring, equipment] = await Promise.all([
    api('/stats'), api('/items?status=low'), api('/items?status=expiring'), api('/equipment'),
  ]);

  $('#stats').innerHTML = [
    ['Wszystkie zasoby', stats.total_items, ''],
    ['Wartość zapasów', fmtMoney(stats.total_value), ''],
    ['Niski stan', stats.low_stock, stats.low_stock ? 'warn' : ''],
    ['Wkrótce tracą ważność', stats.expiring_soon, stats.expiring_soon ? 'warn' : ''],
    ['Przeterminowane', stats.expired, stats.expired ? 'danger' : ''],
    ['Wydatki w tym miesiącu', fmtMoney(stats.spent_month), '', 'expenses'],
    ['Zmarnowane w tym miesiącu', fmtMoney(stats.wasted_month), stats.wasted_month ? 'warn' : '', 'expenses'],
  ].map(([label, value, cls, view]) => view
    ? `<button type="button" class="stat ${cls}" data-goto="${view}"><div class="label">${label}</div><div class="value">${value}</div></button>`
    : `<div class="stat ${cls}"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');

  const alerts = equipmentAlerts(equipment);
  $('#dash-eq-card').hidden = !alerts.length;
  $('#dash-eq').innerHTML = alerts.map((a) => `<li data-eq-id="${a.id}" class="clickable"><span>${esc(a.name)}</span>${a.badge}</li>`).join('');

  $('#dash-low').innerHTML = low.length
    ? low.map((i) => `<li><span>${esc(i.name)}</span><span class="badge warn">${fmtNum(i.quantity)} / min ${fmtNum(i.min_quantity)} ${esc(i.unit)}</span></li>`).join('')
    : emptyLi('Wszystkie zapasy na odpowiednim poziomie 👍');

  $('#dash-expiring').innerHTML = expiring.length
    ? expiring.sort((a, b) => a.expires_at.localeCompare(b.expires_at))
      .map((i) => `<li><span>${esc(i.name)}</span><span>${expiryBadge(i.expires_at)}</span></li>`).join('')
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

function onBatchClick(e) {
  const btn = e.target.closest('[data-bact]');
  if (!btn) return;
  const id = btn.closest('[data-batch]').dataset.batch;
  const reason = btn.dataset.bact;
  if (reason === 'wasted' && !confirm('Wyrzucić całą partię? Trafi do statystyki zmarnowanych.')) return;
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
  if (!confirm(`Usunąć „${name}”?`)) return;
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
      if (!confirm(`Usunąć „${name}”?`)) return;
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
    prompt('Skopiuj listę:', text);
  }
}

// ---------- Ustawienia ----------

async function loadSettings() {
  await Promise.all([loadDicts(), loadUsers()]);
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
  if (!confirm(`Usunąć „${btn.dataset.name}”? Powiązane zasoby pozostaną bez przypisania.`)) return;
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
  if (!confirm('Import zastąpi wszystkie bieżące dane. Kontynuować?')) return;
  try {
    const data = JSON.parse(await file.text());
    const res = await api('/import', { method: 'POST', body: data });
    toast(`Zaimportowano ${res.items} zasobów`);
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
    [`Wydatki (${rep.months} mies.)`, fmtMoney(rep.totals.spent), ''],
    ['Średnio miesięcznie', fmtMoney(avg), ''],
    ['Zmarnowane', fmtMoney(rep.totals.wasted), rep.totals.wasted ? 'warn' : ''],
    ['Wyrzucone razy', rep.totals.wasted_count, rep.totals.wasted_count ? 'warn' : ''],
    ['Zakup sprzętów', fmtMoney(rep.totals.equipment), ''],
  ].map(([l, v, c]) => `<div class="stat ${c}"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('');

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
  if (!confirm('Usunąć ten dokument?')) return;
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
  if (!confirm(`Usunąć „${form.elements.name.value}” razem z dokumentami?`)) return;
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
  $('#user-chip').hidden = false;
  $('#user-chip').textContent = `👤 ${user.name}`;
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
    setUser(res.user);
    await startApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
}

async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
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
      const password = prompt(`Nowe hasło dla ${u.name} (min. 8 znaków):`);
      if (!password) return;
      await api(`/users/${id}`, { method: 'PATCH', body: { password } });
      toast(`Zmieniono hasło – ${u.name} musi zalogować się ponownie`);
    } else if (btn.dataset.userAct === 'role') {
      await api(`/users/${id}`, { method: 'PATCH', body: { role: u.role === 'admin' ? 'member' : 'admin' } });
      toast('Zmieniono uprawnienia');
    } else {
      if (!confirm(`Usunąć konto ${u.name}? Historia zmian zostanie, bez nazwiska.`)) return;
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
  on('#stats', 'click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (b) showView(b.dataset.goto);
  });

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

  // Konta
  on('#auth-form', 'submit', submitAuth);
  on('#btn-logout', 'click', logout);
  on('#user-chip', 'click', () => showView('settings'));
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
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker:', e));
}
