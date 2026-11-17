'use strict';

/**
 * Konta domowników: hasła (scrypt), sesje (losowy token w ciasteczku HttpOnly
 * albo w nagłówku Authorization: Bearer dla aplikacji iOS) i ochrona logowania przed zgadywaniem.
 * W bazie trzymamy tylko skrót tokenu – wyciek bazy nie daje dostępu do kont.
 */

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { ValidationError } = require('./db');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'hm_session';
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function validatePassword(password) {
  const p = String(password ?? '');
  if (p.length < 8) throw new ValidationError('Hasło musi mieć co najmniej 8 znaków');
  if (p.length > 200) throw new ValidationError('Hasło jest za długie');
  return p;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(validatePassword(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(password ?? ''), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(key, expected);
}

// Stały skrót do porównania, gdy login nie istnieje – czas odpowiedzi nie zdradza, które konta są w bazie.
let dummyHash;
async function burnTime(password) {
  dummyHash ??= await hashPassword('nieistniejace-konto');
  await verifyPassword(password, dummyHash);
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Token z nagłówka Authorization (iOS) albo z ciasteczka (przeglądarka). */
function readToken(req) {
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return { token: auth.replace(/^Bearer\s+/i, '').trim(), via: 'bearer' };
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return token ? { token, via: 'cookie' } : null;
}

function isHttps(req, trustProxy) {
  if (req.socket?.encrypted) return true;
  return trustProxy && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

function sessionCookie(token, req, { trustProxy, secure }) {
  const useSecure = secure ?? isHttps(req, trustProxy);
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${useSecure ? '; Secure' : ''}`;
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket?.remoteAddress ?? '?';
}

/** Ogranicza nieudane logowania: max `limit` prób na adres IP w oknie `windowMs`. */
function createLoginLimiter({ limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const fails = new Map();
  const prune = (now) => {
    for (const [k, v] of fails) if (now - v.first > windowMs) fails.delete(k);
  };
  return {
    check(key) {
      const now = Date.now();
      if (fails.size > 1000) prune(now);
      const e = fails.get(key);
      if (e && now - e.first <= windowMs && e.count >= limit) {
        const err = new Error('Zbyt wiele nieudanych prób logowania. Spróbuj ponownie za kilka minut.');
        err.status = 429;
        throw err;
      }
    },
    fail(key) {
      const now = Date.now();
      const e = fails.get(key);
      if (!e || now - e.first > windowMs) fails.set(key, { count: 1, first: now });
      else e.count += 1;
    },
    reset(key) {
      fails.delete(key);
    },
  };
}

module.exports = {
  COOKIE, SESSION_DAYS, hashPassword, verifyPassword, validatePassword, burnTime, newToken, tokenHash,
  readToken, sessionCookie, clearCookie, clientIp, createLoginLimiter, parseCookies,
};
