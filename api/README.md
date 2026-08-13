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

## Deploy

This deployment is the onboarding page **and** its API — one standalone thing,
independent of the main site. The page is served at the root, the function at
`/api/domains`, same origin. There is nothing to wire up between them and no
CORS involved.

```sh
npx vercel            # preview
npx vercel --prod     # production
```

Set these in **Project → Settings → Environment Variables**:

| Variable | Value |
| --- | --- |
| `DATA_REPO_TOKEN` | the PAT — mark it **Sensitive** |
| `DATA_REPO` | `Networks-for-Humanity/fabric-onboarding` |
| `MAX_DOMAINS` | `5000` (optional ceiling) |
| `REQUIRE_DNS` | `0` only to disable the DNS check |
| `SITE_ORIGIN` | only if the form is ever hosted on another origin |

Then visit the deployment URL — it opens straight on the onboarding page, and
the form is already pointed at its own `/api/domains`.

### Relationship to the main site

`fabric-website` (this repo) still serves `fabric.nfh.global` from nginx and is
untouched by this deployment — `.vercelignore` keeps the marketing pages out, so
no stale duplicate of the site appears on a `vercel.app` URL competing for
search results.

The onboarding page's header and footer link back to `fabric.nfh.global`
absolutely, so navigation works from wherever this is hosted. Nothing on the
main site currently links *to* onboarding; add that link once the URL is
settled, ideally after pointing a custom domain at the deployment so the link
never has to change.

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
