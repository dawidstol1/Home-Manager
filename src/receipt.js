'use strict';

/**
 * Odczyt pozycji z tekstu polskiego paragonu fiskalnego (wynik OCR zdjęcia).
 * Rozpoznaje typowe układy:
 *   "Mleko UHT 3,2% 1L   C  2 x3,29   6,58C"
 *   "Jogurt naturalny    2 * 1,79  3,58 C"
 *   "Banany luz        0,756 x5,99   4,53C"
 *   "MLEKO UHT" + w następnej linii "2 x 3,29 = 6,58 C"
 *   "Chleb               4,99 A"            (jedna sztuka)
 *   "Rabat              -1,00"              (odejmowany od poprzedniej pozycji)
 */

const SHOPS = [
  'Biedronka', 'Lidl', 'Kaufland', 'Auchan', 'Carrefour', 'Żabka', 'Netto', 'Dino', 'Stokrotka', 'Rossmann',
  'Lewiatan', 'Aldi', 'Intermarche', 'Polomarket', 'Hebe', 'Pepco', 'Action', 'Leroy Merlin', 'Castorama',
  'OBI', 'Media Expert', 'Ikea', 'Delikatesy Centrum', 'Spar', 'Makro', 'Selgros', 'Super-Pharm', 'Orlen',
];

const NUM = String.raw`\d+(?:[.,]\d{1,3})?`;
const MONEY = String.raw`-?\d+[.,]\d{2}`;
const QTY_PRICE = new RegExp(
  String.raw`(?:^|\s)(${NUM})\s*(?:szt\.?|kg|op\.?)?\s*[x×*]\s*(${MONEY})\s*=?\s*(${MONEY})\s*[A-G]?\s*$`,
  'i'
);
const SINGLE = new RegExp(String.raw`^(.*?[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż%].*?)\s+(${MONEY})\s*[A-G]\s*$`);
const DISCOUNT = new RegExp(String.raw`^(rabat|upust|obni[zż]ka|promocja|zni[zż]ka|kupon)\b.*?(-\s?\d+[.,]\d{2})`, 'i');
const STOP = /^(sprzeda[zż]|suma|ptu|razem|do zap[lł]aty|got[oó]wka|karta|reszta|płatno|platno|nr sys|kasjer)/i;
const TOTAL = /(?:suma|do zap[lł]aty|razem)\s*(?:pln)?\s*[:.]?\s*(\d+[.,]\d{2})/i;

const money = (s) => Math.round(Number(String(s).replace(/\s/g, '').replace(',', '.')) * 100) / 100;
const qty = (s) => Number(String(s).replace(',', '.'));

/** Typowe pomyłki OCR w liczbach: O→0, przecinek z odstępem. */
function cleanLine(line) {
  return line
    .replace(/(?<=[\d,.\s])[Oo](?=[\d,.])/g, '0')
    .replace(/(?<=\d)[Oo](?=\s|$)/g, '0')
    .replace(/(\d)\s*,\s*(\d{2})(?!\d)/g, '$1,$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanName(name) {
  return name
    .replace(/\s+[A-G]$/, '') // litera stawki VAT za nazwą
    .replace(/^[\s\-*.#]+|[\s\-*.:]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function findDate(text) {
  let m = text.match(/(20\d{2})[-./](\d{2})[-./](\d{2})/);
  if (m) return valid(m[1], m[2], m[3]);
  m = text.match(/(\d{2})[-./](\d{2})[-./](20\d{2})/);
  if (m) return valid(m[3], m[2], m[1]);
  return null;
}

function valid(y, mo, d) {
  const iso = `${y}-${mo}-${d}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.getUTCDate() === Number(d) ? iso : null;
}

function findShop(lines) {
  const head = lines.slice(0, 10).join(' ').toLowerCase();
  const known = SHOPS.find((s) => head.includes(s.toLowerCase()) || head.includes(s.toLowerCase().replace('ż', 'z')));
  if (known) return known;
  const first = lines.find((l) => /[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]{3}/.test(l) && !/nip|paragon|ul\.|tel/i.test(l));
  return first ? first.slice(0, 60) : '';
}

function parseReceipt(text) {
  const raw = String(text ?? '').split(/\r?\n/).map(cleanLine).filter(Boolean);
  const startIdx = raw.findIndex((l) => /paragon\s*fiskalny/i.test(l));
  const body = startIdx >= 0 ? raw.slice(startIdx + 1) : raw;

  const lines = [];
  let pendingName = null;
  let total = null;
  for (const line of body) {
    const totalMatch = line.match(TOTAL);
    if (totalMatch && /suma|zap[lł]aty/i.test(line)) total = money(totalMatch[1]);
    if (STOP.test(line)) {
      if (/^suma|^do zap/i.test(line)) break;
      continue;
    }

    const disc = line.match(DISCOUNT);
    if (disc) {
      const last = lines.at(-1);
      if (last) {
        last.discount = Math.round(((last.discount ?? 0) + money(disc[2])) * 100) / 100;
        last.total = Math.max(0, Math.round((last.total + money(disc[2])) * 100) / 100);
      }
      continue;
    }

    const qp = line.match(QTY_PRICE);
    if (qp) {
      let name = cleanName(line.slice(0, qp.index));
      if (!/[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]{2}/.test(name) && pendingName) name = pendingName;
      pendingName = null;
      if (!name) continue;
      lines.push({ name, quantity: qty(qp[1]), unit_price: money(qp[2]), total: money(qp[3]), raw: line });
      continue;
    }

    const single = line.match(SINGLE);
    if (single) {
      const name = cleanName(single[1]);
      pendingName = null;
      if (name && !/nip|paragon/i.test(name)) {
        const t = money(single[2]);
        lines.push({ name, quantity: 1, unit_price: t, total: t, raw: line });
      }
      continue;
    }

    // Sama nazwa – ilość i cena mogą być w następnej linii.
    pendingName = /[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]{3}/.test(line) && !/\d{3}-\d{2,3}-\d{2}/.test(line) ? cleanName(line) : null;
  }

  return {
    shop: findShop(raw),
    date: findDate(raw.join('\n')),
    total,
    lines,
    lines_total: Math.round(lines.reduce((s, l) => s + l.total, 0) * 100) / 100,
  };
}

module.exports = { parseReceipt };
