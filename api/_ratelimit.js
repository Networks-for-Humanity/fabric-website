/**
 * Rate limiting for a serverless function.
 *
 * The hard part: a long-running server keeps counters in memory, but every
 * function invocation may land on a different instance, so in-memory state
 * is partial by nature. Two tiers, and the function picks the best available:
 *
 *   1. A shared counter store (Vercel KV / Upstash Redis), if configured.
 *      Accurate across every instance. Spoken to over its REST API with
 *      plain fetch, so it stays dependency-free.
 *   2. In-memory, otherwise. A warm instance holds its map between
 *      invocations, so this does stop someone hammering the endpoint — but
 *      traffic spread across instances, or arriving after a cold start,
 *      slips through.
 *
 * Neither replaces Vercel Firewall's rate limiting, which runs in front of
 * the function and is the only layer that costs nothing to trip. See
 * api/README.md.
 */

const WINDOW_SECONDS = Number(process.env.RATE_WINDOW_SECONDS || 600);
const MAX_PER_WINDOW = Number(process.env.RATE_MAX || 5);

const KV_URL   = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const usingSharedStore = Boolean(KV_URL && KV_TOKEN);

/** Vercel populates x-forwarded-for; the client is the first entry. */
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

/* ---------------- tier 1: shared counter ---------------- */

/**
 * INCR the window's counter and set its expiry on first write. Pipelined so
 * it is a single round trip. EXPIRE uses NX so a long-running window is not
 * repeatedly extended, which would let a slow trickle hold someone out
 * forever.
 */
async function countShared(key) {
  const res = await fetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, String(WINDOW_SECONDS), 'NX']
    ])
  });
  if (!res.ok) throw new Error(`kv ${res.status}`);
  const out = await res.json();
  const count = Number(out?.[0]?.result);
  if (!Number.isFinite(count)) throw new Error('kv returned no count');
  return count;
}

/* ---------------- tier 2: in-memory ---------------- */

/** Survives between invocations on a warm instance; empty after a cold start. */
const local = new Map();

function countLocal(key, now) {
  const entry = local.get(key);
  if (!entry || now > entry.resetAt) {
    local.set(key, { count: 1, resetAt: now + WINDOW_SECONDS * 1000 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

/** Keep the map from growing without bound on a long-lived instance. */
function prune(now) {
  if (local.size < 5000) return;
  for (const [k, v] of local) if (now > v.resetAt) local.delete(k);
}

/* ---------------- entry point ---------------- */

/**
 * Returns { allowed, count, retryAfter, tier }.
 *
 * Fails OPEN if the shared store is unreachable: a broken counter must not
 * become an outage that rejects every genuine submission. It falls back to
 * the in-memory count rather than letting the request through unchecked.
 */
export async function rateLimit(req, now = Date.now()) {
  const ip = clientIp(req);
  const window = Math.floor(now / (WINDOW_SECONDS * 1000));
  const key = `onboarding:rl:${ip}:${window}`;

  let count;
  let tier;

  if (usingSharedStore) {
    try {
      count = await countShared(key);
      tier = 'shared';
    } catch (err) {
      console.warn('rate limit store unavailable, falling back to memory:', err.message);
      count = countLocal(key, now);
      tier = 'memory-fallback';
    }
  } else {
    count = countLocal(key, now);
    tier = 'memory';
  }

  prune(now);

  return {
    allowed: count <= MAX_PER_WINDOW,
    count,
    tier,
    retryAfter: WINDOW_SECONDS - Math.floor((now % (WINDOW_SECONDS * 1000)) / 1000)
  };
}

export const limits = { WINDOW_SECONDS, MAX_PER_WINDOW };
