'use strict';
// Tiny dependency-free router + helpers on top of node:http
const cfg = require('./config');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function clientIp(req) {
  if (cfg.TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  req.rawBody = buf;
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'BAD_JSON');
  }
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const h = { ...SEC_HEADERS, 'Cache-Control': 'no-store', ...headers };
  if (cfg.COOKIE_SECURE) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  let data = body;
  if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') {
    data = JSON.stringify(body);
    h['Content-Type'] = 'application/json; charset=utf-8';
  }
  res.writeHead(status, h);
  res.end(data);
}

// ---- Router -------------------------------------------------------------
class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  patch(p, ...h) { this.add('PATCH', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }
}

// ---- Rate limiter (fixed window, in memory) -------------------------------
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  if (b.count > max) {
    throw new HttpError(429, 'RATE_LIMITED', `Bohot zyada koshishein. ${Math.ceil((b.reset - now) / 60000)} minute baad try karein.`);
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60e3).unref();

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

module.exports = { HttpError, clientIp, readBody, readJson, send, Router, rateLimit, parseCookies, SEC_HEADERS };
