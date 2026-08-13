# fabric onboarding — domain collector

Takes the domain submitted on `/onboarding` and appends it to
`fabric.domains.txt` in **`Networks-for-Humanity/fabric-onboarding`**, one
domain per line, no duplicates.

One file, no dependencies, no server to run.

## Why this exists at all

The form can't write to GitHub by itself. Writing to a repo needs a token, and
a token in a public web page is a public token — anyone could read it out of
the page source. So the token has to live somewhere the browser can't see, and
that's all this is: a small piece of code holding the credential.

## Deploy

```sh
cd worker
npx wrangler deploy                      # first run prompts a Cloudflare login
npx wrangler secret put DATA_REPO_TOKEN  # paste the token, it is never in git
```

Then put the deployed URL into `onboarding/index.html` — one line near the top
of the page's script:

```js
const DOMAIN_ENDPOINT = 'https://fabric-onboarding.<your-subdomain>.workers.dev';
```

That's the whole setup. It's free at any volume this page will see.

### The token

A **fine-grained personal access token**, scoped to
`Networks-for-Humanity/fabric-onboarding` alone, with **Contents: read and
write**. Nothing else.

`wrangler secret put` stores it in Cloudflare — never commit it. `fabric-website`
is a public repo, so a token pushed there is a burned token even if the commit
is reverted.

### Settings

`wrangler.toml` carries the repo, file path, branch and the allowed origin.
Change them there.

## How it works

Read the file, append the line if it's new, write it back against the sha it
was read at. GitHub rejects the write if the file changed in between, so two
simultaneous submissions can't overwrite each other — on rejection it re-reads
and retries.

The domain is normalised and validated in the worker, not just in the browser:
`https://Acme-Corp.co.in/pricing` is recorded as `acme-corp.co.in`, and the
character set the rule allows makes it impossible to inject a newline and forge
extra entries.

| Status | Meaning |
| --- | --- |
| `200` | Recorded. `added: false` means it was already on file. |
| `422` | Not a valid domain. |
| `502` | GitHub couldn't be reached or refused the write. |

If the file doesn't exist yet, the first submission creates it.

## Notes

- **The page doesn't depend on this.** Submitting opens step 2 whether or not
  the request lands, so an outage here never blocks a visitor — it just means
  nothing was recorded.
- **A domain here is a claim, not a verified fact.** Nothing at this step proves
  the submitter controls it — anyone can type `google.com`. Proof comes later,
  when the well-known file appears at that domain or the DNS TXT verifies.
  Treat the file as people who started onboarding, not a registry.
- **Not rate limited.** Cloudflare's free tier absorbs abuse well enough for
  this, but the endpoint will happily accept junk domains. If that becomes a
  problem, add a Cloudflare rate-limiting rule — no code change needed.
