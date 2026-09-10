import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

function makeRequest(ip: string): NextRequest {
  return new NextRequest('http://localhost/api/bulk-import', {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
  });
}

describe('POST /api/bulk-import', () => {
  // Each test gets its own client key so the module-level rate-limit map
  // doesn't leak state between tests.
  let ipCounter = 0;
  let ip: string;

  beforeEach(() => {
    ipCounter += 1;
    ip = `10.0.1.${ipCounter}`;
    vi.stubEnv('CRON_SECRET', 'test-cron-secret');
    vi.stubEnv('WORKABLE_BULK_IMPORT_ENDPOINT_URL', 'https://downstream.example.com/api/workable/import');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns 500 when required env vars are missing', async () => {
    vi.unstubAllEnvs();
    const res = await POST(makeRequest(ip));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'Bulk import is not configured' });
  });

  it('returns 500 when WORKABLE_BULK_IMPORT_ENDPOINT_URL is not a valid absolute URL', async () => {
    vi.stubEnv('WORKABLE_BULK_IMPORT_ENDPOINT_URL', 'not-a-url');
    const res = await POST(makeRequest(ip));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Bulk import is not configured');
  });

  it('sends the bearer secret and relays the upstream response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, publishedJobCount: 12, created: 1, updated: 2, skipped: 9, failed: 0 }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(makeRequest(ip));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl.toString()).toBe('https://downstream.example.com/api/workable/import');
    expect(calledInit).toMatchObject({
      method: 'GET',
      headers: { Authorization: 'Bearer test-cron-secret' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      publishedJobCount: 12,
      created: 1,
      updated: 2,
      skipped: 9,
      failed: 0,
    });
  });

  it('returns 502 when the upstream request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const res = await POST(makeRequest(ip));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('Upstream request failed: network down');
  });

  it('rate-limits a client after 2 requests within the window', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );

    for (let i = 0; i < 2; i++) {
      const res = await POST(makeRequest(ip));
      expect(res.status).not.toBe(429);
    }

    const limited = await POST(makeRequest(ip));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('300');
  });
});
