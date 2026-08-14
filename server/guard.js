'use strict';

/**
 * Spam filtering for a public, unauthenticated form.
 *
 * Layered, cheapest first. None of it is a wall — the point is to make junk
 * expensive enough that a drive-by isn't worth it, while never rejecting
 * someone with a real domain.
 *
 * Filenames starting with _ are not routed by Vercel, so this is a plain
 * module rather than an endpoint.
 */

const dns = require('dns').promises;

/* ------------------------------------------------------------------ *
 * 1. Bot tells
 *
 * A hidden field no human can see, and how long the page was open before
 * submitting. These only catch bots that render the page and fill forms
 * generically — something posting JSON straight at the endpoint sends
 * neither, which is what the layers below are for.
 * ------------------------------------------------------------------ */

const MIN_FILL_MS = 1200;

function looksAutomated(payload) {
  // Honeypot: hidden on the page, so anything in it came from a machine.
  if (payload && typeof payload.website === 'string' && payload.website.trim() !== '') {
    return 'honeypot';
  }
  // Implausibly fast. Absent is fine — API clients don't send it and we
  // don't want to break them.
  const elapsed = Number(payload && payload.elapsed);
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_MS) {
    return 'too-fast';
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 2. Does the domain exist?
 *
 * The strongest filter available, and it costs one DNS lookup. Onboarding
 * requires hosting a file at the domain or proving control by DNS record,
 * so a domain that doesn't resolve cannot complete the process — rejecting
 * it loses nothing real, while invented spam domains fail immediately.
 *
 * Fails OPEN on resolver trouble. If DNS is broken that is our problem,
 * and it must never turn into rejecting every genuine signup. Only a
 * definitive "this does not exist" rejects.
 * ------------------------------------------------------------------ */

const NONEXISTENT = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);
const DNS_TIMEOUT_MS = 3000;

async function domainExists(fqdn) {
  const lookups = [
    dns.resolveNs(fqdn),
    dns.resolve4(fqdn),
    dns.resolve6(fqdn),
    dns.resolveMx(fqdn)
  ];

  const settled = await Promise.race([
    Promise.allSettled(lookups),
    new Promise((resolve) => setTimeout(() => resolve(null), DNS_TIMEOUT_MS))
  ]);

  if (settled === null) return { exists: true, reason: 'dns-timeout' };   // fail open

  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value && r.value.length) {
      return { exists: true, reason: 'resolved' };
    }
  }

  // Nothing resolved. Only call it fake if the resolver was definitive —
  // a SERVFAIL or refusal is our side failing, not their domain missing.
  const definitive = settled.every(
    (r) => r.status === 'fulfilled' || (r.reason && NONEXISTENT.has(r.reason.code))
  );

  return definitive
    ? { exists: false, reason: 'nxdomain' }
    : { exists: true, reason: 'resolver-error' };  // fail open
}

/* ------------------------------------------------------------------ *
 * 3. Domain normalisation and validation
 * ------------------------------------------------------------------ */

const FQDN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Reduce whatever was typed to a bare hostname. */
function normalise(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')  // scheme
    .replace(/^[^@/]*@/, '')                 // credentials
    .split(/[/?#]/)[0]                       // path, query, fragment
    .replace(/:\d+$/, '')                    // port
    .replace(/\.$/, '');                     // trailing root label
}

module.exports = { looksAutomated, domainExists, normalise, FQDN_RE, MIN_FILL_MS };
