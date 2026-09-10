/**
 * Server-side proxy for the Pages Context Panel's "Bulk Import" button (Careers root only).
 *
 * Mirrors `force-sync/route.ts`'s shape: the panel is a Client Component and must never hold
 * `CRON_SECRET`. This route is the only place in this app that does, and its
 * only job is to forward one call to whatever project's own bulk-import endpoint
 * `WORKABLE_BULK_IMPORT_ENDPOINT_URL` names.
 *
 * Downstream contract this app assumes (matches `hztl-digital-2026`'s scheduled
 * `GET /api/workable/import` - see that repo's `src/app/api/workable/import/route.ts`, the
 * same route Vercel Cron calls):
 *   - `GET <WORKABLE_BULK_IMPORT_ENDPOINT_URL>`
 *   - Header `Authorization: Bearer <CRON_SECRET>` - reuses the downstream
 *     project's own `CRON_SECRET` value rather than minting a dedicated secret (confirmed
 *     trade-off; that route doesn't distinguish Vercel Cron from any other caller presenting
 *     the right bearer token)
 *   - JSON response `{ ok: boolean, publishedJobCount?, created?, updated?, skipped?, failed?,
 *     staleRecycled?, staleRecycleFailed?, reconciliationSkipped?, error? }`
 *
 * `maxDuration` matches the downstream route's own ceiling - a full bulk import can run close
 * to 300s, and this proxy must not time out before the upstream call it's waiting on does.
 *
 * Rate limit is tighter than force-sync's: this triggers a heavy, account-wide operation (not
 * a single item), so a much lower ceiling is appropriate - same "bounds abuse, not real
 * per-caller auth" reasoning as force-sync's, see that route's header comment.
 */
import type { NextRequest } from 'next/server';

export const maxDuration = 300;

const RATE_LIMIT_WINDOW_MS = 300_000;
const RATE_LIMIT_MAX_REQUESTS = 2;

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/** Module-level, so best-effort only - see `force-sync/route.ts`'s identical note. */
const rateLimitState = new Map<string, RateLimitEntry>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitState.get(key);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

/** First hop in `x-forwarded-for` is the original client on Vercel's proxy chain. */
function getClientKey(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const endpointUrl = process.env.WORKABLE_BULK_IMPORT_ENDPOINT_URL;

  if (!secret || !endpointUrl) {
    console.error(
      '[bulk-import] CRON_SECRET/WORKABLE_BULK_IMPORT_ENDPOINT_URL not configured'
    );
    return Response.json({ ok: false, error: 'Bulk import is not configured' }, { status: 500 });
  }

  const clientKey = getClientKey(req);
  if (isRateLimited(clientKey)) {
    console.warn('[bulk-import] Rate limit exceeded', { clientKey });
    return Response.json(
      { ok: false, error: 'Too many requests - try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(RATE_LIMIT_WINDOW_MS / 1000) } }
    );
  }

  let target: URL;
  try {
    target = new URL(endpointUrl);
  } catch {
    console.error('[bulk-import] WORKABLE_BULK_IMPORT_ENDPOINT_URL is not a valid absolute URL', {
      endpointUrl,
    });
    return Response.json({ ok: false, error: 'Bulk import is not configured' }, { status: 500 });
  }

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
    });
    const upstreamBody = await upstream.json();
    return Response.json(upstreamBody, { status: upstream.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[bulk-import] Request to the configured import endpoint failed', { message });
    return Response.json(
      { ok: false, error: `Upstream request failed: ${message}` },
      { status: 502 }
    );
  }
}
