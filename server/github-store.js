'use strict';

/**
 * Git-backed storage for the domains list.
 *
 * The list lives in a private repository, one domain per line, updated
 * through the GitHub contents API. Git gives durability, history and an
 * audit trail for free, which a file on one host does not.
 *
 * The local file is still written first and is authoritative for
 * responses — this pushes the accumulated list up in the background, so a
 * GitHub outage delays the mirror rather than losing a submission.
 */

const API_BASE = (process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, '');
/* Deliberately not GITHUB_TOKEN: that name is ambient in Actions, Codespaces
   and most CI, and inheriting an unrelated credential would silently point
   this at a repo it has no business writing to. Opting in is explicit. */
const TOKEN    = process.env.DATA_REPO_TOKEN || '';
const REPO     = process.env.DATA_REPO || 'Anusree-J/fabric-onboarding';
const BRANCH   = process.env.DATA_BRANCH || 'main';
const DATA_PATH = process.env.DATA_PATH || 'fabric.domains.txt';

const enabled = Boolean(TOKEN && REPO);

function contentsUrl() {
  const [owner, repo] = REPO.split('/');
  const path = DATA_PATH.split('/').map(encodeURIComponent).join('/');
  return `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`;
}

function headers() {
  return {
    'Authorization': `Bearer ${TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'fabric-onboarding'
  };
}

/**
 * Reads the list as it currently stands upstream.
 * A missing file (fresh repo) is not an error — it is an empty list.
 */
async function fetchList() {
  const res = await fetch(`${contentsUrl()}?ref=${encodeURIComponent(BRANCH)}`, { headers: headers() });

  if (res.status === 404) return { domains: [], sha: null };
  if (!res.ok) {
    throw new Error(`GitHub read failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
  }

  const body = await res.json();
  const text = Buffer.from(body.content || '', body.encoding || 'base64').toString('utf8');
  const domains = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return { domains, sha: body.sha };
}

/**
 * Writes the list back. `sha` must be the blob sha the content was read
 * at; GitHub rejects the write if the file moved on in the meantime,
 * which is the concurrency check that keeps two writers from clobbering
 * each other.
 */
async function pushList(domains, sha, message) {
  const payload = {
    message,
    content: Buffer.from(domains.join('\n') + '\n', 'utf8').toString('base64'),
    branch: BRANCH
  };
  if (sha) payload.sha = sha;

  const res = await fetch(contentsUrl(), {
    method: 'PUT',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (res.status === 409 || res.status === 422) {
    const err = new Error('GitHub write conflict');
    err.conflict = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`GitHub write failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
  }

  const body = await res.json();
  return body.content && body.content.sha;
}

/**
 * Merges `domains` into whatever is upstream and pushes the union.
 * Retries on conflict, since a conflict means someone else's write landed
 * first and ours simply needs rebasing onto it.
 */
async function syncUnion(domains, { retries = 3 } = {}) {
  let attempt = 0;
  for (;;) {
    const remote = await fetchList();
    const union = remote.domains.slice();
    const seen = new Set(remote.domains);
    let added = 0;

    for (const d of domains) {
      if (seen.has(d)) continue;
      seen.add(d);
      union.push(d);
      added += 1;
    }

    if (added === 0) return { added: 0, total: union.length };

    const message = added === 1
      ? `Add ${union[union.length - 1]}`
      : `Add ${added} domains`;

    try {
      await pushList(union, remote.sha, message);
      return { added, total: union.length };
    } catch (err) {
      if (!err.conflict || attempt >= retries) throw err;
      attempt += 1;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
}

module.exports = { enabled, fetchList, syncUnion, REPO, BRANCH, DATA_PATH };
