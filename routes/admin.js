'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, audit, tx, getSetting, setSetting } = require('../lib/db');
const C = require('../lib/crypto');
const L = require('../lib/licensing');
const TOTP = require('../lib/totp');
const cfg = require('../lib/config');
const A = require('../lib/auth');
const { HttpError, clientIp, rateLimit, readBody } = require('../lib/http');

function row2lic(l) {
  const activeDev = db.prepare("SELECT COUNT(*) c FROM devices WHERE license_id=? AND status='active'").get(l.id).c;
  return {
    id: l.id, key: C.decrypt(l.key_enc), key_hint: l.key_hint,
    customer: l.customer, shop: l.shop, phone: l.phone, city: l.city,
    plan: l.plan, status: l.status, status_reason: l.status_reason,
    expires_at: l.expires_at, max_devices: l.max_devices, active_devices: activeDev,
    grace_hours: l.grace_hours, channel: l.channel, notes: l.notes, message: l.message,
    created_at: l.created_at, updated_at: l.updated_at,
  };
}

module.exports = function register(r) {
  // ---- Login ------------------------------------------------------------
  r.post('/api/admin/login', (req, res, ctx) => {
    rateLimit('login:' + clientIp(req), 10, 15 * 60e3);
    const { username, password, otp } = ctx.body;
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || '').toLowerCase().trim());
    const now = Date.now();

    if (admin && admin.locked_until > now) {
      throw new HttpError(429, 'LOCKED', `Account kuch der ke liye lock hai. ${Math.ceil((admin.locked_until - now) / 60000)} min baad try karein.`);
    }
    // constant-time: always run a hash
    const ok = admin ? C.verifyPassword(password, admin.pass_hash) : (C.verifyPassword(password, C.DUMMY_HASH), false);
    if (!admin || !ok) {
      if (admin) {
        const fc = admin.failed_count + 1;
        const lock = fc >= 5 ? now + 15 * 60e3 : 0;
        db.prepare('UPDATE admins SET failed_count=?, locked_until=? WHERE id=?').run(fc >= 5 ? 0 : fc, lock, admin.id);
      }
      audit(username || '?', 'login.fail', null, null, clientIp(req));
      throw new HttpError(401, 'BAD_LOGIN', 'Username ya password ghalat hai.');
    }
    if (admin.totp_enabled) {
      const ctr = TOTP.verify(admin.totp_secret, otp, admin.totp_last, now);
      if (ctr < 0) {
        audit(admin.username, 'login.2fa_fail', null, null, clientIp(req));
        throw new HttpError(401, 'BAD_OTP', 'Authenticator code ghalat hai.');
      }
      db.prepare('UPDATE admins SET totp_last=? WHERE id=?').run(ctr, admin.id);
    }
    db.prepare('UPDATE admins SET failed_count=0, locked_until=0, last_login=? WHERE id=?').run(now, admin.id);
    const { token, csrf } = A.createSession(admin.id, req);
    audit(admin.username, 'login.ok', null, null, clientIp(req));
    ctx.json(200, { ok: true, csrf, username: admin.username, totp_enabled: !!admin.totp_enabled },
      { 'Set-Cookie': A.cookieHeader(token, cfg.SESSION_HOURS * 3600) });
  });

  r.post('/api/admin/logout', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    A.destroySession(req);
    ctx.json(200, { ok: true }, { 'Set-Cookie': A.clearCookie() });
  });

  r.get('/api/admin/me', (req, res, ctx) => {
    const cur = A.currentSession(req);
    if (!cur) return ctx.json(200, { ok: true, authed: false });
    ctx.json(200, { ok: true, authed: true, username: cur.admin.username, csrf: cur.session.csrf, totp_enabled: !!cur.admin.totp_enabled });
  });

  // ---- Change password / 2FA -------------------------------------------
  r.post('/api/admin/change-password', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const { current, next } = ctx.body;
    if (!C.verifyPassword(current, ctx.admin.pass_hash)) throw new HttpError(401, 'BAD_PW', 'Mojooda password ghalat hai.');
    if (String(next || '').length < 10) throw new HttpError(400, 'WEAK', 'Naya password kam az kam 10 characters ka hona chahiye.');
    db.prepare('UPDATE admins SET pass_hash=? WHERE id=?').run(C.hashPassword(next), ctx.admin.id);
    db.prepare('DELETE FROM sessions WHERE admin_id=? AND id_hash<>?').run(ctx.admin.id, ctx.session.id_hash);
    audit(ctx.admin.username, 'password.change', null, null, clientIp(req));
    ctx.json(200, { ok: true });
  });

  r.post('/api/admin/2fa/setup', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const secret = TOTP.generateSecret();
    db.prepare('UPDATE admins SET totp_secret=?, totp_enabled=0, totp_last=-1 WHERE id=?').run(secret, ctx.admin.id);
    ctx.json(200, { ok: true, secret, uri: TOTP.otpauthUri(secret, ctx.admin.username) });
  });
  r.post('/api/admin/2fa/enable', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const a = db.prepare('SELECT * FROM admins WHERE id=?').get(ctx.admin.id);
    if (!a.totp_secret) throw new HttpError(400, 'NO_SECRET', 'Pehle 2FA setup karein.');
    const ctr = TOTP.verify(a.totp_secret, ctx.body.otp, -1);
    if (ctr < 0) throw new HttpError(401, 'BAD_OTP', 'Code ghalat hai.');
    db.prepare('UPDATE admins SET totp_enabled=1, totp_last=? WHERE id=?').run(ctr, ctx.admin.id);
    audit(ctx.admin.username, '2fa.enable', null, null, clientIp(req));
    ctx.json(200, { ok: true });
  });
  r.post('/api/admin/2fa/disable', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    if (!C.verifyPassword(ctx.body.password, ctx.admin.pass_hash)) throw new HttpError(401, 'BAD_PW', 'Password ghalat hai.');
    db.prepare('UPDATE admins SET totp_enabled=0, totp_secret=NULL, totp_last=-1 WHERE id=?').run(ctx.admin.id);
    audit(ctx.admin.username, '2fa.disable', null, null, clientIp(req));
    ctx.json(200, { ok: true });
  });

  // ---- Licenses ---------------------------------------------------------
  r.get('/api/admin/licenses', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const q = (ctx.query.q || '').toString().trim().toLowerCase();
    const status = (ctx.query.status || '').toString();
    let rows = db.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();
    let out = rows.map(row2lic);
    if (status) out = out.filter((l) => l.status === status);
    if (q) out = out.filter((l) =>
      [l.key, l.customer, l.shop, l.phone, l.city].some((f) => String(f || '').toLowerCase().includes(q)));
    ctx.json(200, { ok: true, licenses: out, total: out.length });
  });

  r.post('/api/admin/licenses', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const b = ctx.body;
    if (!b.customer || !String(b.customer).trim()) throw new HttpError(400, 'NO_CUSTOMER', 'Customer ka naam zaroori hai.');
    const now = Date.now();
    let key, norm, hint;
    for (let i = 0; i < 5; i++) {
      key = C.generateLicenseKey();
      norm = C.normalizeKey(key);
      if (!db.prepare('SELECT 1 FROM licenses WHERE key_hash=?').get(C.hashKey(norm))) break;
    }
    hint = key.slice(0, 11) + '…' + key.slice(-4);
    let expires = null;
    if (b.valid_days && +b.valid_days > 0) expires = now + Math.round(+b.valid_days * 86400e3);
    else if (b.expires_at) expires = +b.expires_at;
    const info = db.prepare(`INSERT INTO licenses
      (key_hash, key_enc, key_hint, customer, shop, phone, city, plan, status, expires_at, max_devices, grace_hours, channel, notes, message, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?, 'active', ?,?,?,?,?,?,?,?)`).run(
      C.hashKey(norm), C.encrypt(key), hint,
      String(b.customer).trim(), b.shop || null, b.phone || null, b.city || null,
      b.plan || 'standard', expires, Math.max(1, +b.max_devices || 1),
      Math.max(0, +b.grace_hours || parseInt(getSetting('default_grace_hours'), 10) || 72),
      b.channel || 'stable', b.notes || null, b.message || null, now, now);
    audit(ctx.admin.username, 'license.create', key, { customer: b.customer }, clientIp(req));
    ctx.json(200, { ok: true, license: row2lic(db.prepare('SELECT * FROM licenses WHERE id=?').get(info.lastInsertRowid)) });
  });

  r.get('/api/admin/licenses/:id', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const l = db.prepare('SELECT * FROM licenses WHERE id=?').get(+ctx.params.id);
    if (!l) throw new HttpError(404, 'NO_LICENSE');
    const devices = db.prepare('SELECT * FROM devices WHERE license_id=? ORDER BY last_seen DESC').all(l.id)
      .map((d) => ({
        id: d.id, did: d.did, name: d.name, os: d.os, app_version: d.app_version,
        status: d.status, fp: d.fp.slice(0, 12) + '…', seq: d.seq,
        first_seen: d.first_seen, last_seen: d.last_seen, last_ip: d.last_ip, clock_skew_ms: d.clock_skew_ms,
        users: (() => { try { return JSON.parse(d.users_json || '[]'); } catch { return []; } })(),
        commands: db.prepare('SELECT id,type,label,status,result,created_at,done_at,created_by FROM commands WHERE device_id=? ORDER BY id DESC LIMIT 10').all(d.id),
      }));
    ctx.json(200, { ok: true, license: row2lic(l), devices });
  });

  r.patch('/api/admin/licenses/:id', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const l = db.prepare('SELECT * FROM licenses WHERE id=?').get(+ctx.params.id);
    if (!l) throw new HttpError(404, 'NO_LICENSE');
    const b = ctx.body;
    const fields = ['customer', 'shop', 'phone', 'city', 'plan', 'max_devices', 'grace_hours', 'channel', 'notes', 'message'];
    const sets = [], vals = [];
    for (const f of fields) if (f in b) { sets.push(`${f}=?`); vals.push(b[f]); }
    if ('valid_days' in b) {
      sets.push('expires_at=?');
      vals.push(b.valid_days === null || b.valid_days === '' ? null : Date.now() + Math.round(+b.valid_days * 86400e3));
    } else if ('expires_at' in b) { sets.push('expires_at=?'); vals.push(b.expires_at ? +b.expires_at : null); }
    if (!sets.length) throw new HttpError(400, 'NOTHING');
    sets.push('updated_at=?'); vals.push(Date.now()); vals.push(l.id);
    db.prepare(`UPDATE licenses SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    audit(ctx.admin.username, 'license.update', C.decrypt(l.key_enc), Object.keys(b), clientIp(req));
    ctx.json(200, { ok: true, license: row2lic(db.prepare('SELECT * FROM licenses WHERE id=?').get(l.id)) });
  });

  // suspend | activate | revoke  (status change with reason)
  r.post('/api/admin/licenses/:id/status', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const l = db.prepare('SELECT * FROM licenses WHERE id=?').get(+ctx.params.id);
    if (!l) throw new HttpError(404, 'NO_LICENSE');
    const to = String(ctx.body.status || '');
    if (!['active', 'suspended', 'revoked'].includes(to)) throw new HttpError(400, 'BAD_STATUS');
    db.prepare('UPDATE licenses SET status=?, status_reason=?, updated_at=? WHERE id=?')
      .run(to, ctx.body.reason || null, Date.now(), l.id);
    audit(ctx.admin.username, 'license.' + to, C.decrypt(l.key_enc), { reason: ctx.body.reason }, clientIp(req));
    ctx.json(200, { ok: true, license: row2lic(db.prepare('SELECT * FROM licenses WHERE id=?').get(l.id)) });
  });

  r.post('/api/admin/licenses/:id/extend', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const l = db.prepare('SELECT * FROM licenses WHERE id=?').get(+ctx.params.id);
    if (!l) throw new HttpError(404, 'NO_LICENSE');
    const days = +ctx.body.days;
    if (!days) throw new HttpError(400, 'BAD_DAYS');
    const base = l.expires_at && l.expires_at > Date.now() ? l.expires_at : Date.now();
    const next = base + Math.round(days * 86400e3);
    db.prepare('UPDATE licenses SET expires_at=?, updated_at=? WHERE id=?').run(next, Date.now(), l.id);
    audit(ctx.admin.username, 'license.extend', C.decrypt(l.key_enc), { days }, clientIp(req));
    ctx.json(200, { ok: true, expires_at: next });
  });

  // ---- Devices ----------------------------------------------------------
  // action: remove (frees a slot), ban (hard block), unban/reset
  r.post('/api/admin/devices/:id/action', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(+ctx.params.id);
    if (!d) throw new HttpError(404, 'NO_DEVICE');
    const action = String(ctx.body.action || '');
    const map = { remove: 'removed', ban: 'banned', reset: 'active', unban: 'active' };
    if (!(action in map)) throw new HttpError(400, 'BAD_ACTION');
    db.prepare('UPDATE devices SET status=?, seq=seq+1 WHERE id=?').run(map[action], d.id);
    audit(ctx.admin.username, 'device.' + action, d.did, { license_id: d.license_id }, clientIp(req));
    ctx.json(200, { ok: true });
  });

  // ---- Offline activation ----------------------------------------------
  // For shops with no internet: the app shows a Request Code (its fingerprint
  // + device public key); the owner pastes it here and gets back an
  // Activation Code (a server-signed lease) to type into the app.
  r.post('/api/admin/licenses/:id/offline-activate', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const lic = db.prepare('SELECT * FROM licenses WHERE id=?').get(+ctx.params.id);
    if (!lic) throw new HttpError(404, 'NO_LICENSE');
    const eff = L.effectiveState(lic, null);
    if (eff.state !== 'active') throw new HttpError(400, 'LICENSE_' + eff.state.toUpperCase(), 'License active nahi: ' + eff.reason);

    const raw = String(ctx.body.request_code || '').trim().replace(/\s+/g, '');
    if (!raw.startsWith('SHIFA-REQ:')) throw new HttpError(400, 'BAD_CODE', 'Request code ghalat hai (SHIFA-REQ: se shuru hona chahiye).');
    let rq;
    try { rq = JSON.parse(Buffer.from(raw.slice(10), 'base64url').toString('utf8')); } catch { throw new HttpError(400, 'BAD_CODE', 'Request code parha nahi ja saka. Poora copy karein.'); }
    if (!rq || rq.v !== 1 || !/^[0-9a-f]{64}$/.test(String(rq.fp || ''))) throw new HttpError(400, 'BAD_CODE', 'Request code ghalat hai.');
    let pubPem;
    try {
      const rawPub = Buffer.from(String(rq.pub || ''), 'base64url');
      if (rawPub.length !== 32) throw new Error();
      const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawPub]);
      pubPem = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' }).toString();
    } catch { throw new HttpError(400, 'BAD_CODE', 'Request code ki key ghalat hai.'); }

    const days = Math.min(3650, Math.max(1, parseInt(ctx.body.days, 10) || 365));
    const now = Date.now();
    const out = tx(() => {
      let dev = db.prepare('SELECT * FROM devices WHERE license_id=? AND fp=?').get(lic.id, rq.fp);
      if (dev && dev.status === 'banned') throw new HttpError(403, 'BANNED', 'Ye PC ban hai.');
      if (!dev) {
        const active = db.prepare("SELECT COUNT(*) c FROM devices WHERE license_id=? AND status='active'").get(lic.id).c;
        if (active >= lic.max_devices) throw new HttpError(409, 'DEVICE_LIMIT', `Is license par pehle se ${lic.max_devices} PC active hain. Pehle koi device Remove karein.`);
        const did = 'DV-' + C.randHex(12);
        db.prepare(`INSERT INTO devices (did, license_id, fp, fp_parts, pubkey, name, os, app_version, status, seq, first_seen, last_seen, last_ip, offline_days)
          VALUES (?,?,?,?,?,?,?,?, 'active', 1, ?, ?, 'offline', ?)`).run(
          did, lic.id, rq.fp, JSON.stringify(Array.isArray(rq.parts) ? rq.parts.slice(0, 10) : []), pubPem,
          String(rq.name || 'PC').slice(0, 80), String(rq.os || '').slice(0, 60), String(rq.ver || '').slice(0, 20), now, now, days);
        dev = db.prepare('SELECT * FROM devices WHERE did=?').get(did);
      } else {
        db.prepare("UPDATE devices SET status='active', pubkey=?, offline_days=?, seq=seq+1, last_seen=? WHERE id=?").run(pubPem, days, now, dev.id);
        db.prepare("UPDATE commands SET status='cancelled', done_at=? WHERE device_id=? AND status='pending' AND type='full_reset'").run(now, dev.id);
        dev = db.prepare('SELECT * FROM devices WHERE id=?').get(dev.id);
      }
      return L.buildLease(lic, dev, now);
    });
    audit(ctx.admin.username, 'device.offline_activate', C.decrypt(lic.key_enc), { name: rq.name, days }, clientIp(req));
    ctx.json(200, { ok: true, activation_code: 'SHIFA-ACT:' + out.token, days });
  });

  // ---- Remote commands (forgot password / full reset) ---------------------
  // The new password is hashed HERE in the exact format the desktop app uses
  // (salt:pbkdf2-sha512), so the plain password never travels to the PC and is
  // never stored on this server.
  r.post('/api/admin/devices/:id/command', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(+ctx.params.id);
    if (!d) throw new HttpError(404, 'NO_DEVICE');
    if (d.status !== 'active') throw new HttpError(400, 'DEVICE_INACTIVE', 'Ye device active nahi hai.');
    const type = String(ctx.body.type || '');
    const now = Date.now();
    let params = {}, label = '';

    if (type === 'reset_password') {
      const pw = String(ctx.body.password || '');
      if (pw.length < 6) throw new HttpError(400, 'WEAK', 'Naya password kam az kam 6 characters ka ho.');
      const email = String(ctx.body.email || '').trim().toLowerCase();
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512').toString('hex');
      params = { email: email || null, passwordHash: `${salt}:${hash}` };
      label = `Password reset: ${email || 'owner (ADMIN) account'}`;
    } else if (type === 'full_reset') {
      if (String(ctx.body.confirm || '') !== 'RESET') throw new HttpError(400, 'CONFIRM', 'Confirm karne ke liye RESET likhein.');
      label = 'Full reset (data backup + fresh start)';
    } else {
      throw new HttpError(400, 'BAD_TYPE');
    }

    // Only one pending command of each type per PC.
    db.prepare("UPDATE commands SET status='cancelled', done_at=? WHERE device_id=? AND type=? AND status='pending'").run(now, d.id, type);
    const info = db.prepare(`INSERT INTO commands (device_id, type, params, label, status, created_at, expires_at, created_by)
      VALUES (?,?,?,?, 'pending', ?, ?, ?)`).run(d.id, type, JSON.stringify(params), label, now, now + 3 * 86400e3, ctx.admin.username);
    audit(ctx.admin.username, 'command.' + type, d.did, { label }, clientIp(req));
    ctx.json(200, { ok: true, id: info.lastInsertRowid });
  });

  r.post('/api/admin/commands/:id/cancel', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const c = db.prepare("SELECT * FROM commands WHERE id=? AND status='pending'").get(+ctx.params.id);
    if (!c) throw new HttpError(404, 'NO_COMMAND', 'Ye command pending nahi.');
    db.prepare("UPDATE commands SET status='cancelled', done_at=? WHERE id=?").run(Date.now(), c.id);
    audit(ctx.admin.username, 'command.cancel', String(c.id), { type: c.type }, clientIp(req));
    ctx.json(200, { ok: true });
  });

  // ---- Releases / updates ----------------------------------------------
  r.get('/api/admin/releases', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    ctx.json(200, { ok: true, releases: db.prepare('SELECT id,version,channel,notes,mandatory,file_name,size,sha256,active,downloads,created_at,created_by FROM releases ORDER BY created_at DESC').all() });
  });

  // Upload: raw binary body; metadata in query string.
  r.post('/api/admin/releases', async (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const version = String(ctx.query.version || '').trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) throw new HttpError(400, 'BAD_VERSION', 'Version 1.0.0 format mein do.');
    const channel = String(ctx.query.channel || 'stable');
    const fileName = String(ctx.query.file_name || `ShifaMedicalStore-Setup-${version}.exe`).replace(/[^\w.\-]/g, '_');
    const buf = await readBody(req, cfg.MAX_UPLOAD_BYTES);
    if (!buf.length) throw new HttpError(400, 'EMPTY');
    fs.mkdirSync(cfg.RELEASES_DIR, { recursive: true });
    const sha = C.sha256hex(buf);
    const stored = `${version}-${channel}-${sha.slice(0, 8)}-${fileName}`;
    fs.writeFileSync(path.join(cfg.RELEASES_DIR, stored), buf);
    const info = db.prepare(`INSERT INTO releases (version,channel,notes,mandatory,file_name,stored_name,size,sha256,active,created_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,1,?,?)`).run(
      version, channel, String(ctx.query.notes || ''), ctx.query.mandatory === '1' ? 1 : 0,
      fileName, stored, buf.length, sha, Date.now(), ctx.admin.username);
    audit(ctx.admin.username, 'release.upload', version, { channel, sha, size: buf.length }, clientIp(req));
    ctx.json(200, { ok: true, id: info.lastInsertRowid, sha256: sha, size: buf.length });
  });

  r.post('/api/admin/releases/:id/toggle', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const rel = db.prepare('SELECT * FROM releases WHERE id=?').get(+ctx.params.id);
    if (!rel) throw new HttpError(404, 'NO_RELEASE');
    db.prepare('UPDATE releases SET active=? WHERE id=?').run(rel.active ? 0 : 1, rel.id);
    audit(ctx.admin.username, 'release.toggle', rel.version, { active: rel.active ? 0 : 1 }, clientIp(req));
    ctx.json(200, { ok: true, active: rel.active ? 0 : 1 });
  });

  r.delete('/api/admin/releases/:id', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const rel = db.prepare('SELECT * FROM releases WHERE id=?').get(+ctx.params.id);
    if (!rel) throw new HttpError(404, 'NO_RELEASE');
    try { fs.unlinkSync(path.join(cfg.RELEASES_DIR, rel.stored_name)); } catch {}
    db.prepare('DELETE FROM releases WHERE id=?').run(rel.id);
    audit(ctx.admin.username, 'release.delete', rel.version, null, clientIp(req));
    ctx.json(200, { ok: true });
  });

  // ---- Dashboard / audit / settings ------------------------------------
  r.get('/api/admin/stats', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const g = (sql, ...a) => db.prepare(sql).get(...a).c;
    const now = Date.now();
    ctx.json(200, {
      ok: true,
      stats: {
        licenses_total: g('SELECT COUNT(*) c FROM licenses'),
        licenses_active: g("SELECT COUNT(*) c FROM licenses WHERE status='active'"),
        licenses_suspended: g("SELECT COUNT(*) c FROM licenses WHERE status='suspended'"),
        licenses_revoked: g("SELECT COUNT(*) c FROM licenses WHERE status='revoked'"),
        licenses_expired: g('SELECT COUNT(*) c FROM licenses WHERE expires_at IS NOT NULL AND expires_at < ?', now),
        devices_active: g("SELECT COUNT(*) c FROM devices WHERE status='active'"),
        devices_online: g('SELECT COUNT(*) c FROM devices WHERE last_seen > ?', now - 15 * 60e3),
        releases: g('SELECT COUNT(*) c FROM releases WHERE active=1'),
      },
      recent: db.prepare('SELECT at,actor,action,target FROM audit ORDER BY at DESC LIMIT 12').all(),
    });
  });

  r.get('/api/admin/audit', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    const limit = Math.min(500, +ctx.query.limit || 200);
    ctx.json(200, { ok: true, audit: db.prepare('SELECT * FROM audit ORDER BY at DESC LIMIT ?').all(limit) });
  });

  r.get('/api/admin/settings', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    ctx.json(200, { ok: true, settings: {
      heartbeat_seconds: getSetting('heartbeat_seconds'),
      max_clock_skew_minutes: getSetting('max_clock_skew_minutes'),
      default_grace_hours: getSetting('default_grace_hours'),
      announcement: getSetting('announcement'),
    } });
  });
  r.post('/api/admin/settings', (req, res, ctx) => {
    A.requireAdmin(req, ctx);
    for (const k of ['heartbeat_seconds', 'max_clock_skew_minutes', 'default_grace_hours', 'announcement']) {
      if (k in ctx.body) setSetting(k, ctx.body[k]);
    }
    audit(ctx.admin.username, 'settings.update', null, Object.keys(ctx.body), clientIp(req));
    ctx.json(200, { ok: true });
  });
};
