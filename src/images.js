'use strict';

/**
 * Zdjęcia produktów z Open Food Facts.
 * Serwer pobiera zdjęcie raz i trzyma je lokalnie (domyślnie data/images/<kod>.jpg),
 * więc aplikacja pokazuje je także bez internetu i nie obciąża zewnętrznej usługi.
 */

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_HOSTS = new Set(['images.openfoodfacts.org', 'static.openfoodfacts.org']);
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 3 * 1024 * 1024;

function createImageService(
  store,
  { dir, lookup, fetchImpl = globalThis.fetch, enabled = true, timeoutMs = 10000, retryDelayMs = 1500 } = {},
) {
  fs.mkdirSync(dir, { recursive: true });
  const pending = new Map(); // itemId → Promise (bez podwójnego pobierania)

  /** Pobiera zdjęcie spod dozwolonego adresu i zapisuje je jako <kod>.<rozszerzenie>. */
  async function download(url, barcode) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) return null;
    const res = await fetchImpl(parsed.href, {
      headers: { 'User-Agent': 'HomeManager/1.0 (self-hosted household inventory)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = TYPES[type];
    if (!ext) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) return null;
    const name = `${String(barcode).replace(/[^0-9A-Za-z_-]/g, '_')}.${ext}`;
    await fs.promises.writeFile(path.join(dir, name), bytes);
    return name;
  }

  /**
   * Dołącza zdjęcie do zasobu (i do innych pozycji z tym samym kodem, które go nie mają).
   * Zwraca { item, found }.
   */
  async function attach(itemId, { force = false } = {}) {
    const item = store.getItem(itemId);
    if (!enabled || !item.barcode) return { item, found: false };
    if (item.image && !force && fs.existsSync(path.join(dir, item.image))) return { item, found: true };
    if (pending.has(item.id)) return pending.get(item.id);

    const job = (async () => {
      try {
        const product = await lookup(item.barcode);
        let file = null;
        if (product?.image_url) {
          // Jedna ponowna próba – zewnętrzna usługa bywa chwilowo wolna.
          file = await download(product.image_url, item.barcode).catch(() => null);
          if (!file) {
            await new Promise((r) => setTimeout(r, retryDelayMs));
            file = await download(product.image_url, item.barcode).catch(() => null);
          }
        }
        if (!file) return { item: store.getItem(item.id), found: false };
        store.setImageForBarcode(item.barcode, file, { overwrite: force, itemId: item.id });
        return { item: store.getItem(item.id), found: true };
      } catch {
        return { item: store.getItem(item.id), found: false };
      } finally {
        pending.delete(item.id);
      }
    })();
    pending.set(item.id, job);
    return job;
  }

  /**
   * Uruchamia pobieranie w tle – odpowiedź API nie czeka na zewnętrzną usługę.
   * Zadania idą po kolei, żeby nie zasypywać Open Food Facts równoległymi żądaniami.
   */
  let queue = Promise.resolve();
  function attachLater(itemId) {
    queue = queue.then(() => attach(itemId)).catch(() => {});
    return queue;
  }

  /** Pobiera brakujące zdjęcia dla wszystkich zasobów z kodem kreskowym. */
  async function fillMissing() {
    const missing = store.listItems().filter((i) => i.barcode && !i.image);
    const seen = new Set();
    let found = 0;
    for (const item of missing) {
      if (seen.has(item.barcode)) continue;
      seen.add(item.barcode);
      if ((await attach(item.id)).found) found += 1;
    }
    return { checked: seen.size, found };
  }

  function filePath(name) {
    if (!/^[0-9A-Za-z_-]+\.(jpg|png|webp)$/.test(name)) return null;
    return path.join(dir, name);
  }

  return { attach, attachLater, fillMissing, filePath, dir, pending };
}

module.exports = { createImageService, ALLOWED_HOSTS };
