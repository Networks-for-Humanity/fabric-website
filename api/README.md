# fabric onboarding — domain collector

Takes the domain submitted by the onboarding form at the end of the main
fabric page and appends it to `fabric.domains.txt` in
**`Networks-for-Humanity/fabric-onboarding`**, one domain per line, no
duplicates.

Three files, no dependencies, nothing to run or patch.

## Why it exists

The form can't write to GitHub by itself. Writing to a repo needs a token, and
a token in a public web page is a public token — anyone could read it out of the
page source. This is just somewhere for the credential to live that the browser
can't see.

## How the pieces sit

The **form** is part of `index.html` — the last section on the page. It ships
wherever the site already ships; there is no separate page and nothing new to
host. The **function** runs on Vercel. The form calls it cross-origin, which is
why `SITE_ORIGIN` matters.

## Deploy

**1. The site** — redeploy `index.html` however you normally do. That's the
whole front-end change.

**2. The function** — either connect the repo in the Vercel dashboard
(**Add New → Project → Import Git Repository**, framework **Other**, all build
fields empty — there is nothing to build), or run `./api/setup.sh`, which signs
in, links the project, sets the variables, deploys, and writes the resulting URL
into the page.

`.vercelignore` keeps the HTML out, so only the function deploys — no duplicate
of the site on a `vercel.app` URL competing for search results.

**3. Connect them** — one line near the top of the onboarding script at the
bottom of `index.html`:

```js
var DOMAIN_ENDPOINT = 'https://<project>.vercel.app/api/domains';
```

Until that's filled in the page skips the call entirely: the form still works
and opens step 2, nothing is recorded.

### Environment variables

| Variable | Value |
| --- | --- |
| `DATA_REPO_TOKEN` | the PAT — mark it **Sensitive** |
| `DATA_REPO` | `Networks-for-Humanity/fabric-onboarding` |
| `SITE_ORIGIN` | `https://fabric.nfh.global` — required, this is a cross-origin call |
| `RATE_MAX` | submissions per IP per window (default `5`) |
| `RATE_WINDOW_SECONDS` | window length (default `600`) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | optional, see rate limiting |
| `MAX_DOMAINS` | ceiling on total entries (default `5000`) |
| `REQUIRE_DNS` | `0` only to disable the DNS check |

### The token

A **fine-grained personal access token**, scoped to
`Networks-for-Humanity/fabric-onboarding` alone, **Contents: read and write**.
Nothing else. Never commit it — `fabric-website` is public, so a token pushed
here is a burned token even if the commit is reverted.

## Rate limiting

Serverless makes this awkward: every invocation may land on a different
instance, so a counter in memory is partial by nature. Three layers, and you
should have at least the first and third:

**1. In the function, in memory (on by default).** A warm instance keeps its
counters between invocations, so someone hammering the endpoint is stopped
after `RATE_MAX` in `RATE_WINDOW_SECONDS`. Traffic spread across instances, or
arriving after a cold start, gets a fresh count — real protection against a
crude flood, not against a determined one.

**2. In the function, shared (optional, exact).** Add a Vercel KV or Upstash
Redis store and set `KV_REST_API_URL` and `KV_REST_API_TOKEN`. The limiter
switches to a shared counter automatically — accurate across every instance,
still no npm dependency, since it speaks the REST API over `fetch`. If the
store is unreachable it **falls back to the in-memory count rather than
rejecting**, because a broken counter must never become an outage.

**3. Vercel Firewall (recommended, free).** Dashboard → your project →
**Firewall → Rate Limiting**. This runs *in front of* the function, so blocked
requests never invoke it and never cost anything. It's the only layer that
protects against volume rather than merely counting it. Set it even if you also
configure a KV store.

## Other spam handling

The form is public and unauthenticated, so assume it will be found.

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

Filtered submissions get a `200` that looks exactly like a duplicate. An error
message would tell whoever is probing which check to work around, and there's no
human on the other end to inform.

## Behaviour

| Status | Meaning |
| --- | --- |
| `200` | Accepted. `added: false` means duplicate, filtered, or capped. |
| `422` | Not a valid domain. |
| `429` | Rate limited. Carries `Retry-After`. |
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
