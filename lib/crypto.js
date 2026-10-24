'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const randHex = (n) => crypto.randomBytes(n).toString('hex');

// Signing contexts — domain separation so a token of one kind can never be
// replayed as another kind.
const CTX = {
  LEASE: 'SHIFA-LEASE-v1',
  CMD: 'SHIFA-CMD-v1',
  RESP: 'SHIFA-RESP-v1',
  UPDATE: 'SHIFA-UPD-v1',
  REQ: 'SHIFA-REQ-v1',
};

let _keys = null;
function keyPaths() {
  return {
    signPriv: path.join(cfg.KEYS_DIR, 'signing-private.pem'),
    signPub: path.join(cfg.KEYS_DIR, 'signing-public.pem'),
    master: path.join(cfg.KEYS_DIR, 'master.key'),
  };
}

function ensureKeys() {
  const p = keyPaths();
  fs.mkdirSync(cfg.KEYS_DIR, { recursive: true, mode: 0o700 });
  // Hosting (Dokploy/Docker): the keys can be supplied as environment
  // variables so the server ALWAYS uses the same signing key the desktop app
  // has pinned — a fresh container never invents new keys.
  //   SHIFA_SIGNING_PRIVATE_KEY_B64 = base64 of signing-private.pem
  //   SHIFA_MASTER_KEY              = 64 hex chars (contents of master.key)
  const envPriv = process.env.SHIFA_SIGNING_PRIVATE_KEY_B64;
  const envMaster = process.env.SHIFA_MASTER_KEY;
  if (envPriv) {
    // tolerate quotes / spaces / line breaks pasted by mistake, and raw PEM
    const cleaned = envPriv.trim().replace(/^['"]|['"]$/g, '');
    const pem = cleaned.includes('BEGIN')
      ? cleaned.replace(/\\n/g, '\n')
      : Buffer.from(cleaned.replace(/\s+/g, ''), 'base64').toString('utf8');
    let priv;
    try {
      priv = crypto.createPrivateKey(pem);
    } catch {
      throw new Error('SHIFA_SIGNING_PRIVATE_KEY_B64 ghalat hai — value poori aur bilkul sahi copy karein (ek hi line, aakhir ka "=" bhi).');
    }
    if (priv.asymmetricKeyType !== 'ed25519') throw new Error('SHIFA_SIGNING_PRIVATE_KEY_B64 must be an Ed25519 key');
    const pub = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
    fs.writeFileSync(p.signPriv, pem, { mode: 0o600 });
    fs.writeFileSync(p.signPub, pub, { mode: 0o644 });
  }
  if (envMaster) {
    if (!/^[0-9a-fA-F]{64}$/.test(envMaster.trim())) throw new Error('SHIFA_MASTER_KEY must be 64 hex characters');
    fs.writeFileSync(p.master, envMaster.trim(), { mode: 0o600 });
  }
  if (!fs.existsSync(p.signPriv)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(p.signPriv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(p.signPub, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  }
  if (!fs.existsSync(p.master)) {
    fs.writeFileSync(p.master, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
}

function keys() {
  if (_keys) return _keys;
  ensureKeys();
  const p = keyPaths();
  const master = Buffer.from(fs.readFileSync(p.master, 'utf8').trim(), 'hex');
  if (master.length !== 32) throw new Error('master.key corrupt');
  _keys = {
    signPriv: crypto.createPrivateKey(fs.readFileSync(p.signPriv)),
    signPubPem: fs.readFileSync(p.signPub, 'utf8'),
    // Sub-keys derived from the master secret
    encKey: Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'shifa-key-enc', 32)),
    pepper: Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'shifa-key-hash', 32)),
    sessionPepper: Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'shifa-session', 32)),
  };
  return _keys;
}

/** token = b64u(JSON) + "." + b64u(Ed25519(ctx + "." + payloadB64)) */
function signToken(ctx, obj) {
  const p = b64u(JSON.stringify(obj));
  const sig = crypto.sign(null, Buffer.from(ctx + '.' + p), keys().signPriv);
  return p + '.' + b64u(sig);
}

function verifyWithPub(pubKey, ctx, token) {
  if (typeof token !== 'string') return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const p = token.slice(0, i);
  const s = token.slice(i + 1);
  try {
    if (!crypto.verify(null, Buffer.from(ctx + '.' + p), pubKey, unb64u(s))) return null;
    return JSON.parse(unb64u(p).toString('utf8'));
  } catch {
    return null;
  }
}

// ---- License keys -------------------------------------------------------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
function generateLicenseKey() {
  const bytes = crypto.randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) s += ALPHABET[bytes[i] & 31];
  return `SHIFA-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}
function normalizeKey(k) {
  const raw = String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^SHIFA[A-Z0-9]{20}$/.test(raw)) return null;
  const b = raw.slice(5);
  for (const ch of b) if (!ALPHABET.includes(ch)) return null;
  return `SHIFA-${b.slice(0, 5)}-${b.slice(5, 10)}-${b.slice(10, 15)}-${b.slice(15, 20)}`;
}
function hashKey(normalized) {
  return crypto.createHmac('sha256', keys().pepper).update(normalized).digest('hex');
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys().encKey, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join('.');
}
function decrypt(blob) {
  const [iv, tag, ct] = String(blob).split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', keys().encKey, unb64u(iv));
  d.setAuthTag(unb64u(tag));
  return Buffer.concat([d.update(unb64u(ct)), d.final()]).toString('utf8');
}

// ---- Passwords (scrypt) -------------------------------------------------
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64u(salt)}$${b64u(h)}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, h] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = unb64u(h);
    const got = crypto.scryptSync(String(pw), unb64u(salt), want.length, {
      N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem,
    });
    return crypto.timingSafeEqual(want, got);
  } catch {
    return false;
  }
}
// constant work even for unknown users
const DUMMY_HASH = hashPassword(randHex(8));

function sessionHash(token) {
  return crypto.createHmac('sha256', keys().sessionPepper).update(token).digest('hex');
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

module.exports = {
  b64u, unb64u, sha256hex, randHex, CTX, keys, ensureKeys, signToken, verifyWithPub,
  generateLicenseKey, normalizeKey, hashKey, encrypt, decrypt,
  hashPassword, verifyPassword, DUMMY_HASH, sessionHash, safeEqual,
};
