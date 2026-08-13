/**
 * fabric onboarding — domain collector
 *
 * Takes the domain from the onboarding form and appends it to a text file
 * in a GitHub repo. That's the whole job.
 *
 * Runs on Cloudflare Workers. It's a standard fetch handler, so it ports to
 * Vercel/Netlify edge functions with little more than a different export.
 *
 * Configure (wrangler.toml / dashboard):
 *   DATA_REPO    Networks-for-Humanity/fabric-onboarding
 *   DATA_PATH    fabric.domains.txt
 *   DATA_BRANCH  main
 *   SITE_ORIGIN  https://fabric.nfh.global
 * Secret (wrangler secret put DATA_REPO_TOKEN):
 *   DATA_REPO_TOKEN   fine-grained PAT, Contents: read and write, that repo only
 */

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

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.DATA_REPO_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'fabric-onboarding'
  };
}

function contentsUrl(env) {
  const repo = env.DATA_REPO || 'Networks-for-Humanity/fabric-onboarding';
  const file = env.DATA_PATH || 'fabric.domains.txt';
  return `https://api.github.com/repos/${repo}/contents/${file}`;
}

/**
 * Append one domain to the file. Reads, checks, writes back against the sha
 * it read — GitHub rejects the write if the file moved on meanwhile, so two
 * simultaneous submissions can't overwrite each other. On rejection we simply
 * read again and retry.
 */
async function appendDomain(env, domain) {
  const branch = env.DATA_BRANCH || 'main';

  for (let attempt = 0; attempt < 4; attempt++) {
    const read = await fetch(`${contentsUrl(env)}?ref=${branch}`, { headers: ghHeaders(env) });

    let text = '';
    let sha;
    if (read.status === 200) {
      const body = await read.json();
      text = atob(body.content.replace(/\n/g, ''));
      sha = body.sha;
    } else if (read.status !== 404) {
      // 404 just means the file doesn't exist yet — anything else is a problem.
      throw new Error(`read failed: ${read.status}`);
    }

    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.includes(domain)) return { added: false, total: lines.length };

    lines.push(domain);

    const write = await fetch(contentsUrl(env), {
      method: 'PUT',
      headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Add ${domain}`,
        content: btoa(lines.join('\n') + '\n'),
        branch,
        ...(sha ? { sha } : {})
      })
    });

    if (write.ok) return { added: true, total: lines.length };
    if (write.status === 409 || write.status === 422) continue;  // someone beat us to it; re-read
    throw new Error(`write failed: ${write.status}`);
  }

  throw new Error('write kept conflicting');
}

function cors(env) {
  const origin = env.SITE_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin'
  };
}

function json(env, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(env) }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    if (request.method !== 'POST') return json(env, 405, { error: 'POST only.' });

    let submitted;
    try {
      const type = request.headers.get('content-type') || '';
      if (type.includes('application/json')) {
        submitted = (await request.json()).fqdn;
      } else {
        submitted = (await request.formData()).get('fqdn');
      }
    } catch {
      return json(env, 400, { error: 'Could not read the submission.' });
    }

    // Validate here, not just in the browser — the form's copy is a
    // convenience, this one is the rule.
    const domain = normalise(submitted);
    if (!domain || !FQDN_RE.test(domain)) {
      return json(env, 422, { error: 'That is not a valid domain.' });
    }

    try {
      const result = await appendDomain(env, domain);
      return json(env, 200, { domain, ...result });
    } catch (err) {
      console.error('append failed:', err.message);
      return json(env, 502, { error: 'Could not record the domain.' });
    }
  }
};
