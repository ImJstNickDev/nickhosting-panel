import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { withProviderReadCaller } from './provider-read-attribution.js';
import { createTransport, createTransportCoordinator } from './transport.js';

const config = {
  baseURL: 'https://panel.example.test',
  applicationKey: 'application-private-fixture',
  clientKey: 'client-private-fixture',
};
const schema = z.object({ value: z.number() });
afterEach(() => vi.useRealTimers());

describe('Pterodactyl request coordination', () => {
  it('counts wire dispatches once per initiating caller, including an upstream 429', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-22T12:00:00Z'));
    const coordinator = createTransportCoordinator('api');
    const logger = { log: vi.fn() };
    const stop = coordinator.startReadReporting(logger);
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(new Response(null, { status: 429 }));
    const transport = createTransport({ ...config, fetcher, coordinator });
    const detail = (id: number) =>
      transport.json('application', `servers/${id}?include=allocations`, schema);
    const first = withProviderReadCaller('openworld-map', () => detail(7));
    const joined = withProviderReadCaller('openworld-players', () => detail(7));
    await expect(withProviderReadCaller('gateway', () => detail(8))).rejects.toMatchObject({
      reason: 'rate_limited',
    });
    await expect(detail(9)).rejects.toMatchObject({ reason: 'rate_limited' });
    pending.resolve(Response.json({ value: 1 }));
    await Promise.all([first, joined]);
    expect(
      fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('user-agent')),
    ).toEqual(['NickPanel/openworld-map', 'NickPanel/gateway']);
    vi.advanceTimersByTime(120_000);
    stop();
    expect(logger.log.mock.calls).toEqual([
      [
        'info',
        'pterodactyl.server_reads',
        {
          runtime: 'api',
          from: '2026-11-22T12:00:00.000Z',
          until: '2026-11-22T12:01:00.000Z',
          callers: { 'openworld-map': { detail: 1 }, gateway: { detail: 1 } },
        },
      ],
    ]);
  });

  it('distinguishes list, filtered batch and bundle attempts from a server detail or mutation', async () => {
    const coordinator = createTransportCoordinator('worker');
    const logger = { log: vi.fn() };
    const stop = coordinator.startReadReporting(logger);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ value: 1 }));
    const transport = createTransport({ ...config, fetcher, coordinator });
    await transport.json('application', 'servers?per_page=100&page=1', schema);
    await transport.json(
      'application',
      'servers?filter%5Buuid%5D=private&per_page=100&page=1',
      schema,
    );
    await transport.json(
      'application',
      'extensions/nickhosting/gateway-inventory',
      schema,
      'POST',
      {},
      false,
      { readOnly: true },
    );
    await transport.json('application', 'servers/external/private-id?include=allocations', schema);
    await transport.json('application', 'servers/7', schema, 'DELETE');
    await transport.json('client', 'servers/7', schema);
    await withProviderReadCaller('worker-reconcile', async () => {
      await transport.json('client', 'servers/fixture/resources', schema);
      await transport.json('client', 'servers/fixture/backups?page=1', schema);
    });
    await transport.json('client', 'servers/fixture/backups/private-uuid', schema);
    await transport.json('application', 'nodes', schema);
    await transport.json('client', 'servers/fixture/backups', schema, 'POST', {});
    stop();
    expect(
      fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('user-agent')),
    ).toEqual([
      'NickPanel/worker',
      'NickPanel/worker',
      'NickPanel/worker',
      'NickPanel/worker',
      null,
      'NickPanel/worker',
      'NickPanel/worker-reconcile',
      'NickPanel/worker-reconcile',
      'NickPanel/worker',
      'NickPanel/worker',
      null,
    ]);
    expect(logger.log).toHaveBeenCalledExactlyOnceWith('info', 'pterodactyl.server_reads', {
      runtime: 'worker',
      from: expect.any(String),
      until: expect.any(String),
      callers: {
        worker: {
          list: 1,
          batch: 1,
          bundle: 1,
          externalDetail: 1,
          otherClient: 2,
          otherApplication: 1,
        },
        'worker-reconcile': { resources: 1, backupList: 1 },
      },
    });
  });

  it('attributes Blueprint reads sent via POST using bounded operation labels', () => {
    const coordinator = createTransportCoordinator('worker');
    const logger = { log: vi.fn() };
    const stop = coordinator.startReadReporting(logger);
    const origin = new URL(config.baseURL);
    const { providerReadAgent } = coordinator;
    const prefix = 'extensions/nickhosting/servers/test-id/';
    for (const op of ['download-urls', 'directory-list']) {
      expect(providerReadAgent('client', 'POST', prefix + op, origin)).toBe('NickPanel/worker');
    }
    expect(
      providerReadAgent(
        'application',
        'POST',
        'extensions/nickhosting/instances/test-id/server-snapshots',
        origin,
      ),
    ).toBe('NickPanel/worker');
    expect(providerReadAgent('client', 'POST', `${prefix}guarded-delete`, origin)).toBeUndefined();
    stop();
    expect(logger.log.mock.calls[0]?.[2].callers).toEqual({
      worker: { directoryList: 1, downloadUrls: 1, serverSnapshots: 1 },
    });
  });

  it('isolates an ambiguous websocket 429 to that server, including other credentials', async () => {
    const coordinator = createTransportCoordinator();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { 'Retry-After': '60', 'X-RateLimit-Limit': '5' },
        }),
      )
      .mockImplementation(async () => Response.json({ value: 1 }));
    const first = createTransport({ ...config, coordinator, fetcher });
    const otherUser = createTransport({
      ...config,
      clientKey: 'another-user',
      coordinator,
      fetcher,
    });
    await expect(first.json('client', 'servers/one/websocket', schema)).rejects.toMatchObject({
      reason: 'rate_limited',
    });
    await expect(otherUser.json('client', 'servers/one/websocket', schema)).rejects.toMatchObject({
      reason: 'rate_limited',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await first.json('client', 'servers/one/resources', schema);
    await first.json('client', 'servers/two/websocket', schema);
    await first.empty('client', 'servers/one/power', 'POST', { signal: 'stop' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('learns a credential-wide cooldown from an ordinary route after an ambiguous resource 429', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
      );
    const transport = createTransport({ ...config, fetcher });
    await expect(transport.json('client', 'servers/one/websocket', schema)).rejects.toMatchObject({
      reason: 'rate_limited',
    });
    await expect(transport.json('client', 'servers/one/resources', schema)).rejects.toMatchObject({
      reason: 'rate_limited',
    });
    await expect(transport.json('client', 'servers/two/websocket', schema)).rejects.toMatchObject({
      reason: 'rate_limited',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shares backup-restore limits within a server without blocking reads, creation or another server', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '900' } }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const transport = createTransport({ ...config, fetcher });
    await expect(
      transport.empty('client', 'servers/one/backups/a/restore', 'POST', {}),
    ).rejects.toMatchObject({ reason: 'rate_limited', retryAfterMs: 300_000 });
    await expect(
      transport.empty('client', 'servers/one/backups/b/restore', 'POST', {}),
    ).rejects.toMatchObject({ reason: 'rate_limited' });
    await transport.empty('client', 'servers/one/backups', 'GET');
    await transport.empty('client', 'servers/one/backups', 'POST', {});
    await transport.empty('client', 'servers/two/backups/a/restore', 'POST', {});
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

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
