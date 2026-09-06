/**
 * Server-side proxy for the Pages Context Panel's "Force sync from Workable" button.
 *
 * The panel itself (`pages-contextpanel-extension/page.tsx`) is a Client Component running
 * inside Sitecore's iframe - it must never hold `WORKABLE_FORCE_UPDATE_SECRET`. This route is
 * the only place in this app that does, and its only job is to forward one call to
 * `hztl-digital-2026`'s existing `POST /api/workable/sync?shortcode=...` (see that repo's
 * `src/app/api/workable/sync/route.ts`) - no Sitecore or Workable logic is duplicated here.
 */
import type { NextRequest } from 'next/server';

interface ForceSyncRequestBody {
  shortcode?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.WORKABLE_FORCE_UPDATE_SECRET;
  const endpointUrl = process.env.HZTL_SYNC_ENDPOINT_URL;

  if (!secret || !endpointUrl) {
    console.error(
      '[force-sync] WORKABLE_FORCE_UPDATE_SECRET/HZTL_SYNC_ENDPOINT_URL not configured'
    );
    return Response.json({ ok: false, error: 'Force sync is not configured' }, { status: 500 });
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

  // `endpointUrl` must be an absolute URL - `new URL` throws on anything else, which is exactly
  // what should happen here rather than silently building a relative/malformed request.
  let target: URL;
  try {
    target = new URL('/api/workable/sync', endpointUrl);
    target.searchParams.set('shortcode', shortcode);
  } catch {
    console.error('[force-sync] HZTL_SYNC_ENDPOINT_URL is not a valid absolute URL', {
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
    console.error('[force-sync] Request to hztl-digital-2026 failed', { shortcode, message });
    return Response.json(
      { ok: false, error: `Upstream request failed: ${message}` },
      { status: 502 }
    );
  }
}
