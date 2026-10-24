'use strict';
const { db, getSetting } = require('./db');
const C = require('./crypto');

function cmpVersion(a, b) {
  const pa = String(a || '0').replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Returns the effective entitlement for a license+device pair right now.
function effectiveState(lic, dev, now = Date.now()) {
  if (dev && dev.status === 'banned') return { state: 'revoked', reason: 'Ye computer block kar diya gaya hai. Support se rabta karein.' };
  if (dev && dev.status === 'removed') return { state: 'revoked', reason: 'Ye computer is license se hata diya gaya hai.' };
  if (lic.status === 'revoked') return { state: 'revoked', reason: lic.status_reason || 'License revoke ho chuka hai.' };
  if (lic.status === 'suspended') return { state: 'suspended', reason: lic.status_reason || 'License suspend hai. Support se rabta karein.' };
  if (lic.expires_at && now > lic.expires_at) return { state: 'expired', reason: 'License ki muddat khatam ho gayi hai. Renew karwayein.' };
  return { state: 'active', reason: null };
}

function findLicenseByKey(normalizedKey) {
  return db.prepare('SELECT * FROM licenses WHERE key_hash = ?').get(C.hashKey(normalizedKey));
}
function licensePublicView(lic) {
  return {
    key: C.decrypt(lic.key_enc),
    customer: lic.customer, shop: lic.shop, phone: lic.phone, city: lic.city,
    plan: lic.plan, status: lic.status, status_reason: lic.status_reason,
    expires_at: lic.expires_at, max_devices: lic.max_devices, grace_hours: lic.grace_hours,
    channel: lic.channel, notes: lic.notes, message: lic.message,
    created_at: lic.created_at, updated_at: lic.updated_at,
  };
}

/**
 * Build the signed lease the desktop app stores and re-checks offline.
 * The sequence number (seq) is monotonic per device: a lease the server
 * issued earlier always carries a lower seq, so a restored/older lease file
 * is rejected by the client (anti-rollback).
 */
function buildLease(lic, dev, now = Date.now()) {
  const eff = effectiveState(lic, dev, now);
  // A PC activated offline keeps its long offline allowance (days) even after
  // it later reaches the server; other PCs use the licence's grace hours.
  const graceHours = dev.offline_days > 0
    ? dev.offline_days * 24
    : (lic.grace_hours === 0 || lic.grace_hours)
      ? lic.grace_hours
      : (parseInt(getSetting('default_grace_hours'), 10) || 72);
  const hb = parseInt(getSetting('heartbeat_seconds'), 10) || 300;
  const maxSkew = (parseInt(getSetting('max_clock_skew_minutes'), 10) || 30) * 60e3;
  const payload = {
    v: 1,
    did: dev.did,
    fp: dev.fp,
    seq: dev.seq,
    key_hint: lic.key_hint,
    customer: lic.customer,
    shop: lic.shop,
    plan: lic.plan,
    state: eff.state,
    reason: eff.reason,
    message: lic.message || getSetting('announcement') || null,
    issued_at: now,
    // Hard stop: the client refuses to run past this without a fresh lease.
    good_until: now + graceHours * 3600e3,
    lic_expires_at: lic.expires_at || null,
    heartbeat_seconds: hb,
    max_clock_skew_ms: maxSkew,
    channel: lic.channel || 'stable',
  };
  return { token: C.signToken(C.CTX.LEASE, payload), payload };
}

module.exports = { cmpVersion, effectiveState, findLicenseByKey, licensePublicView, buildLease };
