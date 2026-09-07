/**
 * Server-side proxy for the Pages Context Panel's "Force Sync" button.
 *
 * The panel itself (`pages-contextpanel-extension/page.tsx`) is a Client Component running
 * inside Sitecore's iframe - it must never hold `WORKABLE_FORCE_UPDATE_SECRET`. This route is
 * the only place in this app that does, and its only job is to forward one call to whatever
 * project's own force-sync endpoint `WORKABLE_SYNC_ENDPOINT_URL` names - no Sitecore or
 * Workable logic is duplicated here.
 *
 * Downstream contract this app assumes (any project reusing this app must implement an
 * endpoint matching this shape, e.g. `hztl-digital-2026`'s `POST /api/workable/sync` - see that
 * repo's `src/app/api/workable/sync/route.ts` for a reference implementation):
 *   - `POST <WORKABLE_SYNC_ENDPOINT_URL>?shortcode=<id>`
 *   - Header `x-workable-sync-secret: <WORKABLE_FORCE_UPDATE_SECRET>` (same value on both apps)
 *   - JSON response `{ ok: boolean, operation?: string, error?: string }`
 *
 * Known, accepted limitation: `WORKABLE_FORCE_UPDATE_SECRET` authenticates this app's OUTBOUND
 * call to the downstream endpoint, but nothing authenticates who calls THIS route inbound -
 * anyone who discovers this app's deployed URL can POST here directly (no browser needed, so
 * CORS doesn't help). The rate limit below bounds that gap rather than closing it: the
 * operation it gates is already bounded (one legitimate resync, not an arbitrary Sitecore
 * write), so capping abuse volume is a proportionate mitigation for now, not real per-caller
 * auth. Revisit if this app's threat model changes.
 */
import type { NextRequest } from 'next/server';

interface ForceSyncRequestBody {
  shortcode?: unknown;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 5;

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/**
 * Module-level, so best-effort only: a serverless deployment may run several concurrent
 * instances, each with its own Map, so this caps abuse per instance, not truly globally across
 * a deployment. Acceptable given the bounded blast radius documented above - an exact,
 * cross-instance limit would need shared state (e.g. Vercel KV/Redis), disproportionate
 * infrastructure for an internal tool at this traffic level.
 */
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
  const secret = process.env.WORKABLE_FORCE_UPDATE_SECRET;
  const endpointUrl = process.env.WORKABLE_SYNC_ENDPOINT_URL;

  if (!secret || !endpointUrl) {
    console.error(
      '[force-sync] WORKABLE_FORCE_UPDATE_SECRET/WORKABLE_SYNC_ENDPOINT_URL not configured'
    );
    return Response.json({ ok: false, error: 'Force sync is not configured' }, { status: 500 });
  }

  const clientKey = getClientKey(req);
  if (isRateLimited(clientKey)) {
    console.warn('[force-sync] Rate limit exceeded', { clientKey });
    return Response.json(
      { ok: false, error: 'Too many requests - try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(RATE_LIMIT_WINDOW_MS / 1000) } }
    );
  }

  let requestBody: ForceSyncRequestBody;
  try {
    requestBody = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const shortcode =
    typeof requestBody.shortcode === 'string' ? requestBody.shortcode.trim() : '';
  if (!shortcode) {
    return Response.json(
      { ok: false, error: 'Missing required field: shortcode' },
      { status: 400 }
    );
  }

  // `WORKABLE_SYNC_ENDPOINT_URL` is the FULL target URL (including whatever path the
  // consuming project's own endpoint uses) - not a base URL with a path hardcoded here, since a
  // different project reusing this app may not use the same path `hztl-digital-2026` does.
  // `new URL` throws on anything not a valid absolute URL, which is exactly what should happen
  // here rather than silently building a malformed request.
  let target: URL;
  try {
    target = new URL(endpointUrl);
    target.searchParams.set('shortcode', shortcode);
  } catch {
    console.error('[force-sync] WORKABLE_SYNC_ENDPOINT_URL is not a valid absolute URL', {
      endpointUrl,
    });
    return Response.json({ ok: false, error: 'Force sync is not configured' }, { status: 500 });
  }

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'x-workable-sync-secret': secret },
    });
    const upstreamBody = await upstream.json();
    return Response.json(upstreamBody, { status: upstream.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[force-sync] Request to the configured sync endpoint failed', {
      shortcode,
      message,
    });
    return Response.json(
      { ok: false, error: `Upstream request failed: ${message}` },
      { status: 502 }
    );
  }
}
