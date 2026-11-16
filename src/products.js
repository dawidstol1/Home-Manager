'use strict';

/**
 * Wyszukiwanie produktu po kodzie kreskowym w otwartej bazie Open Food Facts.
 * Wyniki są zapamiętywane w bazie (trafienia na stałe, braki na 1 dzień),
 * żeby nie odpytywać usługi przy każdym skanie.
 * Wyłączenie: zmienna środowiskowa PRODUCT_LOOKUP=off.
 */

const OFF_URL = 'https://world.openfoodfacts.org/api/v2/product/';
const FIELDS = 'product_name,product_name_pl,generic_name_pl,brands,quantity,categories_tags,image_front_url,image_front_small_url';
const MISS_TTL_MS = 24 * 60 * 60 * 1000;

const isRetailCode = (code) => /^\d{8}$|^\d{12,14}$/.test(code);

function toProduct(code, p) {
  const name = (p.product_name_pl || p.product_name || p.generic_name_pl || '').trim();
  if (!name) return null;
  const brand = (p.brands || '').split(',')[0].trim();
  return {
    barcode: code,
    // Krótką markę dopisujemy do nazwy; długie nazwy firm („Mars Wrigley Confectionery UK Limited”) pomijamy.
    name: brand && brand.length <= 20 && !name.toLowerCase().includes(brand.toLowerCase()) ? `${name} (${brand})` : name,
    brand: brand || null,
    quantity: (p.quantity || '').trim() || null,
    image_url: p.image_front_url || p.image_front_small_url || null,
    // Open Food Facts zawiera głównie żywność.
    category_hint: 'Żywność',
    source: 'Open Food Facts',
  };
}

function createProductLookup(store, { fetchImpl = globalThis.fetch, enabled = true, timeoutMs = 4000 } = {}) {
  return async function lookup(code) {
    if (!enabled || !isRetailCode(code)) return null;

    const cached = await store.getCachedProduct(code).catch(() => null);
    if (cached && (cached.data || Date.now() - cached.fetchedAt < MISS_TTL_MS)) return cached.data;

    try {
      const res = await fetchImpl(`${OFF_URL}${encodeURIComponent(code)}.json?fields=${FIELDS}`, {
        headers: { 'User-Agent': 'HomeManager/1.0 (self-hosted household inventory)' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok && res.status !== 404) return null; // błąd usługi – nie zapisujemy
      const body = await res.json();
      const product = body?.status === 1 && body.product ? toProduct(code, body.product) : null;
      await store.putCachedProduct(code, product).catch(() => {});
      return product;
    } catch {
      return null; // brak sieci / timeout – skanowanie działa dalej bez podpowiedzi
    }
  };
}

module.exports = { createProductLookup, isRetailCode };
