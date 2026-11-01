import { describe, expect, it, vi } from 'vitest';
import { CloudflareDnsProvider } from './dns.js';
import { ProviderHttp } from './http.js';

describe('external API rate limits', () => {
  it('preserves numeric Retry-After without retrying upstream', async () => {
    const fetcher = vi.fn(
      async () => new Response('', { status: 429, headers: { 'Retry-After': '2.5' } }),
    );
    const provider = new ProviderHttp({
      baseURL: 'https://api.example.test',
      headers: {},
      fetcher,
    });
    await expect(provider.request('records')).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 2500,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('handles date Retry-After and conservative missing-header cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const provider = new ProviderHttp({
        baseURL: 'https://api.example.test',
        headers: {},
        fetcher: async () =>
          new Response('', {
            status: 429,
            headers: { 'Retry-After': 'Thu, 01 Jan 2026 00:00:20 GMT' },
          }),
      });
      await expect(provider.request('records')).rejects.toMatchObject({ retryAfterMs: 20_000 });
      const fallback = new ProviderHttp({
        baseURL: 'https://api.example.test',
        headers: {},
        fetcher: async () => new Response('', { status: 429 }),
      });
      await expect(fallback.request('records')).rejects.toMatchObject({ retryAfterMs: 300_000 });
    } finally {
      vi.useRealTimers();
    }
  });
});

it('checks DNS occupancy without imposing managed-record schemas on foreign record data', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      success: true,
      result: [
        {
          id: 'foreign',
          name: 'taken.example.test',
          type: 'CAA',
          data: { tag: 'issue', value: 'ca.example.test', flags: 0 },
        },
      ],
    }),
  );
  const provider = new CloudflareDnsProvider({
    instanceId: '00000000-0000-4000-8000-000000000001',
    apiToken: 'fixture',
    fetcher,
  });
  expect(await provider.hasRecordsAtName('a'.repeat(32), 'taken.example.test')).toBe(true);
  expect(fetcher.mock.calls[0]).toBeDefined();
});
