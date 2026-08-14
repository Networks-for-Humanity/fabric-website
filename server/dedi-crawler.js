'use strict';

/**
 * Tells the dedi-crawler to re-crawl after a new domain is recorded.
 *
 * Fire-and-forget from the caller's perspective: the domain is already on
 * file by the time this runs, so a slow or down crawler should not hold up
 * the form response. Failures are logged and retried with backoff rather
 * than surfaced to the submitter.
 */

const BASE_URL = (process.env.DEDI_CRAWLER_URL || '').replace(/\/$/, '');
const TOKEN    = process.env.DEDI_CRAWLER_TOKEN || '';

const enabled = Boolean(BASE_URL && TOKEN);

async function triggerFullCrawl() {
  const res = await fetch(`${BASE_URL}/v1/crawl/full`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'User-Agent': 'fabric-onboarding'
    }
  });

  if (!res.ok) {
    throw new Error(`dedi-crawler refresh failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
}

module.exports = { enabled, triggerFullCrawl };
