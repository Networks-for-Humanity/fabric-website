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
const store = require('./github-store');
const crawler = require('./dedi-crawler');
const guard = require('./guard');

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
// A person fills this form once. Anything past a couple of corrections is not
// a person, so the per-IP allowance is deliberately small. This is one
// long-running process, so the count is exact — no shared store needed.
const RATE_MAX       = Number(process.env.RATE_MAX || 5);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_SECONDS || 600) * 1000;
// Ceiling on how far the list can grow in an hour regardless of source — the
// backstop for a flood spread across many addresses.
const HOURLY_MAX     = Number(process.env.HOURLY_MAX || 200);
// Set to 0 to record domains that do not resolve (see server/guard.js).
const REQUIRE_DNS    = process.env.REQUIRE_DNS !== '0';

/* Domain normalisation and validation live in guard.js so the rules exist in
   exactly one place. The form has its own copy for instant feedback; this one
   is the rule. */
const { normalise, FQDN_RE } = guard;

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
    scheduleSync();
    scheduleCrawlRefresh();
    return { stored: true, duplicate: false };
  });
}

/* ------------------------------------------------------------------ *
 * Mirroring the list into the private data repo
 *
 * The local write above already succeeded by the time we get here, so
 * this is allowed to be slow and to fail. Syncs are debounced, which
 * turns a burst of submissions into one commit instead of one per
 * domain, and retried with backoff so a GitHub outage delays the mirror
 * rather than dropping anything.
 * ------------------------------------------------------------------ */

const SYNC_DEBOUNCE_MS = Number(process.env.SYNC_DEBOUNCE_MS || 2000);
const SYNC_MAX_BACKOFF_MS = 5 * 60 * 1000;

let syncTimer = null;
let syncing = false;
let pending = false;
let backoff = 0;

function scheduleSync(delay = SYNC_DEBOUNCE_MS) {
  if (!store.enabled) return;
  pending = true;
  if (syncTimer || syncing) return;
  syncTimer = setTimeout(runSync, delay);
  syncTimer.unref();
}

async function runSync() {
  syncTimer = null;
  if (syncing) return;
  syncing = true;

  try {
    while (pending) {
      pending = false;
      const snapshot = Array.from(known);
      const result = await store.syncUnion(snapshot);
      if (result.added > 0) {
        console.log(`[fabric] synced ${result.added} domain(s) to ${store.REPO} (${result.total} on file)`);
      }
      backoff = 0;
    }
  } catch (err) {
    pending = true;
    backoff = backoff ? Math.min(backoff * 2, SYNC_MAX_BACKOFF_MS) : 15000;
    console.error(`[fabric] sync failed, retrying in ${Math.round(backoff / 1000)}s:`, err.message);
    syncTimer = setTimeout(runSync, backoff);
    syncTimer.unref();
  } finally {
    syncing = false;
  }
}

/**
 * Pull whatever is already upstream at boot and merge it in, so a fresh
 * host (or a second instance) does not re-add domains that are already
 * recorded, and so the local file reflects the full list.
 */
async function reconcileAtStartup() {
  if (!store.enabled) return;
  try {
    const remote = await store.fetchList();
    const missingLocally = remote.domains.filter((d) => !known.has(d));
    if (missingLocally.length) {
      await enqueue(async () => {
        await fsp.appendFile(DOMAINS_FILE, missingLocally.join('\n') + '\n', 'utf8');
        for (const d of missingLocally) known.add(d);
      });
    }
    console.log(`[fabric] data repo: ${store.REPO}:${store.BRANCH}/${store.DATA_PATH} (${remote.domains.length} upstream)`);
    if (known.size > remote.domains.length) scheduleSync(0);
  } catch (err) {
    console.error('[fabric] could not read the data repo at startup:', err.message);
    scheduleSync();
  }
}

/* ------------------------------------------------------------------ *
 * Telling the dedi-crawler to refresh after a write
 *
 * Debounced the same way as the git mirror: a burst of submissions
 * should trigger one full crawl, not one per domain. The local write
 * has already succeeded by the time this runs, so it is fine for this
 * to be slow or to fail — it just retries with backoff.
 * ------------------------------------------------------------------ */

const CRAWLER_DEBOUNCE_MS = Number(process.env.DEDI_CRAWLER_DEBOUNCE_MS || 2000);
const CRAWLER_MAX_BACKOFF_MS = 5 * 60 * 1000;

let crawlerTimer = null;
let crawlerRunning = false;
let crawlerPending = false;
let crawlerBackoff = 0;

function scheduleCrawlRefresh(delay = CRAWLER_DEBOUNCE_MS) {
  if (!crawler.enabled) return;
  crawlerPending = true;
  if (crawlerTimer || crawlerRunning) return;
  crawlerTimer = setTimeout(runCrawlRefresh, delay);
  crawlerTimer.unref();
}

async function runCrawlRefresh() {
  crawlerTimer = null;
  if (crawlerRunning) return;
  crawlerRunning = true;

  try {
    while (crawlerPending) {
      crawlerPending = false;
      await crawler.triggerFullCrawl();
      crawlerBackoff = 0;
      console.log('[fabric] triggered dedi-crawler full refresh');
    }
  } catch (err) {
    crawlerPending = true;
    crawlerBackoff = crawlerBackoff ? Math.min(crawlerBackoff * 2, CRAWLER_MAX_BACKOFF_MS) : 15000;
    console.error(`[fabric] dedi-crawler refresh failed, retrying in ${Math.round(crawlerBackoff / 1000)}s:`, err.message);
    crawlerTimer = setTimeout(runCrawlRefresh, crawlerBackoff);
    crawlerTimer.unref();
  } finally {
    crawlerRunning = false;
  }
}

/* ------------------------------------------------------------------ *
 * Rate limiting — the endpoint is public and writes to disk
 * ------------------------------------------------------------------ */

const buckets = new Map();

/** Global ceiling: per-IP limits do nothing against a spread-out flood. */
const hourly = { count: 0, resetAt: 0 };
function underHourlyCap(now) {
  if (now > hourly.resetAt) { hourly.count = 0; hourly.resetAt = now + 60 * 60 * 1000; }
  if (hourly.count >= HOURLY_MAX) return false;
  hourly.count += 1;
  return true;
}

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
    res.setHeader('Retry-After', String(Math.ceil(RATE_WINDOW_MS / 1000)));
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

  let payload;
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      return sendJson(req, res, 400, { error: 'Expected JSON.' });
    }
  } else {
    payload = Object.fromEntries(new URLSearchParams(raw));
  }

  const fqdn = payload && payload.fqdn;
  if (typeof fqdn !== 'string' || fqdn.length > MAX_FQDN_LEN * 2) {
    return sendJson(req, res, 400, { error: 'Send a single fqdn field.' });
  }

  const domain = normalise(fqdn);
  if (!domain || domain.length > MAX_FQDN_LEN || !FQDN_RE.test(domain)) {
    return sendJson(req, res, 422, { error: 'That is not a valid domain.' });
  }

  /* Bot tells. Answer 200 rather than an error: naming the check that caught
     them just tells whoever is probing what to work around, and there is no
     human on the other end to inform. */
  const automated = guard.looksAutomated(payload);
  if (automated) {
    console.warn(`[fabric] dropped ${domain} (${automated}) from ${clientIp(req)}`);
    return sendJson(req, res, 200, { domain, stored: false });
  }

  /* Already on file — answer before spending a DNS lookup on it. */
  if (known.has(domain)) {
    return sendJson(req, res, 200, { domain, stored: false, duplicate: true });
  }

  if (REQUIRE_DNS) {
    const { exists, reason } = await guard.domainExists(domain);
    if (!exists) {
      console.warn(`[fabric] dropped ${domain} (${reason}) from ${clientIp(req)}`);
      return sendJson(req, res, 200, { domain, stored: false });
    }
  }

  if (!underHourlyCap(Date.now())) {
    console.error(`[fabric] hourly cap of ${HOURLY_MAX} reached — dropping ${domain}`);
    return sendJson(req, res, 200, { domain, stored: false });
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
    return sendJson(req, res, 200, {
      ok: true,
      domains: known.size,
      repo: store.enabled ? `${store.REPO}:${store.BRANCH}/${store.DATA_PATH}` : null,
      syncPending: store.enabled ? (pending || syncing) : false
    });
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
  console.log(`[fabric] local file: ${DOMAINS_FILE} (${known.size} on file)`);
  console.log(`[fabric] static: ${SERVE_STATIC ? STATIC_DIR : 'disabled'}`);
  if (!store.enabled) {
    console.log('[fabric] data repo: disabled (set DATA_REPO_TOKEN to mirror the list)');
  }
  if (!crawler.enabled) {
    console.log('[fabric] dedi-crawler: disabled (set DEDI_CRAWLER_URL and DEDI_CRAWLER_TOKEN to trigger refreshes)');
  }
  reconcileAtStartup();
});
