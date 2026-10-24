'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Minimal .env loader (no dependencies)
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const ROOT = path.resolve(__dirname, '..');
loadEnv(path.join(ROOT, '.env'));

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');

module.exports = {
  ROOT,
  APP_ID: process.env.APP_ID || 'shifa-medical-store',
  PORT: parseInt(process.env.PORT || '8787', 10),
  HOST: process.env.HOST || '127.0.0.1',
  DATA_DIR,
  DB_FILE: path.join(DATA_DIR, 'license.db'),
  KEYS_DIR: path.join(DATA_DIR, 'keys'),
  RELEASES_DIR: path.join(DATA_DIR, 'releases'),
  // Set COOKIE_SECURE=0 only for local testing over plain http
  COOKIE_SECURE: process.env.COOKIE_SECURE !== '0',
  // When running behind Caddy/Nginx on the same machine
  TRUST_PROXY: process.env.TRUST_PROXY !== '0',
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN || '', // e.g. https://license.example.com
  MAX_UPLOAD_BYTES: parseInt(process.env.MAX_UPLOAD_MB || '600', 10) * 1024 * 1024,
  SESSION_HOURS: parseInt(process.env.SESSION_HOURS || '12', 10),
};
