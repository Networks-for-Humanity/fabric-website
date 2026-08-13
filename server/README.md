# fabric onboarding backend

Accepts the domain submitted on `/onboarding` and appends it to
`fabric.domains.txt` — one domain per line, no duplicates.

No dependencies. Node 18+ is the only requirement.

```sh
node server/index.js
# → http://localhost:8787/onboarding
```

It also serves the static site, so this one command runs the whole thing
locally. Set `SERVE_STATIC=0` to run it as a bare API behind an existing
static host.

## Important: GitHub Pages cannot run this

The site is currently static hosting, which executes no server-side code. The
form falls back gracefully — with no backend reachable, submitting still opens
step 2, and nothing is recorded. To actually collect domains, this process has
to run somewhere that runs Node (Fly, Render, Railway, a VM), and the site has
to reach it. Two shapes work:

1. **One host.** Point `fabric.nfh.global` at this server and let it serve the
   site too. The form's same-origin `/api/domains` then works unchanged.
2. **Split.** Keep the site on Pages, run this as an API on another host, set
   `ALLOWED_ORIGIN=https://fabric.nfh.global`, and change `DOMAIN_ENDPOINT` in
   `onboarding/index.html` to the API's absolute URL.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DOMAINS_FILE` | `<repo>/fabric.domains.txt` | Where domains are written |
| `STATIC_DIR` | `<repo>` | Directory served as the site |
| `SERVE_STATIC` | on | `0` disables static serving |
| `ALLOWED_ORIGIN` | none | Origin allowed to POST cross-origin |
| `TRUST_PROXY` | off | `1` reads client IP from `X-Forwarded-For` |

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

The submitted value is normalised server-side before anything is written —
scheme, credentials, port, path, query and trailing dot are stripped and the
result is lowercased — then validated against the same FQDN rule the form
uses. The client's copy of that logic is a convenience; this one is the rule.

| Status | Meaning |
| --- | --- |
| `200` | Recorded. `duplicate: true` means it was already on file. |
| `413` | Body over 2 KB. |
| `422` | Not a valid domain. |
| `429` | Over 20 submissions from one IP in 10 minutes. |

### `GET /api/health`

`{"ok": true, "domains": 42}` — the count is the number of lines on file.

## Notes on the data

- **`fabric.domains.txt` is gitignored.** It is collected data written by a
  running server; tracking it in git means merge conflicts on every deploy and
  submissions landing in a public repository. Back it up from the host with
  whatever you use for the rest of that host's state. Un-ignore it if you
  genuinely want the list version-controlled.
- **Appends are serialised** through a single promise chain, and duplicates are
  checked against an in-memory set loaded at startup, so concurrent submissions
  of the same domain produce one line.
- **A domain here is a claim, not a verified fact.** Nothing at this step proves
  the submitter controls the domain — anyone can type `google.com`. Proof
  happens later, when the well-known file appears at that domain or the DNS TXT
  record is verified. Treat the file as a list of people who started
  onboarding, not a registry.
- **The file is never served.** A request for `/fabric.domains.txt` returns 403
  even though it sits in the static directory.
