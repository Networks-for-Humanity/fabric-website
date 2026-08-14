# fabric onboarding collector

Takes the domain submitted by the onboarding form at the end of `index.html`
and appends it to `fabric.domains.txt` in
**`Networks-for-Humanity/fabric-onboarding`**, one domain per line, no
duplicates.

Runs on the same host as the site, behind nginx. No dependencies, no third
party, no build step — Node 18+ and `node server/index.js`.

## Why it exists

The form can't write to GitHub by itself. Writing to a repo needs a token, and
a token in a public web page is a public token — anyone could read it out of
the page source. This is somewhere for the credential to live that the browser
can't see.

## How a submission is stored

1. The domain is normalised and validated **server-side** — scheme,
   credentials, port, path, query and trailing dot stripped, then lowercased,
   then checked against the FQDN rule. The form has its own copy for instant
   feedback; this one is the rule, and the characters it permits are what make
   newline injection into the file impossible.
2. It's appended to a local file immediately. That's what the response
   reflects, so a slow or broken GitHub never delays a visitor.
3. A debounced background sync merges the list into the data repo. Debouncing
   means a burst of submissions becomes **one commit**, not one per domain.

If the sync fails it retries with exponential backoff (15 s, doubling, capped
at 5 minutes) until it lands — a GitHub outage delays the mirror rather than
losing a submission. At startup the server reads the repo and merges anything
it doesn't have locally, so a rebuilt host recovers its list rather than
re-adding domains.

4. A debounced call to the dedi-crawler tells it to run a full refresh, the
   same way the GitHub sync is debounced — a burst of submissions triggers one
   crawl, not one per domain. It retries with the same backoff on failure and
   never affects the response to the submitter.

## Deploy

**1. The token**, root-readable only:

```sh
cat <<'EOF' | sudo tee /etc/fabric-onboarding.env
DATA_REPO_TOKEN=github_pat_...
DEDI_CRAWLER_URL=https://...
DEDI_CRAWLER_TOKEN=...
EOF
sudo chmod 600 /etc/fabric-onboarding.env
```

`DATA_REPO_TOKEN` is a **fine-grained personal access token**, scoped to
`Networks-for-Humanity/fabric-onboarding` alone, **Contents: read and write**.
Nothing else. Never commit it — this repo is public.

`DEDI_CRAWLER_URL`/`DEDI_CRAWLER_TOKEN` are optional — omit both to leave the
crawler refresh disabled and keep the collector doing only what it did
before.

**2. The service** — edit `User` and `WorkingDirectory` first if the checkout
isn't at `/var/www/fabric-website`:

```sh
sudo cp server/deploy/fabric-onboarding.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fabric-onboarding
journalctl -u fabric-onboarding -f
```

Startup should log `data repo: Networks-for-Humanity/fabric-onboarding`. If it
says `disabled`, the token isn't reaching the process.

**3. nginx** — add the block from `server/deploy/nginx.conf` to the existing
`server{}` for `fabric.nfh.global`, then `sudo nginx -t && sudo systemctl
reload nginx`. It proxies `/api/` to the collector and denies the local cache
file. The form itself is part of `index.html` and is already being served.

**4. Verify:**

```sh
curl -X POST -H 'Content-Type: application/json' \
  -d '{"fqdn":"example.org"}' https://fabric.nfh.global/api/domains
```

Use a **real** domain — an invented one is dropped by the DNS check and looks
like a failure when it's the filter working. Delete the test line from the data
repo afterwards.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Loopback only; nginx is the front door |
| `DATA_REPO_TOKEN` | none | Required to mirror. Unset = local file only. |
| `DATA_REPO` | `Networks-for-Humanity/fabric-onboarding` | Repo holding the list |
| `RATE_MAX` | `5` | Submissions per IP per window |
| `RATE_WINDOW_SECONDS` | `600` | Window length |
| `HOURLY_MAX` | `200` | Ceiling on new domains per hour, any source |
| `REQUIRE_DNS` | on | `0` records domains that don't resolve |
| `SERVE_STATIC` | on | `0` when nginx serves the site |
| `TRUST_PROXY` | off | `1` reads the client IP from `X-Forwarded-For` |
| `SYNC_DEBOUNCE_MS` | `2000` | How long to coalesce before committing |
| `DEDI_CRAWLER_URL` | none | Base URL of the dedi-crawler. Unset = refresh disabled. |
| `DEDI_CRAWLER_TOKEN` | none | Bearer token for the dedi-crawler. Required alongside the URL. |
| `DEDI_CRAWLER_DEBOUNCE_MS` | `2000` | How long to coalesce before triggering a refresh |

`TRUST_PROXY=1` is set in the unit because nginx sets `X-Forwarded-For`.
Without it every visitor looks like the proxy, and one person hitting the limit
locks out everyone. Only enable it behind a proxy you control — otherwise the
header can be forged to bypass the limiter.

## Abuse handling

The form is public and unauthenticated, so assume it will be found.

| Layer | Catches | Blind to |
| --- | --- | --- |
| Format validation | junk strings, newline injection | anything shaped like a domain |
| Honeypot field | form-filling bots | direct API posts |
| Fill-time check | instant submissions | direct API posts |
| **Per-IP rate limit** | **floods from one source** | a distributed flood |
| **DNS resolution** | **invented domains** | real domains submitted maliciously |
| Dedup | the same domain repeatedly | many distinct domains |
| `HOURLY_MAX` | unbounded growth | anything under the ceiling |

Rate limiting is **exact** here. This is one long-running process, so the
counters are simply correct — none of the caveats that apply to serverless,
where invocations don't share memory. It runs before anything else in the
handler, so a flood is rejected before it can spend a DNS lookup or a GitHub
call.

The DNS check is the other one that carries weight. Onboarding requires hosting
a file at the domain or proving control by DNS record, so a domain that doesn't
resolve can't complete the process — rejecting it loses nothing real, while
invented spam domains fail immediately. It **fails open** on resolver trouble:
if DNS is broken that's our problem, and it must never become "reject every
genuine signup." Only a definitive NXDOMAIN drops a submission.

Filtered submissions get a `200` that looks exactly like a duplicate. An error
message would tell whoever is probing which check to work around, and there's
no human on the other end to inform.

For a second line of defence in front of the app, `server/deploy/nginx.conf`
carries a commented `limit_req` example.

## Behaviour

| Status | Meaning |
| --- | --- |
| `200` | Accepted. `stored: false` means duplicate, filtered, or capped. |
| `413` | Body over 2 KB. |
| `422` | Not a valid domain. |
| `429` | Rate limited. Carries `Retry-After`. |
| `500` | Could not write locally. |

`GET /api/health` returns `{ok, domains, repo, syncPending}`.

## Notes

- **The page doesn't depend on this.** Submitting opens step 2 whether or not
  the request lands, so an outage here never blocks a visitor.
- **The local `fabric.domains.txt` is gitignored.** It's a cache of the private
  repo. Committing it here would publish the list — this repo is public.
- **A domain here is a claim, not a verified fact.** Nothing at this step proves
  the submitter controls it. Proof comes later, when the well-known file appears
  at that domain or the DNS TXT record verifies. Treat the file as people who
  started onboarding, not a registry.
