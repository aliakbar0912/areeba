'use strict';
// Endpoints the desktop app calls. Every mutating call is signed by the
// device's own key and carries a server-issued nonce, so requests cannot be
// replayed or forged.
const crypto = require('node:crypto');
const { db, audit, tx, getSetting } = require('../lib/db');
const C = require('../lib/crypto');
const L = require('../lib/licensing');
const { HttpError, clientIp, rateLimit } = require('../lib/http');

// Nonces are issued by /bootstrap (inserted) and consumed exactly once here
// (deleted). A consume succeeds only if the nonce was really issued by us and
// has not been used yet — so requests cannot be replayed or forged.
function consumeNonce(nonce) {
  if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 160) return false;
  const info = db.prepare('DELETE FROM nonces WHERE nonce = ? AND created_at > ?')
    .run(nonce, Date.now() - 10 * 60e3); // 10-minute validity
  return info.changes > 0;
}

// Verify a device-signed token: "payloadB64.sigB64", signed with the REQ
// context by the device's private key. Returns the payload object or null.
function signedRequest(dev, token) {
  try {
    return C.verifyWithPub(crypto.createPublicKey(dev.pubkey), C.CTX.REQ, token);
  } catch {
    return null;
  }
}

module.exports = function register(r) {
  // Server public key + a fresh nonce. The app pins this key on first install.
  r.get('/api/v1/bootstrap', (req, res, ctx) => {
    const nonce = C.randHex(24);
    db.prepare('INSERT INTO nonces (nonce, created_at) VALUES (?, ?)').run('BOOT-' + nonce, Date.now());
    ctx.json(200, {
      ok: true,
      server_time: Date.now(),
      public_key: C.keys().signPubPem,
      nonce,
      min_poll_seconds: parseInt(getSetting('heartbeat_seconds'), 10) || 300,
    });
  });

  // ---- Activation -------------------------------------------------------
  // Body: { key, nonce, device:{fp,fp_parts,pubkey,name,os,app_version}, client_time }
  r.post('/api/v1/activate', async (req, res, ctx) => {
    rateLimit('act:' + clientIp(req), 20, 10 * 60e3);
    const body = ctx.body;
    const norm = C.normalizeKey(body.key);
    if (!norm) throw new HttpError(400, 'BAD_KEY', 'License key sahi format mein nahi hai.');
    if (!consumeNonce('BOOT-' + body.nonce)) throw new HttpError(400, 'BAD_NONCE', 'Request purani ho chuki. Dobara koshish karein.');

    const d = body.device || {};
    if (!d.fp || !d.pubkey) throw new HttpError(400, 'BAD_DEVICE');
    let pub;
    try { pub = crypto.createPublicKey(d.pubkey); } catch { throw new HttpError(400, 'BAD_PUBKEY'); }
    if (pub.asymmetricKeyType !== 'ed25519') throw new HttpError(400, 'BAD_PUBKEY');

    const now = Date.now();
    const result = tx(() => {
      const lic = L.findLicenseByKey(norm);
      if (!lic) { audit('device', 'activate.fail', norm.slice(0, 11) + '…', { ip: clientIp(req) }, clientIp(req)); throw new HttpError(404, 'NO_LICENSE', 'Ye license key maujood nahi.'); }

      const eff = L.effectiveState(lic, null, now);
      if (eff.state === 'revoked' || eff.state === 'suspended') {
        throw new HttpError(403, eff.state.toUpperCase(), eff.reason);
      }

      // Already activated on this fingerprint? reuse the device row.
      let dev = db.prepare('SELECT * FROM devices WHERE license_id = ? AND fp = ?').get(lic.id, d.fp);
      if (dev && dev.status === 'banned') throw new HttpError(403, 'BANNED', 'Ye computer block kar diya gaya hai.');

      if (!dev) {
        const active = db.prepare("SELECT COUNT(*) c FROM devices WHERE license_id = ? AND status = 'active'").get(lic.id).c;
        if (active >= lic.max_devices) {
          throw new HttpError(409, 'DEVICE_LIMIT', `Is license par pehle se ${lic.max_devices} computer activate hain. Support se rabta karein.`);
        }
        const did = 'DV-' + C.randHex(12);
        db.prepare(`INSERT INTO devices (did, license_id, fp, fp_parts, pubkey, name, os, app_version, status, seq, first_seen, last_seen, last_ip)
          VALUES (?,?,?,?,?,?,?,?, 'active', 1, ?, ?, ?)`).run(
          did, lic.id, d.fp, JSON.stringify(d.fp_parts || []), d.pubkey,
          d.name || null, d.os || null, d.app_version || null, now, now, clientIp(req));
        dev = db.prepare('SELECT * FROM devices WHERE did = ?').get(did);
        audit('device', 'activate.new', norm.slice(0, 11) + '…', { did, os: d.os, name: d.name }, clientIp(req));
      } else {
        // Re-activation on same machine: rotate pubkey + bump seq.
        db.prepare('UPDATE devices SET status=\'active\', pubkey=?, app_version=?, name=?, os=?, seq=seq+1, last_seen=?, last_ip=? WHERE id=?')
          .run(d.pubkey, d.app_version || dev.app_version, d.name || dev.name, d.os || dev.os, now, clientIp(req), dev.id);
        dev = db.prepare('SELECT * FROM devices WHERE id = ?').get(dev.id);
        // A fresh install must never re-run an old reset command.
        db.prepare("UPDATE commands SET status='cancelled', done_at=? WHERE device_id=? AND status='pending' AND type='full_reset'").run(now, dev.id);
        audit('device', 'activate.reuse', norm.slice(0, 11) + '…', { did: dev.did }, clientIp(req));
      }

      const lease = L.buildLease(lic, dev, now);
      return { lease };
    });

    ctx.json(200, { ok: true, server_time: now, ...result.lease });
  });

  // ---- Heartbeat / lease refresh ---------------------------------------
  // Body: { did, nonce, req } where req is a device-signed token carrying
  // { did, nonce, client_time, app_version, seq }.
  r.post('/api/v1/heartbeat', async (req, res, ctx) => {
    rateLimit('hb:' + clientIp(req), 120, 10 * 60e3);
    const body = ctx.body;
    const dev = db.prepare('SELECT * FROM devices WHERE did = ?').get(String(body.did || ''));
    if (!dev) throw new HttpError(404, 'NO_DEVICE', 'Ye computer register nahi. Dobara activate karein.');

    const claim = signedRequest(dev, body.req);
    if (!claim) throw new HttpError(401, 'BAD_SIG', 'Signature verify nahi hui.');
    if (claim.did !== dev.did) throw new HttpError(401, 'BAD_SIG');
    if (!consumeNonce('BOOT-' + body.nonce) || claim.nonce !== body.nonce) {
      throw new HttpError(400, 'BAD_NONCE', 'Request purani ho chuki.');
    }

    const now = Date.now();
    const lic = db.prepare('SELECT * FROM licenses WHERE id = ?').get(dev.license_id);
    const skew = typeof claim.client_time === 'number' ? (claim.client_time - now) : 0;

    // App login accounts the shop has (emails/roles only) — lets the panel
    // offer the right account when resetting a forgotten password.
    let usersJson = dev.users_json;
    if (Array.isArray(claim.users)) {
      const users = claim.users.slice(0, 50).map((u) => ({
        email: String(u.email || '').slice(0, 120),
        name: String(u.name || '').slice(0, 80),
        role: String(u.role || '').slice(0, 30),
        active: u.active !== false,
      }));
      usersJson = JSON.stringify(users);
    }

    db.prepare('UPDATE devices SET last_seen=?, last_ip=?, app_version=?, clock_skew_ms=?, users_json=?, seq=seq+1 WHERE id=?')
      .run(now, clientIp(req), claim.app_version || dev.app_version, skew, usersJson, dev.id);

    // Results of commands this device has executed.
    if (Array.isArray(claim.acks)) {
      for (const a of claim.acks.slice(0, 20)) {
        const cmd = db.prepare("SELECT * FROM commands WHERE id=? AND device_id=? AND status='pending'").get(+a.id, dev.id);
        if (!cmd) continue;
        db.prepare('UPDATE commands SET status=?, result=?, done_at=? WHERE id=?')
          .run(a.ok ? 'done' : 'failed', String(a.result || '').slice(0, 300), now, cmd.id);
        audit('device', `command.${a.ok ? 'done' : 'failed'}`, dev.did, { id: cmd.id, type: cmd.type, result: a.result }, clientIp(req));
        // After a full reset the PC's licence data is wiped: free its slot so a
        // fresh install can activate again.
        if (a.ok && cmd.type === 'full_reset') {
          db.prepare("UPDATE devices SET status='removed', seq=seq+1 WHERE id=?").run(dev.id);
        }
      }
    }

    const fresh = db.prepare('SELECT * FROM devices WHERE id = ?').get(dev.id);
    const lease = L.buildLease(lic, fresh, now);

    // Pending commands for this PC, each signed so the app can trust it.
    const cmds = fresh.status === 'active'
      ? db.prepare("SELECT * FROM commands WHERE device_id=? AND status='pending' AND expires_at>? ORDER BY id").all(dev.id, now)
      : [];
    const commands = cmds.map((c) => C.signToken(C.CTX.CMD, {
      id: c.id, did: dev.did, type: c.type, params: JSON.parse(c.params || '{}'),
      issued_at: c.created_at, expires_at: c.expires_at,
    }));

    ctx.json(200, { ok: true, server_time: now, your_time: claim.client_time, skew_ms: skew, ...lease, commands });
  });

  // ---- Update manifest --------------------------------------------------
  r.get('/api/v1/updates/latest', (req, res, ctx) => {
    const channel = (ctx.query.channel || 'stable').toString();
    const current = (ctx.query.version || '0').toString();
    const rel = db.prepare("SELECT * FROM releases WHERE channel=? AND active=1 ORDER BY created_at DESC LIMIT 1").get(channel);
    if (!rel) return ctx.json(200, { ok: true, update: null });
    const newer = L.cmpVersion(rel.version, current) > 0;
    const manifest = {
      version: rel.version,
      channel: rel.channel,
      notes: rel.notes || '',
      mandatory: !!rel.mandatory,
      size: rel.size,
      sha256: rel.sha256,
      file_name: rel.file_name,
      url: `/api/v1/updates/download/${rel.id}`,
      released_at: rel.created_at,
    };
    // The manifest is signed so the client can trust it even if the transport
    // is tampered with; the binary itself is checked by sha256 + signature.
    ctx.json(200, { ok: true, update: newer ? manifest : null, latest: manifest, signed: C.signToken(C.CTX.UPDATE, manifest) });
  });

  r.get('/api/v1/updates/download/:id', (req, res, ctx) => {
    const path = require('node:path');
    const fs = require('node:fs');
    const cfg = require('../lib/config');
    const rel = db.prepare('SELECT * FROM releases WHERE id=? AND active=1').get(+ctx.params.id);
    if (!rel) throw new HttpError(404, 'NO_RELEASE');
    const file = path.join(cfg.RELEASES_DIR, rel.stored_name);
    if (!fs.existsSync(file)) throw new HttpError(404, 'MISSING_FILE');
    db.prepare('UPDATE releases SET downloads=downloads+1 WHERE id=?').run(rel.id);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': rel.size,
      'Content-Disposition': `attachment; filename="${rel.file_name.replace(/[^\w.\-]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
};
