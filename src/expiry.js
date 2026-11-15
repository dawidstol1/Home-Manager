'use strict';

/**
 * Wyszukuje datę ważności w tekście odczytanym (OCR) z etykiety produktu.
 *
 * Obsługiwane zapisy: 12.05.2027, 12/05/27, 12-05-2027, 2027-05-12, 05.2027 i 05/27
 * (miesiąc/rok → ostatni dzień miesiąca), 12 MAJ 2027, 12 MAY 27.
 * Daty przy słowach kluczowych („najlepiej spożyć przed”, „EXP”, „best before”…)
 * mają pierwszeństwo, a daty przy „data produkcji”, „LOT” itp. są pomijane.
 */

const MONTHS = {
  sty: 1, jan: 1, lut: 2, feb: 2, mar: 3, kwi: 4, apr: 4, maj: 5, may: 5, cze: 6, jun: 6,
  lip: 7, jul: 7, sie: 8, aug: 8, wrz: 9, sep: 9, paz: 10, 'paź': 10, oct: 10, okt: 10,
  lis: 11, nov: 11, gru: 12, dec: 12, dez: 12,
};

const EXPIRY_HINT = /(najlepiej|spo[zż]y[cć]|nale[zż]y|termin|wa[zż]n|przydatno|exp|best\s*before|\bbb[e]?\b|use\s*by|\bmhd\b|mindestens|\bdlc\b|\bddm\b|\bbest\b)/i;
const PRODUCTION_HINT = /(prod|wyprodukowan|pakowan|\blot\b|partia|partii|batch|\bl\s*[:.]|\bp\s*[:.])/i;

const pad = (n) => String(n).padStart(2, '0');

function toYear(y) {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

function makeDate(y, m, d) {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Typowe pomyłki OCR w ciągach cyfr: O→0, I/l→1, S→5, B→8. */
function normalize(text) {
  return String(text ?? '')
    .replace(/(?<=\d)[Oo](?=[\d./-])|(?<=[\d./-])[Oo](?=\d)/g, '0')
    .replace(/(?<=\d)[Il|](?=\d)|(?<=[./-])[Il|](?=\d)/g, '1')
    .replace(/\s*([./-])\s*/g, '$1')
    .replace(/[‐-―]/g, '-');
}

const PATTERNS = [
  // 2027-05-12
  { re: /\b(\d{4})[-./](\d{1,2})[-./](\d{1,2})\b/g, build: (m) => makeDate(+m[1], +m[2], +m[3]) },
  // 12.05.2027 / 12.05.27
  { re: /\b(\d{1,2})[-./](\d{1,2})[-./](\d{4}|\d{2})\b/g, build: (m) => makeDate(toYear(m[3]), +m[2], +m[1]) },
  // 12 MAJ 2027 / 12MAY27
  {
    re: /\b(\d{1,2})\s*([a-zźż]{3})[a-ząćęłńóśźż]*\.?\s*(\d{4}|\d{2})\b/gi,
    build: (m) => {
      const month = MONTHS[m[2].toLowerCase()];
      return month ? makeDate(toYear(m[3]), month, +m[1]) : null;
    },
  },
  // 05.2027 → koniec miesiąca
  {
    re: /\b(\d{1,2})[-./](\d{4})\b/g,
    build: (m) => {
      const y = +m[2];
      const mo = +m[1];
      return mo >= 1 && mo <= 12 ? makeDate(y, mo, lastDayOfMonth(y, mo)) : null;
    },
  },
  // 05/27 → koniec miesiąca (tylko przy słowie kluczowym – inaczej zbyt niejednoznaczne)
  {
    re: /\b(\d{1,2})[/.](\d{2})\b/g,
    needsHint: true,
    build: (m) => {
      const y = toYear(m[2]);
      const mo = +m[1];
      return mo >= 1 && mo <= 12 ? makeDate(y, mo, lastDayOfMonth(y, mo)) : null;
    },
  },
];

function parseExpiry(text, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const src = normalize(text);
  const used = [];
  const overlaps = (a, b) => used.some(([s, e]) => a < e && b > s);
  const candidates = [];
  const maxDate = `${Number(today.slice(0, 4)) + 15}${today.slice(4)}`;

  for (const { re, build, needsHint } of PATTERNS) {
    for (const m of src.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      const before = src.slice(Math.max(0, start - 40), start);
      const nearBefore = src.slice(Math.max(0, start - 25), start);
      const hint = EXPIRY_HINT.test(before);
      if (needsHint && !hint) continue;

      // Dopasowanie zajmuje fragment tekstu, nawet gdy data jest błędna (np. 31.02.2027),
      // żeby krótsze wzorce nie wyłuskały z niego fałszywej daty (02.2027).
      used.push([start, end]);
      const date = build(m);
      if (!date || date > maxDate) continue;

      let score = 0;
      if (hint) score += 10;
      if (PRODUCTION_HINT.test(nearBefore) && !EXPIRY_HINT.test(nearBefore)) score -= 10;
      if (date < today) score -= 1;

      candidates.push({ date, score, text: m[0] });
    }
  }

  const viable = candidates.filter((c) => c.score > -10);
  if (!viable.length) return { date: null, candidates: [] };
  viable.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
  return { date: viable[0].date, matched: viable[0].text, candidates: viable.map((c) => c.date) };
}

module.exports = { parseExpiry };
