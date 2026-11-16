'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { categories: [], locations: [], currentView: 'dashboard' };

// ---------- Narzędzia ----------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Błąd ${res.status}`);
  return data;
}

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

// ---------- Nawigacja ----------

function showView(name) {
  state.currentView = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  location.hash = name;
  refresh();
}

function refresh() {
  const views = { dashboard: loadDashboard, items: loadItems, shopping: loadShopping, settings: loadSettings };
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
}

// ---------- Pulpit ----------

async function loadDashboard() {
  const [stats, low, expiring] = await Promise.all([
    api('/stats'), api('/items?status=low'), api('/items?status=expiring'),
  ]);

  $('#stats').innerHTML = [
    ['Wszystkie zasoby', stats.total_items, ''],
    ['Wartość zapasów', fmtMoney(stats.total_value), ''],
    ['Niski stan', stats.low_stock, stats.low_stock ? 'warn' : ''],
    ['Wkrótce tracą ważność', stats.expiring_soon, stats.expiring_soon ? 'warn' : ''],
    ['Przeterminowane', stats.expired, stats.expired ? 'danger' : ''],
  ].map(([label, value, cls]) => `<div class="stat ${cls}"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');

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
        <td class="${i.expires_at ? '' : 'nil'}">${expiryBadge(i.expires_at)}</td>
        <td class="actions">
          <button class="btn sm" data-act="dec" title="Zużyj 1">−</button>
          <button class="btn sm" data-act="inc" title="Dodaj 1">+</button>
          <button class="btn sm" data-act="edit">Edytuj</button>
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
  $('#item-dialog').showModal();
  form.elements.name.focus();
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
  const id = btn.closest('tr').dataset.id;
  const act = btn.dataset.act;
  try {
    if (act === 'inc' || act === 'dec') {
      await api(`/items/${id}/adjust`, { method: 'POST', body: { delta: act === 'inc' ? 1 : -1 } });
      refresh();
    } else if (act === 'edit') {
      openItemDialog(await api(`/items/${id}`));
    } else if (act === 'history') {
      const [item, hist] = await Promise.all([api(`/items/${id}`), api(`/items/${id}/history`)]);
      $('#history-title').textContent = `Historia: ${item.name}`;
      $('#history-list').innerHTML = hist.length
        ? hist.map((h) => `<li>
            <span>${new Date(h.created_at + 'Z').toLocaleString('pl-PL')} · ${esc(h.note)}</span>
            <span class="${h.delta > 0 ? 'delta-pos' : 'delta-neg'}">${h.delta > 0 ? '+' : ''}${fmtNum(h.delta)} ${esc(item.unit)}</span>
          </li>`).join('')
        : emptyLi('Brak zmian');
      $('#history-dialog').showModal();
    } else if (act === 'delete') {
      const name = btn.closest('tr').querySelector('.item-name').textContent;
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
  await loadDicts();
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

// ---------- Inicjalizacja ----------

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function init() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
  $('#btn-add').addEventListener('click', () => openItemDialog());
  $('#btn-scan').addEventListener('click', scanFlow);
  $('#form-scan-barcode').addEventListener('click', scanBarcodeIntoForm);
  $('#form-scan-expiry').addEventListener('click', scanExpiryIntoForm);
  $('#item-form').addEventListener('submit', saveItem);
  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#items-body').addEventListener('click', onItemAction);
  $('#f-q').addEventListener('input', debounce(loadItems, 250));
  ['#f-category', '#f-location', '#f-status'].forEach((s) => $(s).addEventListener('change', loadItems));
  $('#shopping-list').addEventListener('click', onShoppingAction);
  $('#btn-copy-shopping').addEventListener('click', copyShopping);
  $$('.inline-form').forEach((f) => f.addEventListener('submit', onDictSubmit));
  $('#view-settings').addEventListener('click', onDictDelete);
  $('#btn-export').addEventListener('click', () => exportData().catch((e) => toast(e.message)));
  $('#item-photo-fetch').addEventListener('click', fetchItemPhoto);
  $('#item-photo-remove').addEventListener('click', removeItemPhoto);
  $('#btn-fill-photos').addEventListener('click', fillMissingPhotos);
  $('#import-file').addEventListener('change', importData);

  loadDicts().then(() => {
    const initial = location.hash.slice(1);
    showView(['dashboard', 'items', 'shopping', 'settings'].includes(initial) ? initial : 'dashboard');
  }).catch((e) => toast(e.message));
}

init();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker:', e));
}
