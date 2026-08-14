#!/usr/bin/env bash
#
# One-shot setup for the onboarding collector.
#
#   ./api/setup.sh
#
# Links the Vercel project, sets the environment variables, deploys, and
# writes the resulting URL into index.html.
#
# The GitHub token is read from a prompt with echo off, piped straight to
# Vercel, and never written to disk or into this repo.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DATA_REPO_DEFAULT="Networks-for-Humanity/fabric-onboarding"
SITE_ORIGIN_DEFAULT="https://fabric.nfh.global"
PAGE="index.html"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v npx >/dev/null || die "npx not found — install Node 18+ first."

say "1/5  Vercel account"
if npx vercel whoami >/dev/null 2>&1; then
  note "signed in as $(npx vercel whoami 2>/dev/null)"
else
  note "opening a browser to sign in..."
  npx vercel login
fi

say "2/5  Link the project"
# --yes accepts the detected defaults; re-running is harmless once linked.
npx vercel link --yes

say "3/5  Environment variables"
read -rp "  Data repo [$DATA_REPO_DEFAULT]: " DATA_REPO
DATA_REPO="${DATA_REPO:-$DATA_REPO_DEFAULT}"
read -rp "  Site origin [$SITE_ORIGIN_DEFAULT]: " SITE_ORIGIN
SITE_ORIGIN="${SITE_ORIGIN:-$SITE_ORIGIN_DEFAULT}"

echo
note "Paste a fine-grained GitHub PAT scoped to $DATA_REPO alone,"
note "with Contents: read and write. Input is hidden."
read -rsp "  DATA_REPO_TOKEN: " TOKEN
echo
[ -n "$TOKEN" ] || die "No token given — nothing was changed."

# Remove first so re-running updates rather than erroring on a duplicate.
for VAR in DATA_REPO_TOKEN DATA_REPO SITE_ORIGIN; do
  npx vercel env rm "$VAR" production --yes >/dev/null 2>&1 || true
done

printf '%s' "$TOKEN"       | npx vercel env add DATA_REPO_TOKEN production >/dev/null
printf '%s' "$DATA_REPO"   | npx vercel env add DATA_REPO   production >/dev/null
printf '%s' "$SITE_ORIGIN" | npx vercel env add SITE_ORIGIN production >/dev/null
unset TOKEN
note "set: DATA_REPO_TOKEN (hidden), DATA_REPO, SITE_ORIGIN"

say "4/5  Deploy"
DEPLOY_URL="$(npx vercel deploy --prod | tail -1 | tr -d '[:space:]')"
[ -n "$DEPLOY_URL" ] || die "Deploy produced no URL — check the output above."
note "$DEPLOY_URL"

say "5/5  Point the form at it"
ENDPOINT="${DEPLOY_URL}/api/domains"
if grep -q "DOMAIN_ENDPOINT = " "$PAGE"; then
  # Only the endpoint line changes; the surrounding comment is left intact.
  perl -0pi -e "s{var DOMAIN_ENDPOINT = '[^']*';[^\n]*}{var DOMAIN_ENDPOINT = '$ENDPOINT';}" "$PAGE"
  note "$PAGE now posts to $ENDPOINT"
else
  die "Could not find DOMAIN_ENDPOINT in $PAGE — set it by hand to $ENDPOINT"
fi

say "Done. Remaining steps are yours:"
note "1. Commit $PAGE and deploy the site, so the live page uses the endpoint."
note "2. Smoke test with a REAL domain — a made-up one is filtered by the"
note "   DNS check and will look like a failure:"
note ""
note "   curl -X POST -H 'Content-Type: application/json' \\"
note "     -H 'Origin: $SITE_ORIGIN' \\"
note "     -d '{\"fqdn\":\"example.org\"}' $ENDPOINT"
note ""
note "3. Confirm the domain appears in $DATA_REPO, then delete that line."
note "4. Optional: Vercel Firewall → Rate Limiting, the one protection a"
note "   serverless function cannot provide itself."
