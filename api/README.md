# fabric onboarding — domain collector

A Vercel function. Takes the domain submitted on `/onboarding` and appends it to
`fabric.domains.txt` in **`Networks-for-Humanity/fabric-onboarding`**, one
domain per line, no duplicates.

Two files, no dependencies, nothing to run or patch.

## Why it exists

The form can't write to GitHub by itself. Writing to a repo needs a token, and
a token in a public web page is a public token — anyone could read it out of the
page source. This is just somewhere for the credential to live that the browser
can't see.

## How the pieces sit

The **page** is a static file deployed with the rest of the site, live at
`fabric.nfh.global/onboarding`. The **function** runs on Vercel. The form calls
it cross-origin, which is why `SITE_ORIGIN` matters.

Nothing is proxied. nginx keeps doing exactly what it already does, and the
token never touches your server.

## Deploy

**1. The page** — ships with your normal site deploy; `onboarding/index.html`
is just another file. If `/onboarding` 404s without a trailing slash, add the
one-line block in `onboarding/nginx-snippet.conf`.

**2. The function:**

```sh
npx vercel            # preview
npx vercel --prod     # production
```

`.vercelignore` keeps the HTML out, so only the function deploys — no stale
duplicate of the site on a `vercel.app` URL competing for search results.

Set these in **Project → Settings → Environment Variables**:

| Variable | Value |
| --- | --- |
| `DATA_REPO_TOKEN` | the PAT — mark it **Sensitive** |
| `DATA_REPO` | `Networks-for-Humanity/fabric-onboarding` |
| `SITE_ORIGIN` | `https://fabric.nfh.global` — required, this is a cross-origin call |
| `MAX_DOMAINS` | `5000` (optional ceiling) |
| `REQUIRE_DNS` | `0` only to disable the DNS check |

**3. Connect them** — one line near the top of the script in
`onboarding/index.html`:

```js
const DOMAIN_ENDPOINT = 'https://<project>.vercel.app/api/domains';
```

Until that's filled in the page skips the call entirely: the form still works
and opens step 2, nothing is recorded.

Check it end to end from the live page, or:

```sh
curl -X POST -H 'Content-Type: application/json' \
  -H 'Origin: https://fabric.nfh.global' \
  -d '{"fqdn":"deploy-test.example"}' https://<project>.vercel.app/api/domains
```

`deploy-test.example` won't resolve, so it will be filtered — use a real domain
you don't mind committing, then delete the line from the data repo.

### The token

A **fine-grained personal access token**, scoped to
`Networks-for-Humanity/fabric-onboarding` alone, **Contents: read and write**.
Nothing else. Never commit it — `fabric-website` is public, so a token pushed
here is a burned token even if the commit is reverted.

## Spam handling

The form is public and unauthenticated, so assume it will be found. Layers,
cheapest first:

| Layer | Catches | Blind to |
| --- | --- | --- |
| Format validation | junk strings, newline injection | anything shaped like a domain |
| Honeypot field | form-filling bots | direct API posts |
| Fill-time check | instant submissions | direct API posts |
| **DNS resolution** | **invented domains** | real domains submitted maliciously |
| Dedup | the same domain repeatedly | many distinct domains |
| `MAX_DOMAINS` | unbounded growth | everything under the ceiling |

The DNS check is the one that matters. Onboarding requires hosting a file at
the domain or proving control by DNS record, so a domain that doesn't resolve
can't complete the process — rejecting it loses nothing real, while invented
spam domains fail immediately. It **fails open** on resolver trouble: if DNS is
broken that's our problem, and it must never become "reject every genuine
signup." Only a definitive NXDOMAIN drops a submission.

Rejected submissions get a `200` that looks exactly like a duplicate. An error
message would tell whoever is probing which check to work around, and there's no
human on the other end to inform.

**What this does not have is per-IP rate limiting.** A long-running server can
hold that in memory; a serverless function can't — every invocation starts
fresh. If you need it, turn on **Vercel Firewall → Rate Limiting** in the
dashboard: no code change, and it runs before the function so it costs nothing.
That's the gap to close first if the list ever starts filling with junk.

## Behaviour

| Status | Meaning |
| --- | --- |
| `200` | Accepted. `added: false` means duplicate, filtered, or capped. |
| `422` | Not a valid domain. |
| `502` | GitHub unreachable or refused the write. |

`https://Acme-Corp.co.in/pricing?x=1` is recorded as `acme-corp.co.in`. The
first submission creates the file if it doesn't exist. Writes use the blob sha
as a concurrency check, so simultaneous submissions can't overwrite each other —
on rejection it re-reads and retries.

## Notes

- **The page doesn't depend on this.** Submitting opens step 2 whether or not
  the request lands, so an outage here never blocks a visitor.
- **A domain here is a claim, not a verified fact.** Nothing at this step proves
  the submitter controls it. Proof comes later, when the well-known file appears
  at that domain or the DNS TXT record verifies. Treat the file as people who
  started onboarding, not a registry.
