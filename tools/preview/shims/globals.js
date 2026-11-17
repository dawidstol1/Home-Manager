import { Buffer } from 'buffer';
// Pakiet `buffer` nie zna kodowania base64url (Node zna) – dopisujemy je.
const toString = Buffer.prototype.toString;
Buffer.prototype.toString = function (enc, ...rest) {
  if (enc === 'base64url') return toString.call(this, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return toString.call(this, enc, ...rest);
};
export { Buffer };
export const process = { env: { PRODUCT_LOOKUP: 'off', REPORT_TZ: 'Europe/Warsaw' }, cwd: () => '/', platform: 'browser' };
