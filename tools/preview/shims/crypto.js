'use strict';
const { Buffer } = require('buffer');
const { sha256 } = require('js-sha256');
const scryptJs = require('scrypt-js');

function randomBytes(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return Buffer.from(a);
}
function createHash(alg) {
  if (alg !== 'sha256') throw new Error('Tylko sha256');
  const h = sha256.create();
  return {
    update(d) { h.update(typeof d === 'string' ? d : new Uint8Array(d)); return this; },
    digest(enc) { const b = Buffer.from(h.arrayBuffer()); return enc ? b.toString(enc) : b; },
  };
}
function scrypt(password, salt, keylen, opts, cb) {
  const pw = Buffer.from(String(password), 'utf8');
  scryptJs.scrypt(pw, Buffer.from(salt), opts.N, opts.r, opts.p, keylen)
    .then((k) => cb(null, Buffer.from(k)), (e) => cb(e));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) throw new RangeError('Różne długości');
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i] ^ b[i];
  return x === 0;
}
module.exports = { randomBytes, createHash, scrypt, timingSafeEqual };
