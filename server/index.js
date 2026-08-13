'use strict';

/**
 * fabric onboarding backend
 *
 * One job: accept a domain from the onboarding form and append it to
 * fabric.domains.txt, one domain per line, no duplicates.
 *
 * Also serves the static site so local development is a single command and a
 * production deploy can be a single host. Set SERVE_STATIC=0 to run as a bare
 * API behind an existing static host.
 *
 * No dependencies — node server/index.js is the whole thing.
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const PORT           = Number(process.env.PORT || 8787);
const HOST           = process.env.HOST || '0.0.0.0';
const DOMAINS_FILE   = path.resolve(process.env.DOMAINS_FILE || path.join(ROOT, 'fabric.domains.txt'));
const STATIC_DIR     = path.resolve(process.env.STATIC_DIR || ROOT);
const SERVE_STATIC   = process.env.SERVE_STATIC !== '0';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';   // e.g. https://fabric.nfh.global
const TRUST_PROXY    = process.env.TRUST_PROXY === '1';    // read X-Forwarded-For

const MAX_BODY_BYTES = 2048;
const MAX_FQDN_LEN   = 253;
const RATE_MAX       = 20;             // submissions per IP...
const RATE_WINDOW_MS = 10 * 60 * 1000; // ...per ten minutes

/* ------------------------------------------------------------------ *
 * Domain handling — the same normalisation and validation the form
 * does, repeated here because the client's copy is a convenience and
 * this one is the rule.
 * ------------------------------------------------------------------ */

const FQDN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function normalise(raw) {
  let v = String(raw || '').trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');  // scheme
  v = v.replace(/^[^@/]*@/, '');                 // userinfo
  v = v.split(/[/?#]/)[0];                       // path, query, fragment
  v = v.replace(/:\d+$/, '');                    // port
  v = v.replace(/\.$/, '');                      // root label
  return v;
}

/* ------------------------------------------------------------------ *
 * The file
 * ------------------------------------------------------------------ */

/** Domains already on file, so a repeat submission is a no-op. */
const known = new Set();

function loadExisting() {
  let text = '';
  try {
    text = fs.readFileSync(DOMAINS_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(path.dirname(DOMAINS_FILE), { recursive: true });
    fs.writeFileSync(DOMAINS_FILE, '', 'utf8');
  }
  for (const line of text.split('\n')) {
    const d = line.trim();
    if (d) known.add(d);
  }
}

/**
 * Appends are serialised through one promise chain. Node is single
 * threaded, but two concurrent requests can still interleave a
 * read-check-append, which would put the same domain on file twice.
 */
let writeQueue = Promise.resolve();

function enqueue(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(() => {}, () => {});
  return run;
}

function record(fqdn) {
  return enqueue(async () => {
    if (known.has(fqdn)) return { stored: false, duplicate: true };
    await fsp.appendFile(DOMAINS_FILE, fqdn + '\n', 'utf8');
    known.add(fqdn);
    return { stored: true, duplicate: false };
  });
}

/* ------------------------------------------------------------------ *
 * Rate limiting — the endpoint is public and writes to disk
 * ------------------------------------------------------------------ */

const buckets = new Map();

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now > b.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  b.count += 1;
  return b.count > RATE_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now > b.resetAt) buckets.delete(ip);
}, RATE_WINDOW_MS).unref();

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

function corsHeaders(req) {
  if (!ALLOWED_ORIGIN) return {};
  const origin = req.headers.origin;
  if (origin !== ALLOWED_ORIGIN) return {};
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...corsHeaders(req)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop reading, but leave the socket alive long enough to answer —
        // destroying it here would hand the client a reset instead of a 413.
        aborted = true;
        req.pause();
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleSubmit(req, res) {
  if (rateLimited(clientIp(req))) {
    return sendJson(req, res, 429, { error: 'Too many submissions. Try again shortly.' });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    const status = err.status || 400;
    return sendJson(req, res, status, {
      error: status === 413 ? 'That request was too large.' : 'Could not read the request body.'
    });
  }

  let fqdn;
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try {
      fqdn = JSON.parse(raw || '{}').fqdn;
    } catch {
      return sendJson(req, res, 400, { error: 'Expected JSON.' });
    }
  } else {
    fqdn = new URLSearchParams(raw).get('fqdn');
  }

  if (typeof fqdn !== 'string' || fqdn.length > MAX_FQDN_LEN * 2) {
    return sendJson(req, res, 400, { error: 'Send a single fqdn field.' });
  }

  const domain = normalise(fqdn);
  if (!domain || domain.length > MAX_FQDN_LEN || !FQDN_RE.test(domain)) {
    return sendJson(req, res, 422, { error: 'That is not a valid domain.' });
  }

  try {
    const result = await record(domain);
    return sendJson(req, res, 200, { domain, ...result });
  } catch (err) {
    console.error('[fabric] write failed:', err);
    return sendJson(req, res, 500, { error: 'Could not record the domain.' });
  }
}

/* ---- static files ---- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.txt':  'text/plain; charset=utf-8'
};

function resolveStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const target = path.resolve(STATIC_DIR, '.' + decoded);
  if (target !== STATIC_DIR && !target.startsWith(STATIC_DIR + path.sep)) return null;

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    const index = path.join(target, 'index.html');
    return fs.existsSync(index) ? index : null;
  }
  return target;
}

function serveStatic(req, res, pathname) {
  const file = resolveStatic(pathname);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found\n');
  }
  // The domains file is data, not a public asset.
  if (path.resolve(file) === DOMAINS_FILE) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden\n');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
  });
  fs.createReadStream(file)
    .on('error', () => { res.destroy(); })
    .pipe(res);
}

/* ---- router ---- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/domains') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }
    if (req.method !== 'POST') {
      return sendJson(req, res, 405, { error: 'POST only.' });
    }
    return handleSubmit(req, res);
  }

  if (pathname === '/api/health') {
    return sendJson(req, res, 200, { ok: true, domains: known.size });
  }

  if (SERVE_STATIC && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveStatic(req, res, pathname);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found\n');
});

loadExisting();
server.listen(PORT, HOST, () => {
  console.log(`[fabric] listening on http://${HOST}:${PORT}`);
  console.log(`[fabric] domains file: ${DOMAINS_FILE} (${known.size} on file)`);
  console.log(`[fabric] static: ${SERVE_STATIC ? STATIC_DIR : 'disabled'}`);
});
