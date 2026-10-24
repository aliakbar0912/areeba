'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const cfg = require('./lib/config');
const C = require('./lib/crypto');
const { Router, send, readJson, HttpError, clientIp, SEC_HEADERS } = require('./lib/http');

C.ensureKeys();
const { db: _db, audit: _audit } = require('./lib/db'); // init schema

// First admin from environment (handy on Dokploy/Docker where there's no
// terminal step): only used while NO admin exists yet.
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
  const count = _db.prepare('SELECT COUNT(*) c FROM admins').get().c;
  if (count === 0) {
    const u = process.env.ADMIN_USERNAME.toLowerCase().trim();
    if (process.env.ADMIN_PASSWORD.length < 10) {
      console.error('ADMIN_PASSWORD must be at least 10 characters — admin not created.');
    } else {
      _db.prepare('INSERT INTO admins (username, pass_hash, created_at) VALUES (?,?,?)').run(u, C.hashPassword(process.env.ADMIN_PASSWORD), Date.now());
      _audit('env', 'admin.create', u, null, 'bootstrap');
      console.log(`Admin "${u}" created from environment.`);
    }
  }
}
console.log('Signing public key (must match the app\'s license-config.json):\n' + C.keys().signPubPem);

const router = new Router();
require('./routes/client')(router);
require('./routes/admin')(router);

// ---- static admin panel --------------------------------------------------
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = rel.replace(/\.\./g, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // SPA fallback
    const idx = path.join(PUBLIC, 'index.html');
    if (fs.existsSync(idx)) {
      const html = fs.readFileSync(idx);
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    return send(res, 404, 'Not found');
  }
  const ext = path.extname(file).toLowerCase();
  const cache = 'no-store';
  send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let u;
  try { u = new URL(req.url, 'http://x'); } catch { return send(res, 400, { ok: false, code: 'BAD_URL' }); }
  const pathname = u.pathname;

  const ctx = {
    query: Object.fromEntries(u.searchParams),
    params: {},
    body: {},
    json(status, body, headers) { send(res, status, body, headers); },
  };

  try {
    if (pathname === '/healthz') return send(res, 200, { ok: true, time: Date.now() });

    const m = router.match(req.method, pathname);
    if (m) {
      ctx.params = m.params;
      // parse JSON for mutating API calls (not for raw binary upload route)
      const isUpload = pathname === '/api/admin/releases' && req.method === 'POST';
      if (!['GET', 'HEAD', 'DELETE'].includes(req.method) && !isUpload) {
        ctx.body = await readJson(req, 256 * 1024);
      }
      for (const h of m.route.handlers) {
        await h(req, res, ctx);
        if (res.headersSent) break;
      }
      if (!res.headersSent) send(res, 204);
      return;
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);
    return send(res, 404, { ok: false, code: 'NOT_FOUND' });
  } catch (e) {
    if (e instanceof HttpError) {
      return send(res, e.status, { ok: false, code: e.code, error: e.message });
    }
    console.error('[err]', req.method, pathname, e && e.stack ? e.stack : e);
    return send(res, 500, { ok: false, code: 'SERVER_ERROR', error: 'Server error.' });
  } finally {
    if (process.env.LOG === '1') {
      console.log(`${new Date().toISOString()} ${clientIp(req)} ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

server.listen(cfg.PORT, cfg.HOST, () => {
  console.log(`Shifa License Server → http://${cfg.HOST}:${cfg.PORT}`);
  console.log(`Data dir: ${cfg.DATA_DIR}`);
});
