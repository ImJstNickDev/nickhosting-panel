import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTransport, createTransportCoordinator } from './transport.js';

const config = {
  baseURL: 'https://panel.example.test',
  applicationKey: 'application-private-fixture',
  clientKey: 'client-private-fixture',
};
const schema = z.object({ value: z.number() });
afterEach(() => vi.useRealTimers());

describe('Pterodactyl request coordination', () => {
  it.each([
    ['2', 2000],
    ['Sun, 11 Oct 2026 12:00:04 GMT', 4000],
    ['0', 1000],
    ['999999999', 300_000],
    ['Sun, 11 Oct 2026 11:59:00 GMT', 1000],
    ['invalid-private-provider-body', 60_000],
    [null, 60_000],
  ])(
    'bounds retry-after %s and blocks requests without replaying mutations',
    async (header, delay) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response('private upstream details', {
            status: 429,
            headers: header === null ? {} : { 'Retry-After': header },
          }),
        )
        .mockImplementation(async () => Response.json({ value: 1 }));
      const transport = createTransport({ ...config, fetcher });
      const error = await transport.json('application', 'nodes', schema).catch((error) => error);
      expect(error).toMatchObject({
        reason: 'rate_limited',
        outcome: 'rejected',
        retryAfterMs: delay,
      });
      expect(JSON.stringify(error)).not.toContain('private');
      await expect(transport.empty('application', 'servers', 'POST', {})).rejects.toMatchObject({
        reason: 'rate_limited',
        outcome: 'rejected',
        retryAfterMs: delay,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      // Application throttling does not deny the separate Client scope.
      await expect(transport.json('client', 'servers', schema)).resolves.toEqual({ value: 1 });
      vi.advanceTimersByTime(delay);
      expect(fetcher).toHaveBeenCalledTimes(2); // Never performs automatic retries.
      await expect(transport.json('application', 'nodes', schema)).resolves.toEqual({ value: 1 });
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );

  it('shares in-flight bounded JSON across recreated adapters, without caching completed values', async () => {
    const coordinator = createTransportCoordinator();
    let release!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementation(async () => Response.json({ value: 2 }));
    const first = createTransport({ ...config, fetcher, coordinator });
    const second = createTransport({ ...config, fetcher, coordinator });
    const reads = [
      first.json('application', 'nodes', schema),
      second.json('application', 'nodes', schema),
    ];
    expect(fetcher).toHaveBeenCalledTimes(1);
    release(Response.json({ value: 1 }));
    const [a, b] = await Promise.all(reads);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    await expect(second.json('application', 'nodes', schema)).resolves.toEqual({ value: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shares cooldown across recreated adapters but isolates rotated credentials and providers', async () => {
    const coordinator = createTransportCoordinator();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '30' } }))
      .mockImplementation(async () => Response.json({ value: 2 }));
    await expect(
      createTransport({ ...config, fetcher, coordinator }).json('application', 'nodes', schema),
    ).rejects.toMatchObject({ reason: 'rate_limited' });
    await expect(
      createTransport({ ...config, fetcher, coordinator }).json('application', 'servers', schema),
    ).rejects.toMatchObject({ reason: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await createTransport({ ...config, applicationKey: 'rotated', fetcher, coordinator }).json(
      'application',
      'nodes',
      schema,
    );
    await createTransport({
      ...config,
      baseURL: 'https://other.example.test',
      fetcher,
      coordinator,
    }).json('application', 'nodes', schema);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('retains each caller schema validation and clears failed reads', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ value: 1 }));
    const transport = createTransport({ ...config, fetcher });
    const [a, b] = await Promise.allSettled([
      transport.json('application', 'nodes', schema),
      transport.json('application', 'nodes', z.object({ value: z.string() })),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(new Response('invalid json'));
    await expect(transport.json('application', 'nodes', schema)).rejects.toMatchObject({
      reason: 'invalid_response',
    });
    await expect(transport.json('application', 'nodes', schema)).resolves.toEqual({ value: 1 });
  });

  it('never coalesces mutations or changes an uncertain mutation failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private network error'));
    const transport = createTransport({ ...config, fetcher });
    const mutations = await Promise.allSettled([
      transport.json('application', 'servers', schema, 'POST', {}),
      transport.json('application', 'servers', schema, 'POST', {}),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const result of mutations) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ outcome: 'unknown' });
    }
  });

  it('does not reuse an in-flight observation across a mutation', async () => {
    const coordinator = createTransportCoordinator();
    let release!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockImplementation(async () => Response.json({ value: 2 }));
    const first = createTransport({ ...config, fetcher, coordinator });
    const second = createTransport({ ...config, fetcher, coordinator });
    const before = first.json('application', 'servers/1', schema);
    await second.empty('client', 'servers/1/power', 'POST', { signal: 'start' });
    await expect(second.json('application', 'servers/1', schema)).resolves.toEqual({ value: 2 });
    release(Response.json({ value: 1 }));
    await expect(before).resolves.toEqual({ value: 1 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('enforces the shared JSON body bound', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('small', {
        headers: { 'Content-Length': String(4 * 1024 * 1024 + 1) },
      }),
    );
    const transport = createTransport({ ...config, fetcher });
    const reads = await Promise.allSettled([
      transport.json('application', 'nodes', schema),
      transport.json('application', 'nodes', schema),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const result of reads) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ reason: 'invalid_response' });
    }
  });
});
