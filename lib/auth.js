'use strict';
const { db, audit } = require('./db');
const C = require('./crypto');
const cfg = require('./config');
const { HttpError, parseCookies, clientIp } = require('./http');

const COOKIE = 'shifa_admin';

function createSession(adminId, req) {
  const token = C.randHex(32);
  const csrf = C.randHex(24);
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id_hash, admin_id, csrf, created_at, expires_at, ip, ua) VALUES (?,?,?,?,?,?,?)')
    .run(C.sessionHash(token), adminId, csrf, now, now + cfg.SESSION_HOURS * 3600e3,
      clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200));
  return { token, csrf };
}

function cookieHeader(token, maxAgeSec) {
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  if (cfg.COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cfg.COOKIE_SECURE ? '; Secure' : ''}`;
}

function currentSession(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(C.sessionHash(token));
  if (!s) return null;
  if (s.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE id_hash=?').run(s.id_hash); return null; }
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(s.admin_id);
  if (!admin) return null;
  return { session: s, admin };
}

// Guard for admin API: valid session + (for mutations) CSRF header match.
function requireAdmin(req, ctx) {
  const cur = currentSession(req);
  if (!cur) throw new HttpError(401, 'AUTH', 'Login zaroori hai.');
  if (!['GET', 'HEAD'].includes(req.method)) {
    const header = req.headers['x-csrf-token'];
    if (!header || !C.safeEqual(header, cur.session.csrf)) throw new HttpError(403, 'CSRF', 'CSRF token invalid.');
  }
  ctx.admin = cur.admin;
  ctx.session = cur.session;
  return cur;
}

function destroySession(req) {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE id_hash=?').run(C.sessionHash(token));
}

module.exports = { COOKIE, createSession, cookieHeader, clearCookie, currentSession, requireAdmin, destroySession };
