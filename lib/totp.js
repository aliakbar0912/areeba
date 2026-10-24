'use strict';
// RFC 6238 TOTP (Google Authenticator / Microsoft Authenticator compatible)
const crypto = require('node:crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

/** Returns the matched counter (to block re-use), or -1 */
function verify(secret, code, lastCounter = -1, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return -1;
  const t = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) {
    const ctr = t + d;
    if (ctr <= lastCounter) continue;
    const want = Buffer.from(hotp(secret, ctr));
    if (crypto.timingSafeEqual(want, Buffer.from(c))) return ctr;
  }
  return -1;
}

function otpauthUri(secret, account, issuer = 'Shifa License Panel') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, verify, otpauthUri, hotp };
