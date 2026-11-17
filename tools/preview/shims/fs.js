'use strict';
/* Pliki w pamięci przeglądarki (dokumenty sprzętów w podglądzie). */
const files = new Map();
const missing = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
module.exports = {
  __files: files,
  mkdirSync() {},
  mkdtempSync(p) { return p; },
  existsSync: (p) => files.has(p),
  readFile(p, cb) { setTimeout(() => (files.has(p) ? cb(null, files.get(p)) : cb(missing(p))), 0); },
  promises: {
    async readFile(p) { if (!files.has(p)) throw missing(p); return files.get(p); },
    async writeFile(p, data, opts) {
      if (opts?.flag === 'wx' && files.has(p)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      files.set(p, data);
    },
    async rm(p) { files.delete(p); },
  },
};
