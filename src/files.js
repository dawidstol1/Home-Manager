'use strict';

/**
 * Pliki dokumentów sprzętów (paragony, gwarancje, instrukcje, zdjęcia).
 * Zapisywane pod losową nazwą w katalogu UPLOADS_DIR; oryginalna nazwa i typ są w bazie.
 * Przyjmujemy tylko PDF, zdjęcia i zwykły tekst – typ jest sprawdzany po zawartości pliku.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ValidationError } = require('./db');

const MAX_UPLOAD = 25 * 1024 * 1024;
const TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'text/plain': 'txt',
};

/** Rozpoznaje typ po pierwszych bajtach (nie ufamy nagłówkowi ani rozszerzeniu). */
function sniff(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return brand === 'mif1' || brand === 'msf1' ? 'image/heif' : 'image/heic';
  }
  return null;
}

function looksLikeText(buf) {
  const sample = buf.subarray(0, 4096);
  if (sample.includes(0)) return false;
  try {
    // stream: true – niedokończony znak na końcu próbki nie jest błędem.
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: sample.length < buf.length });
    return true;
  } catch {
    return false;
  }
}

function createFileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });

  async function save(buf, declaredType) {
    if (!buf.length) throw new ValidationError('Plik jest pusty');
    if (buf.length > MAX_UPLOAD) throw Object.assign(new Error('Plik jest za duży (max 25 MB)'), { status: 413 });
    let mime = sniff(buf);
    if (!mime && String(declaredType).startsWith('text/plain') && looksLikeText(buf)) mime = 'text/plain';
    if (!mime) throw new ValidationError('Dozwolone pliki: PDF, zdjęcia (JPG, PNG, WEBP, HEIC) i tekst');
    const file = `${crypto.randomBytes(16).toString('hex')}.${TYPES[mime]}`;
    await fs.promises.writeFile(path.join(dir, file), buf, { flag: 'wx' });
    return { file, mime, size: buf.length };
  }

  function filePath(name) {
    if (!/^[0-9a-f]{32}\.(pdf|jpg|png|webp|heic|heif|txt)$/.test(name)) return null;
    return path.join(dir, name);
  }

  async function remove(name) {
    const p = filePath(name);
    if (p) await fs.promises.rm(p, { force: true });
  }

  return { save, filePath, remove, dir };
}

module.exports = { createFileStore, MAX_UPLOAD, sniff };
