# fabric onboarding backend

Accepts the domain submitted on `/onboarding` and records it in
`fabric.domains.txt` — one domain per line, no duplicates.

The list lives in the private repo **`Anusree-J/fabric-onboarding`**. Git gives
durability, history and an audit trail that a file on one host does not, and
because that repo is private the list is not exposed. The copy in this working
directory is a local cache, not the record.

No dependencies. Node 18+ is the only requirement (it uses the built-in `fetch`).

```sh
# local development — no token, nothing is mirrored
node server/index.js
# → http://localhost:8787/onboarding

# with mirroring to the data repo
DATA_REPO_TOKEN=github_pat_... node server/index.js
```

It also serves the static site, so one command runs the whole thing locally.
Set `SERVE_STATIC=0` to run it as a bare API behind an existing static host.

## How a submission is stored

1. The domain is normalised and validated **server-side** — scheme,
   credentials, port, path, query and trailing dot stripped, then lowercased,
   then checked against the FQDN rule. The form's copy of that logic is a
   convenience; this one is the rule.
2. It is appended to the local file immediately. This is what the response
   reflects, so a slow or broken GitHub never delays a visitor.
3. A debounced background sync merges the list into the data repo. Debouncing
   means a burst of submissions becomes **one commit**, not one per domain.

If the sync fails it retries with exponential backoff (15 s, doubling, capped
at 5 minutes) until it lands — a GitHub outage delays the mirror rather than
losing a submission. `GET /api/health` reports `syncPending` while that's
outstanding.

At startup the server reads the repo and merges anything it doesn't have
locally. A replaced host therefore rebuilds its list from the repo and won't
re-add domains already on file.

## Important: GitHub Pages cannot run this

`fabric-website` is static hosting, which executes no server-side code. The
form degrades gracefully — with no backend reachable, submitting still opens
step 2, and nothing is recorded. To collect domains, this process has to run
somewhere that runs Node (Fly, Render, Railway, a VM). Two shapes work:

1. **One host.** Point `fabric.nfh.global` at this server and let it serve the
   site too. The form's same-origin `/api/domains` then works unchanged.
2. **Split.** Keep the site on Pages, run this as an API elsewhere, set
   `ALLOWED_ORIGIN=https://fabric.nfh.global`, and change `DOMAIN_ENDPOINT` in
   `onboarding/index.html` to the API's absolute URL.

## The token

Create a **fine-grained personal access token** scoped to
`Anusree-J/fabric-onboarding` alone, with **Contents: read and write**. Nothing
else. Supply it as `DATA_REPO_TOKEN` through the host's secret store.

Never commit it. `fabric-website` is a public repository — a token pushed here
is a compromised token, even if the commit is reverted.

Without `DATA_REPO_TOKEN` the server runs local-only and says so at startup.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DATA_REPO_TOKEN` | none | Enables mirroring. Unset = local-only. |
| `DATA_REPO` | `Anusree-J/fabric-onboarding` | Repo holding the list |
| `DATA_BRANCH` | `main` | Branch to commit to |
| `DATA_PATH` | `fabric.domains.txt` | Path within that repo |
| `DOMAINS_FILE` | `<repo>/fabric.domains.txt` | Local cache location |
| `SYNC_DEBOUNCE_MS` | `2000` | How long to coalesce before committing |
| `STATIC_DIR` | `<repo>` | Directory served as the site |
| `SERVE_STATIC` | on | `0` disables static serving |
| `ALLOWED_ORIGIN` | none | Origin allowed to POST cross-origin |
| `TRUST_PROXY` | off | `1` reads client IP from `X-Forwarded-For` |
| `GITHUB_API_BASE` | `https://api.github.com` | Override for testing or GHES |

Set `TRUST_PROXY=1` only when a proxy you control sets that header — otherwise
the rate limiter can be bypassed by forging it.

## API

### `POST /api/domains`

Accepts JSON (`{"fqdn": "..."}`) or form encoding (`fqdn=...`).

```sh
curl -X POST -H 'Content-Type: application/json' \
  -d '{"fqdn":"https://Acme-Corp.co.in/pricing"}' \
  http://localhost:8787/api/domains
# {"domain":"acme-corp.co.in","stored":true,"duplicate":false}
```

| Status | Meaning |
| --- | --- |
| `200` | Recorded. `duplicate: true` means it was already on file. |
| `413` | Body over 2 KB. |
| `422` | Not a valid domain. |
| `429` | Over 20 submissions from one IP in 10 minutes. |

### `GET /api/health`

```json
{"ok":true,"domains":42,"repo":"Anusree-J/fabric-onboarding:main/fabric.domains.txt","syncPending":false}
```

## Notes on the data

- **The local `fabric.domains.txt` stays gitignored in this repo.** It is a
  cache of the private repo's contents. Committing it here would publish the
  list — `fabric-website` is public and Pages-served, so a tracked file is
  downloadable at `fabric.nfh.global/fabric.domains.txt` by anyone. The server
  returns 403 for that path, but Pages serves files straight from the repo and
  never consults the server.
- **Concurrent writes are safe.** Local appends are serialised through a single
  promise chain; repo writes use the blob sha as an optimistic concurrency
  check, and a conflict re-reads and merges rather than overwriting, so a
  parallel writer's entries survive.
- **A domain here is a claim, not a verified fact.** Nothing at this step proves
  the submitter controls the domain — anyone can type `google.com`. Proof comes
  later, when the well-known file appears at that domain or the DNS TXT record
  verifies. Treat the list as people who started onboarding, not a registry.
