'use strict';
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

fs.mkdirSync(cfg.DATA_DIR, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(cfg.DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS licenses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash      TEXT NOT NULL UNIQUE,
  key_enc       TEXT NOT NULL,
  key_hint      TEXT NOT NULL,
  customer      TEXT NOT NULL,
  shop          TEXT,
  phone         TEXT,
  city          TEXT,
  plan          TEXT NOT NULL DEFAULT 'standard',
  status        TEXT NOT NULL DEFAULT 'active',      -- active | suspended | revoked
  status_reason TEXT,
  expires_at    INTEGER,                             -- ms epoch, NULL = lifetime
  max_devices   INTEGER NOT NULL DEFAULT 1,
  grace_hours   INTEGER NOT NULL DEFAULT 72,         -- max offline time
  channel       TEXT NOT NULL DEFAULT 'stable',
  notes         TEXT,
  message       TEXT,                                -- shown inside the customer's app
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  did           TEXT NOT NULL UNIQUE,
  license_id    INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  fp            TEXT NOT NULL,
  fp_parts      TEXT NOT NULL DEFAULT '[]',
  pubkey        TEXT NOT NULL,
  name          TEXT,
  os            TEXT,
  app_version   TEXT,
  status        TEXT NOT NULL DEFAULT 'active',      -- active | removed | banned
  seq           INTEGER NOT NULL DEFAULT 0,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  last_ip       TEXT,
  clock_skew_ms INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_devices_license ON devices(license_id);
CREATE INDEX IF NOT EXISTS idx_devices_fp ON devices(fp);
CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS releases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version     TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'stable',
  notes       TEXT,
  mandatory   INTEGER NOT NULL DEFAULT 0,
  file_name   TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  downloads   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  pass_hash     TEXT NOT NULL,
  totp_secret   TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  totp_last     INTEGER NOT NULL DEFAULT -1,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login    INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  ua         TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  details TEXT,
  ip      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
CREATE TABLE IF NOT EXISTS commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                       -- reset_password | full_reset
  params      TEXT NOT NULL DEFAULT '{}',          -- never holds a plain password
  label       TEXT,                                -- safe summary for the panel
  status      TEXT NOT NULL DEFAULT 'pending',     -- pending | done | failed | cancelled
  result      TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  done_at     INTEGER,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_commands_device ON commands(device_id, status);
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`);

// Additive migrations for databases created by an older version.
for (const sql of [
  'ALTER TABLE devices ADD COLUMN users_json TEXT',
  'ALTER TABLE devices ADD COLUMN offline_days INTEGER',
]) {
  try { db.exec(sql); } catch { /* column already exists */ }
}

const DEFAULT_SETTINGS = {
  heartbeat_seconds: '300',     // online check every 5 minutes
  max_clock_skew_minutes: '30', // lock if PC clock differs from server by more than this
  default_grace_hours: '72',    // offline limit for new licenses
  announcement: '',             // message shown in all apps
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings (k, v) VALUES (?, ?)').run(k, v);
}

function getSetting(k) {
  const r = db.prepare('SELECT v FROM settings WHERE k = ?').get(k);
  return r ? r.v : DEFAULT_SETTINGS[k];
}
function setSetting(k, v) {
  db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

function audit(actor, action, target, details, ip) {
  db.prepare('INSERT INTO audit (at, actor, action, target, details, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), actor, action, target == null ? null : String(target),
      details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)), ip || null);
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// housekeeping
function prune() {
  const now = Date.now();
  db.prepare('DELETE FROM nonces WHERE created_at < ?').run(now - 3 * 24 * 3600e3);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}
prune();
setInterval(prune, 3600e3).unref();

module.exports = { db, getSetting, setSetting, audit, tx };
