import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

function makeRequest(
  body: unknown,
  opts: { ip: string; rawBody?: string }
): NextRequest {
  return new NextRequest('http://localhost/api/force-sync', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': opts.ip,
    },
    body: opts.rawBody ?? JSON.stringify(body),
  });
}

describe('POST /api/force-sync', () => {
  // Each test gets its own client key so the module-level rate-limit map
  // doesn't leak state between tests.
  let ipCounter = 0;
  let ip: string;

  beforeEach(() => {
    ipCounter += 1;
    ip = `10.0.0.${ipCounter}`;
    vi.stubEnv('WORKABLE_FORCE_UPDATE_SECRET', 'test-secret');
    vi.stubEnv('WORKABLE_SYNC_ENDPOINT_URL', 'https://downstream.example.com/api/workable/sync');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns 500 when required env vars are missing', async () => {
    vi.unstubAllEnvs();
    const res = await POST(makeRequest({ shortcode: 'abc' }, { ip }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'Force sync is not configured' });
  });

  it('returns 400 for an invalid JSON body', async () => {
    const res = await POST(makeRequest(undefined, { ip, rawBody: 'not-json' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid JSON body');
  });

  it('returns 400 when shortcode is missing', async () => {
    const res = await POST(makeRequest({}, { ip }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Missing required field: shortcode');
  });

  it('returns 500 when WORKABLE_SYNC_ENDPOINT_URL is not a valid absolute URL', async () => {
    vi.stubEnv('WORKABLE_SYNC_ENDPOINT_URL', 'not-a-url');
    const res = await POST(makeRequest({ shortcode: 'abc' }, { ip }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Force sync is not configured');
  });

  it('forwards the trimmed shortcode and secret, and relays the upstream response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, operation: 'updated' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(makeRequest({ shortcode: ' abc123 ' }, { ip }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl.toString()).toBe('https://downstream.example.com/api/workable/sync?shortcode=abc123');
    expect(calledInit).toMatchObject({
      method: 'POST',
      headers: { 'x-workable-sync-secret': 'test-secret' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, operation: 'updated' });
  });

  it('returns 502 when the upstream request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const res = await POST(makeRequest({ shortcode: 'abc' }, { ip }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('Upstream request failed: network down');
  });

  it('rate-limits a client after 5 requests within the window', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );

    for (let i = 0; i < 5; i++) {
      const res = await POST(makeRequest({ shortcode: 'abc' }, { ip }));
      expect(res.status).not.toBe(429);
    }

    const limited = await POST(makeRequest({ shortcode: 'abc' }, { ip }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
  });
});
