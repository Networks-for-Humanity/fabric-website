/**
 * POST /api/domains
 *
 * Takes the domain from the onboarding form and appends it to
 * fabric.domains.txt in the fabric-onboarding repo. That's the whole job.
 *
 * Environment (Vercel project settings):
 *   DATA_REPO_TOKEN  fine-grained PAT, Contents: read and write, that repo only
 *   DATA_REPO        Networks-for-Humanity/fabric-onboarding
 *   DATA_PATH        fabric.domains.txt
 *   DATA_BRANCH      main
 *   SITE_ORIGIN      https://fabric.nfh.global
 *   MAX_DOMAINS      ceiling on total entries (default 5000)
 */

import { looksAutomated, domainExists, normalise, FQDN_RE } from './_guard.js';
import { rateLimit } from './_ratelimit.js';

const MAX_FQDN_LEN = 253;

const cfg = () => ({
  token:  process.env.DATA_REPO_TOKEN,
  repo:   process.env.DATA_REPO   || 'Networks-for-Humanity/fabric-onboarding',
  file:   process.env.DATA_PATH   || 'fabric.domains.txt',
  branch: process.env.DATA_BRANCH || 'main',
  origin: process.env.SITE_ORIGIN || 'https://fabric.nfh.global',
  max:    Number(process.env.MAX_DOMAINS || 5000)
});

const ghHeaders = (c) => ({
  Authorization: `Bearer ${c.token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'fabric-onboarding'
});

const contentsUrl = (c) => `https://api.github.com/repos/${c.repo}/contents/${c.file}`;

/**
 * Append one domain. Reads, checks, writes back against the sha it read —
 * GitHub rejects the write if the file moved on meanwhile, which is what
 * stops two simultaneous submissions from clobbering each other. On
 * rejection we re-read and try again.
 *
 * There is no local cache here: each invocation is cold-ish and stateless,
 * so the file itself is the only source of truth. That also makes it the
 * place to enforce the ceiling.
 */
async function appendDomain(c, domain) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const read = await fetch(`${contentsUrl(c)}?ref=${c.branch}`, { headers: ghHeaders(c) });

    let text = '';
    let sha;
    if (read.status === 200) {
      const body = await read.json();
      text = Buffer.from(body.content, 'base64').toString('utf8');
      sha = body.sha;
    } else if (read.status !== 404) {
      // 404 just means the file doesn't exist yet.
      throw new Error(`read failed: ${read.status}`);
    }

    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.includes(domain)) return { added: false, duplicate: true, total: lines.length };

    // Stateless stand-in for a rate limiter: however the flood arrives, the
    // list cannot grow past this.
    if (lines.length >= c.max) return { added: false, capped: true, total: lines.length };

    lines.push(domain);

    const write = await fetch(contentsUrl(c), {
      method: 'PUT',
      headers: { ...ghHeaders(c), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Add ${domain}`,
        content: Buffer.from(lines.join('\n') + '\n', 'utf8').toString('base64'),
        branch: c.branch,
        ...(sha ? { sha } : {})
      })
    });

    if (write.ok) return { added: true, total: lines.length };
    if (write.status === 409 || write.status === 422) continue;  // someone beat us to it
    throw new Error(`write failed: ${write.status}`);
  }
  throw new Error('write kept conflicting');
}

export default async function handler(req, res) {
  const c = cfg();

  res.setHeader('Access-Control-Allow-Origin', c.origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (!c.token) {
    console.error('DATA_REPO_TOKEN is not set');
    return res.status(500).json({ error: 'Not configured.' });
  }

  /* Before any work: reject floods cheaply, and before touching DNS or
     GitHub on someone else's behalf. */
  const rl = await rateLimit(req);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: 'Too many submissions. Try again shortly.' });
  }

  const payload = typeof req.body === 'string'
    ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
    : (req.body || {});

  // Validate here, not just in the browser — the form's copy of this logic
  // is a convenience, this one is the rule. The character set it permits is
  // also what makes newline injection into the file impossible.
  const domain = normalise(payload.fqdn);
  if (!domain || domain.length > MAX_FQDN_LEN || !FQDN_RE.test(domain)) {
    return res.status(422).json({ error: 'That is not a valid domain.' });
  }

  /* Bot tells. Answer 200 rather than an error: a rejection message tells
     whoever is probing which check to work around, and there is no human
     here to inform. Indistinguishable from a duplicate. */
  const automated = looksAutomated(payload);
  if (automated) {
    console.warn(`dropped ${domain} (${automated})`);
    return res.status(200).json({ domain, added: false });
  }

  if (process.env.REQUIRE_DNS !== '0') {
    const { exists, reason } = await domainExists(domain);
    if (!exists) {
      console.warn(`dropped ${domain} (${reason})`);
      return res.status(200).json({ domain, added: false });
    }
  }

  try {
    const result = await appendDomain(c, domain);
    if (result.capped) console.error(`cap of ${c.max} reached — dropped ${domain}`);
    return res.status(200).json({ domain, ...result });
  } catch (err) {
    console.error('append failed:', err.message);
    return res.status(502).json({ error: 'Could not record the domain.' });
  }
}
