'use strict';
// Usage: node scripts/create-admin.js <username> [password]
// If password omitted, a strong one is generated and printed once.
const crypto = require('node:crypto');
const { db, audit } = require('../lib/db');
const C = require('../lib/crypto');

const username = (process.argv[2] || '').toLowerCase().trim();
if (!username) { console.error('Usage: node scripts/create-admin.js <username> [password]'); process.exit(1); }

let password = process.argv[3];
let generated = false;
if (!password) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  password = Array.from(crypto.randomBytes(16)).map((b) => A[b % A.length]).join('');
  generated = true;
}

const existing = db.prepare('SELECT id FROM admins WHERE username=?').get(username);
const now = Date.now();
if (existing) {
  db.prepare('UPDATE admins SET pass_hash=?, failed_count=0, locked_until=0 WHERE id=?').run(C.hashPassword(password), existing.id);
  console.log(`Updated password for admin "${username}".`);
} else {
  db.prepare('INSERT INTO admins (username, pass_hash, created_at) VALUES (?,?,?)').run(username, C.hashPassword(password), now);
  console.log(`Created admin "${username}".`);
}
audit('cli', existing ? 'admin.reset' : 'admin.create', username, null, 'localhost');
if (generated) console.log(`\n  Password: ${password}\n\n  (Ye password ab dobara nahi dikhega — mehfooz jagah save kar lein.)`);
process.exit(0);
