import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import type { ConsoleEvent, ConsoleRelay } from './console.js';
import {
  createPterodactylAdapter,
  type FileReadTiming,
  type ProvisionPlan,
  PterodactylError,
} from './index.js';

export const fixtureUUID = 'f729c8a1-6773-467a-af3f-a7ea8704f0bd';
export const limits = { memory: 128, swap: 0, disk: 256, io: 500, cpu: 25, threads: null };
export const features = { databases: 0, allocations: 2, backups: 1 };
export const server = {
  id: 20,
  external_id: 'nh:fixture',
  uuid: fixtureUUID,
  identifier: 'f729c8a1',
  name: 'fixture',
  description: '',
  suspended: false,
  limits,
  feature_limits: features,
  user: 2,
  node: 3,
  allocation: 10,
  nest: 1,
  egg: 4,
  status: 'installing',
  container: {
    startup_command: 'fixture',
    image: 'fixture:image',
    installed: 0,
    environment: { GAME_SECRET: 'do-not-expose' },
  },
  created_at: '2026-10-09T00:00:00Z',
  updated_at: '2026-10-09T00:00:00Z',
};
export const clientServer = {
  server_owner: true,
  identifier: 'f729c8a1',
  uuid: fixtureUUID,
  name: 'fixture',
  description: '',
  limits,
  feature_limits: features,
  is_suspended: false,
  is_installing: true,
};
const node = {
  id: 3,
  uuid: fixtureUUID,
  name: 'fixture',
  fqdn: 'wings.example.com',
  scheme: 'https',
  memory: 1024,
  memory_overallocate: 0,
  disk: 8192,
  disk_overallocate: 0,
  daemon_listen: 8080,
  location_id: 1,
  allocated_resources: { memory: 16384, disk: 16384 },
  daemon_token: 'never-expose',
};
const plan: ProvisionPlan = {
  name: 'fixture',
  externalId: 'nh:fixture',
  userId: 2,
  eggId: 4,
  dockerImage: 'fixture:image',
  startup: 'fixture',
  environment: { PORT: '12345' },
  limits,
  featureLimits: features,
  allocation: { default: 10, additional: [11] },
};
const list = (items: unknown[], page = 1, pages = 1) =>
  Response.json({
    object: 'list',
    data: items.map((attributes) => ({ attributes })),
    meta: {
      pagination: {
        current_page: page,
        total_pages: pages,
        links: { next: 'https://attacker.invalid/steal' },
      },
    },
  });
const config = {
  baseURL: 'https://panel.example.com',
  applicationKey: 'app-fixture-secret',
  clientKey: 'client-fixture-secret',
};

function fileReadTiming(onStart: (name: string) => void = () => {}) {
  let now = 0;
  const durations: Record<string, number> = {};
  const timing: FileReadTiming = {
    async measure(name, work) {
      const start = now;
      onStart(name);
      try {
        return await work();
      } finally {
        durations[name] = now - start;
      }
    },
    measureSync(name, work) {
      const start = now;
      onStart(name);
      try {
        return work();
      } finally {
        durations[name] = now - start;
      }
    },
  };
  return { timing, durations, advance: (ms: number) => (now += ms) };
}

describe('typed Pterodactyl boundary', () => {
  it('deduplicates filtered server lookup, includes allocations and preserves bounded pagination across chunks', async () => {
    const uuids = Array.from(
      { length: 49 },
      (_, index) => `f729c8a1-6773-467a-af3f-${String(index + 1).padStart(12, '0')}`,
    );
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(config.baseURL);
      expect(url.pathname).toBe('/api/application/servers');
      expect(url.searchParams.get('include')).toBe('allocations');
      const chunk = url.searchParams.get('filter[uuid]')?.split(',') ?? [];
      expect(chunk.length).toBeLessThanOrEqual(48);
      expect(url.toString().length).toBeLessThan(2100);
      const page = Number(url.searchParams.get('page'));
      const paginated = chunk.length === 48;
      const records = (paginated ? chunk.slice((page - 1) * 24, page * 24) : chunk).map((uuid) => ({
        ...server,
        id: uuids.indexOf(uuid) + 1,
        uuid,
        relationships: {
          allocations: {
            object: 'list',
            data: [{ attributes: { id: 10, ip: '127.0.0.1', port: 25565, assigned: true } }],
          },
        },
      }));
      return list(records, page, paginated ? 2 : 1);
    });
    const found = await createPterodactylAdapter({ ...config, fetcher }).getApplicationServers([
      ...uuids,
      uuids[0] ?? fixtureUUID,
    ]);
    expect(found.map((entry) => entry.uuid)).toEqual(uuids);
    expect(found[0]?.relationships?.allocations?.data[0]?.attributes.id).toBe(10);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls.every(([, request]) => !request?.method || request.method === 'GET'),
    ).toBe(true);
  });

  it.each(['unexpected', 'duplicate-uuid', 'duplicate-id', 'malformed-allocations'] as const)(
    'rejects %s in a filtered server response without per-server fallback',
    async (failure) => {
      const otherUuid = 'f729c8a1-6773-467a-af3f-a7ea8704f0be';
      const second = { ...server, uuid: otherUuid, id: 21 };
      const records =
        failure === 'unexpected'
          ? [second]
          : failure === 'duplicate-uuid'
            ? [server, server]
            : failure === 'duplicate-id'
              ? [server, { ...second, id: server.id }]
              : [
                  {
                    ...server,
                    relationships: {
                      allocations: { object: 'list', data: [{ attributes: { id: 'invalid' } }] },
                    },
                  },
                ];
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(list(records));
      const requested = failure === 'duplicate-id' ? [fixtureUUID, otherUuid] : [fixtureUUID];
      await expect(
        createPterodactylAdapter({ ...config, fetcher }).getApplicationServers(requested),
      ).rejects.toMatchObject({ reason: 'invalid_response' });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it('rejects duplicate filtered servers across pagination and reports omitted members without retrying individuals', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(list([server], 1, 2))
      .mockResolvedValueOnce(list([server], 2, 2))
      .mockResolvedValueOnce(list([]));
    const adapter = createPterodactylAdapter({ ...config, fetcher });
    await expect(adapter.getApplicationServers([fixtureUUID])).rejects.toMatchObject({
      reason: 'invalid_response',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(adapter.getApplicationServers([fixtureUUID])).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('bounds and validates server UUID selectors before any provider request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = createPterodactylAdapter({ ...config, fetcher });
    await expect(adapter.getApplicationServers([])).resolves.toEqual([]);
    await expect(adapter.getApplicationServers(['foreign,selector'])).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(
      adapter.getApplicationServers(Array.from({ length: 1001 }, () => fixtureUUID)),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts installed Panel null_resource configuration on an egg without inheritance', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        attributes: {
          id: 2,
          uuid: fixtureUUID,
          name: 'fixture',
          nest: 1,
          description: null,
          docker_image: 'fixture:image',
          startup: 'fixture',
          config: { stop: 'end', extends: null },
          script: {
            install: 'private-installation-recipe',
            entry: 'bash',
            container: 'fixture:1',
            privileged: false,
            extends: null,
          },
          relationships: { config: { object: 'null_resource', attributes: null } },
        },
      }),
    );
    const egg = await createPterodactylAdapter({ ...config, fetcher }).getEgg(1, 2);
    expect(egg.script?.install).toBe('private-installation-recipe');
    expect(JSON.stringify(egg)).not.toContain('private-installation-recipe');
    expect({ ...egg }).not.toHaveProperty('script');
    expect(egg.config?.stop).toBe('end');
    expect(egg.relationships?.config?.attributes).toBeNull();
  });
  it('exposes only the API account identity and sanitized restore activity', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          attributes: {
            id: 2,
            admin: true,
            email: 'private@example.test',
            username: 'private-name',
          },
        }),
      )
      .mockResolvedValueOnce(
        list([
          {
            id: 'a'.repeat(40),
            event: 'server:backup.restore-complete',
            timestamp: '2026-10-09T00:00:00+00:00',
            properties: { name: 'unique-backup', token: 'private-token' },
            ip: 'private-address',
            actor: { email: 'private@example.test' },
          },
        ]),
      );
    const adapter = createPterodactylAdapter({ ...config, fetcher });
    expect(await adapter.getAccount()).toEqual({ id: 2, admin: true });
    expect(await adapter.listBackupActivity('f729c8a1')).toEqual([
      {
        id: 'a'.repeat(40),
        event: 'server:backup.restore-complete',
        timestamp: '2026-10-09T00:00:00+00:00',
        properties: { name: 'unique-backup' },
      },
    ]);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('filter%5Bevent%5D=backup.restore');
  });
  it('reads bounded recent power receipts and strips private activity metadata', async () => {
    const receipt = {
      id: 'b'.repeat(40),
      event: 'server:power.kill',
      timestamp: '2026-10-10T19:53:12Z',
      is_api: false,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      list(
        [
          {
            ...receipt,
            ip: 'private-address',
            properties: { token: 'private-token' },
            actor: { email: 'private@example.test' },
          },
          { ...receipt, id: 'c'.repeat(40), event: 'server:power.stop' },
        ],
        1,
        9,
      ),
    );
    const rows = await createPterodactylAdapter({ ...config, fetcher }).listPowerActivity(
      'f729c8a1',
    );
    expect(rows).toEqual([receipt, { ...receipt, id: 'c'.repeat(40), event: 'server:power.stop' }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      'filter%5Bevent%5D=server%3Apower.&sort=-timestamp&per_page=100&page=1',
    );
  });
  it.each([
    'ascending',
    'unknown event',
    'missing origin',
    'wrong page',
    'oversized',
    'truncated tie',
  ])('rejects ambiguous power history: %s', async (failure) => {
    const receipt: Record<string, unknown> = {
      id: 'b'.repeat(40),
      event: 'server:power.kill',
      timestamp: '2026-10-10T19:53:12Z',
      is_api: false,
    };
    if (failure === 'unknown event') receipt.event = 'server:power.unknown';
    if (failure === 'missing origin') delete receipt.is_api;
    const rows =
      failure === 'ascending'
        ? [receipt, { ...receipt, timestamp: '2026-10-10T19:53:13Z' }]
        : failure === 'oversized' || failure === 'truncated tie'
          ? Array.from({ length: failure === 'oversized' ? 101 : 100 }, () => receipt)
          : [receipt];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(list(rows, failure === 'wrong page' ? 2 : 1, 2));
    await expect(
      createPterodactylAdapter({ ...config, fetcher }).listPowerActivity('f729c8a1'),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
  });
  it('paginates locally constructed URLs; strips token fields and keeps allocated resources distinct', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(list([node], 1, 2))
      .mockResolvedValueOnce(list([{ ...node, id: 4 }], 2, 2));
    const adapter = createPterodactylAdapter({ ...config, fetcher });
    const nodes = await adapter.listNodes();
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ memory: 1024, allocated_resources: { memory: 16384 } });
    expect(JSON.stringify(nodes)).not.toContain('never-expose');
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://panel.example.com/api/application/nodes?per_page=100&page=1',
      'https://panel.example.com/api/application/nodes?per_page=100&page=2',
    ]);
    for (const [, init] of fetcher.mock.calls)
      expect(init).toMatchObject({
        redirect: 'error',
        headers: { Authorization: 'Bearer app-fixture-secret' },
      });
  });
  it('provisions only explicit allocations with a stable external ID and no automatic start', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ attributes: server }));
    const result = await createPterodactylAdapter({ ...config, fetcher }).createServer(plan);
    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({
      external_id: 'nh:fixture',
      allocation: { default: 10, additional: [11] },
      start_on_completion: false,
    });
    expect(payload).not.toHaveProperty('deploy');
    expect(payload).not.toHaveProperty('node');
    expect(result.container.installed).toBe(0);
    expect(result.status).toBe('installing');
    expect(result.container.environment).toEqual({ GAME_SECRET: 'do-not-expose' });
    expect({ ...result.container }).not.toHaveProperty('environment');
    expect(JSON.stringify(result)).not.toContain('do-not-expose');
    await expect(
      createPterodactylAdapter({ ...config, fetcher }).createServer({
        ...plan,
        allocation: { default: 10, additional: [10] },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('looks up only exact external IDs and treats only explicit 404 as absent', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('secret details', { status: 403 }));
    const adapter = createPterodactylAdapter({ ...config, fetcher });
    await expect(adapter.findServerByExternalId('nh:fixture')).resolves.toBeNull();
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/servers/external/nh%3Afixture');
    await expect(adapter.findServerByExternalId('nh:fixture')).rejects.toMatchObject({
      reason: 'permission_denied',
      outcome: 'rejected',
    });
  });
  it('sends native kill through the Client power endpoint without a console command', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const adapter = createPterodactylAdapter({ ...config, fetcher });
    await adapter.power('f729c8a1', 'kill');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${config.baseURL}/api/client/servers/f729c8a1/power`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer client-fixture-secret' });
    expect(JSON.parse(String(init?.body))).toEqual({ signal: 'kill' });
  });
  it('uses separate Client credentials and checks effective permissions, not a static permission catalog', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          attributes: clientServer,
          meta: { user_permissions: ['control.console', 'file.read'] },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const adapter = createPterodactylAdapter({ ...config, fetcher });
    expect(await adapter.getClientPermissions('f729c8a1')).toEqual([
      'control.console',
      'file.read',
    ]);
    await adapter.power('f729c8a1', 'stop');
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toContain('/api/client/servers/f729c8a1');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer client-fixture-secret' });
    }
    const unavailable = createPterodactylAdapter({
      baseURL: config.baseURL,
      applicationKey: config.applicationKey,
      fetcher,
    });
    await expect(unavailable.power('f729c8a1', 'start')).rejects.toMatchObject({
      reason: 'credential_missing',
      scope: 'client',
      outcome: 'rejected',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 404, 422, 429, 500, 503, 408])(
    'sanitizes HTTP %i and makes uncertain remote mutations explicit',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('private-key token details', { status }));
      try {
        await createPterodactylAdapter({ ...config, fetcher }).power('f729c8a1', 'start');
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(PterodactylError);
        expect(error).toMatchObject({
          outcome: status >= 500 || status === 408 ? 'unknown' : 'rejected',
          upstreamStatus: status,
        });
        expect(JSON.stringify(error)).not.toContain('private-key');
        expect(JSON.stringify(error)).not.toContain(config.clientKey);
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('never repeats an operation whose response was lost after the remote effect', async () => {
    let remoteCreates = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      remoteCreates++;
      throw new DOMException('Bearer secret', 'TimeoutError');
    });
    await expect(
      createPterodactylAdapter({ ...config, fetcher }).createServer(plan),
    ).rejects.toMatchObject({ outcome: 'unknown', reason: 'unavailable' });
    expect(remoteCreates).toBe(1);
  });
  it('treats a successful mutation with malformed confirmation as uncertain', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ unexpected: 'private' }));
    await expect(
      createPterodactylAdapter({ ...config, fetcher }).createServer(plan),
    ).rejects.toMatchObject({ outcome: 'unknown', reason: 'invalid_response' });
  });
  it('rejects pagination mismatch and malformed provider payloads', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(list([node], 2, 3));
    await expect(
      createPterodactylAdapter({ ...config, fetcher }).listNodes(),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
  });
  it('updates explicit build limits without imposing configured aggregate node capacity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ attributes: server }));
    await createPterodactylAdapter({ ...config, fetcher }).updateBuild(20, {
      ...limits,
      memory: 8192,
      allocation: 10,
      feature_limits: features,
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/servers/20/build');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      memory: 8192,
      allocation: 10,
      feature_limits: features,
    });
  });
  it('reports missing discovery scopes without suggesting automatic permission changes', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).includes('users') ? new Response('secret', { status: 403 }) : list([]),
      );
    expect(
      await createPterodactylAdapter({ ...config, fetcher }).discoverCapabilities(),
    ).toMatchObject({
      nodes: { available: true },
      users: { available: false, reason: 'permission_denied', scope: 'application' },
      client: { available: true },
    });
  });
});

describe('files and backup credential isolation', () => {
  it('separates delayed file response headers from delayed body reception', async () => {
    const headers = Promise.withResolvers<Response>();
    const bodyStarted = Promise.withResolvers<void>();
    const phases: string[] = [];
    const trace = fileReadTiming((name) => {
      phases.push(name);
      if (name === 'file.bodyRead') bodyStarted.resolve();
    });
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
      }),
    );
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(headers.promise);
    const reading = createPterodactylAdapter({ ...config, fetcher }).readFile(
      'f729c8a1',
      'fixture.txt',
      16,
      trace.timing,
    );
    expect(phases).toEqual(['file.httpHeaders']);
    trace.advance(170);
    headers.resolve(response);
    await bodyStarted.promise;
    expect(trace.durations).toEqual({ 'file.httpHeaders': 170 });
    trace.advance(47);
    bodyController.enqueue(new TextEncoder().encode('fixture'));
    bodyController.close();
    expect(new TextDecoder().decode(await reading)).toBe('fixture');
    expect(phases).toEqual(['file.httpHeaders', 'file.bodyRead']);
    expect(trace.durations).toEqual({ 'file.httpHeaders': 170, 'file.bodyRead': 47 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('finishes header timing on provider rejection without starting body timing', async () => {
    const trace = fileReadTiming();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      trace.advance(30);
      return new Response('private provider details', { status: 403 });
    });
    await expect(
      createPterodactylAdapter({ ...config, fetcher }).readFile(
        'f729c8a1',
        'fixture.txt',
        16,
        trace.timing,
      ),
    ).rejects.toMatchObject({ reason: 'permission_denied', scope: 'client' });
    expect(trace.durations).toEqual({ 'file.httpHeaders': 30 });
  });
  it.each(['declared-overflow', 'stream-overflow', 'body-error'] as const)(
    'records body timing without changing %s error handling',
    async (failure) => {
      const trace = fileReadTiming();
      const cancelled = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            trace.advance(20);
            if (failure === 'body-error') controller.error(new Error('private stream details'));
            else controller.enqueue(new TextEncoder().encode('too much data'));
          },
          cancel: cancelled,
        },
        { highWaterMark: 0 },
      );
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        trace.advance(10);
        return new Response(body, {
          headers: failure === 'declared-overflow' ? { 'content-length': '13' } : {},
        });
      });
      await expect(
        createPterodactylAdapter({ ...config, fetcher }).readFile(
          'f729c8a1',
          'fixture.txt',
          4,
          trace.timing,
        ),
      ).rejects.toMatchObject(
        failure === 'body-error'
          ? { reason: 'invalid_response', scope: 'client' }
          : { code: 'validation_failed', status: 413 },
      );
      expect(trace.durations).toEqual({
        'file.httpHeaders': 10,
        'file.bodyRead': failure === 'declared-overflow' ? 0 : 20,
      });
      expect(cancelled).toHaveBeenCalledTimes(failure === 'body-error' ? 0 : 1);
    },
  );
  it('reads without a debug timer and preserves Client API credentials and request path', async () => {
    const clock = vi.spyOn(performance, 'now');
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('fixture'));
      const contents = await createPterodactylAdapter({ ...config, fetcher }).readFile(
        'f729c8a1',
        'config/fixture.txt',
      );
      expect(new TextDecoder().decode(contents)).toBe('fixture');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0]?.[0])).toBe(
        'https://panel.example.com/api/client/servers/f729c8a1/files/contents?file=%2Fconfig%2Ffixture.txt',
      );
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
        method: 'GET',
        headers: { Authorization: `Bearer ${config.clientKey}` },
        redirect: 'error',
      });
      expect(clock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it.each([
    '../secret',
    '/etc/passwd',
    'safe/../../secret',
    'safe\\secret',
    'safe/%2e%2e/secret',
    'safe//file',
    'safe/./file',
    'file\0secret',
    '',
    'safe/',
  ])('rejects unsafe file path %j before a provider call', async (path) => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = createPterodactylAdapter({ ...config, fetcher });
    await expect(adapter.readFile('f729c8a1', path)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(() => adapter.writeFile('f729c8a1', path, 'safe')).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('writes raw bounded bytes, handles a root wipe as explicit names, and renames safely', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).includes('/files/list')
          ? Response.json({ object: 'list', data: [] })
          : new Response(null, { status: 204 }),
      );
    const adapter = createPterodactylAdapter({ ...config, fetcher });
    await adapter.writeFile('f729c8a1', 'config/server.properties', 'fixture=true');
    await adapter.deleteFiles('f729c8a1', '', ['fixture.txt', 'fixture-dir']);
    await adapter.renameFiles('f729c8a1', 'config', [{ from: 'old.txt', to: 'new.txt' }]);
    expect(
      fetcher.mock.calls.find(([url]) => String(url).includes('/files/write'))?.[1],
    ).toMatchObject({
      body: 'fixture=true',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
    expect(
      JSON.parse(
        String(
          fetcher.mock.calls.find(([url]) => String(url).includes('/files/delete'))?.[1]?.body,
        ),
      ),
    ).toEqual({
      root: '/',
      files: ['fixture.txt', 'fixture-dir'],
    });
    expect(() => adapter.deleteFiles('f729c8a1', '', ['../unrelated'])).toThrow();
    expect(() => adapter.writeFile('f729c8a1', 'large', 'x'.repeat(1048577))).toThrow();
  });
  it.each([204, 403, 500])(
    'times writes without changing raw bytes or error outcomes (%s)',
    async (status) => {
      const trace = fileReadTiming();
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        if (String(url).includes('/files/list')) return Response.json({ object: 'list', data: [] });
        if (String(url).includes('/files/rename') || String(url).includes('/files/delete'))
          return new Response(null, { status: 204 });
        trace.advance(31);
        return new Response(null, { status });
      });
      const adapter = createPterodactylAdapter({ ...config, fetcher });
      const written = adapter.writeFile(
        'f729c8a1',
        'private/server.properties',
        'private=true',
        trace.timing,
      );
      if (status === 204) await expect(written).resolves.toBeUndefined();
      else
        await expect(written).rejects.toMatchObject({
          reason: status === 403 ? 'permission_denied' : 'unavailable',
          outcome: status === 500 ? 'unknown' : 'rejected',
          upstreamStatus: status,
        });
      expect(trace.durations).toEqual({ 'file.write.http': 31 });
      expect(fetcher).toHaveBeenCalledTimes(status === 500 ? 2 : 3);
      expect(
        fetcher.mock.calls.find(([url]) => String(url).includes('/files/write'))?.[1],
      ).toMatchObject({
        method: 'POST',
        body: 'private=true',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
      expect(() =>
        adapter.writeFile('f729c8a1', '../invalid', 'private=true', trace.timing),
      ).toThrow();
      expect(() =>
        adapter.writeFile('f729c8a1', 'large', 'x'.repeat(1048577), trace.timing),
      ).toThrow();
      expect(fetcher).toHaveBeenCalledTimes(status === 500 ? 2 : 3);
    },
  );
  it.each([false, true])(
    'bounds file reads with Content-Length=%s and cancels the body',
    async (declared) => {
      const cancelled = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('too much data'));
        },
        cancel: cancelled,
      });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          headers: declared ? { 'content-length': '13' } : {},
        }),
      );
      await expect(
        createPterodactylAdapter({ ...config, fetcher }).readFile('f729c8a1', 'fixture.txt', 4),
      ).rejects.toMatchObject({ code: 'validation_failed', status: 413 });
      expect(cancelled).toHaveBeenCalledTimes(1);
    },
  );
  it('proxies signed downloads without exposing URLs or forwarding API credentials', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({
          attributes: {
            url: 'https://wings.example.com/download/file?token=signed-fixture-secret',
          },
        }),
      )
      .mockResolvedValueOnce(new Response('fixture-data', { headers: { 'content-length': '12' } }));
    const adapter = createPterodactylAdapter({
      ...config,
      downloadOrigins: ['https://wings.example.com'],
      fetcher,
    });
    const result = await adapter.downloadFile('f729c8a1', 'fixture.txt', { maxBytes: 100 });
    expect(await new Response(result.body).text()).toBe('fixture-data');
    expect(JSON.stringify(result)).not.toContain('signed-fixture-secret');
    expect(new Headers(fetcher.mock.calls[3]?.[1]?.headers).has('Authorization')).toBe(false);
    expect(fetcher.mock.calls[3]?.[1]?.redirect).toBe('error');
  });
  it('refuses an untrusted signed download host before it can receive a request', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ attributes: { url: 'https://attacker.invalid/steal?token=fixture' } }),
      );
    await expect(
      createPterodactylAdapter({ ...config, fetcher }).downloadBackup('f729c8a1', fixtureUUID, {
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ reason: 'unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('limits streamed backup bytes and never exposes raw upstream errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ attributes: { url: 'https://panel.example.com/download?token=fixture' } }),
      )
      .mockResolvedValueOnce(new Response('too long'));
    const result = await createPterodactylAdapter({ ...config, fetcher }).downloadBackup(
      'f729c8a1',
      fixtureUUID,
      { maxBytes: 4 },
    );
    await expect(new Response(result.body).arrayBuffer()).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });
});

it('uses typed backup endpoints and explicit destructive restore semantics', async () => {
  const backup = {
    uuid: fixtureUUID,
    is_successful: false,
    is_locked: false,
    name: 'fixture',
    ignored_files: [],
    checksum: null,
    bytes: 0,
    created_at: '2026-10-09T00:00:00Z',
    completed_at: null,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ attributes: backup }))
    .mockResolvedValueOnce(list([backup]))
    .mockResolvedValueOnce(
      Response.json({
        attributes: { ...backup, is_successful: true, completed_at: '2026-10-09T00:01:00Z' },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const adapter = createPterodactylAdapter({ ...config, fetcher });
  expect(
    (await adapter.createBackup('f729c8a1', { name: 'fixture', ignored: '*.tmp' })).is_successful,
  ).toBe(false);
  expect(await adapter.listBackups('f729c8a1')).toHaveLength(1);
  expect((await adapter.getBackup('f729c8a1', fixtureUUID)).is_successful).toBe(true);
  await adapter.restoreBackup('f729c8a1', fixtureUUID, true);
  await adapter.deleteBackup('f729c8a1', fixtureUUID);
  expect(
    fetcher.mock.calls.map(([url, init]) => ({
      path: new URL(String(url)).pathname,
      method: init?.method,
    })),
  ).toEqual([
    { path: '/api/client/servers/f729c8a1/backups', method: 'POST' },
    { path: '/api/client/servers/f729c8a1/backups', method: 'GET' },
    { path: `/api/client/servers/f729c8a1/backups/${fixtureUUID}`, method: 'GET' },
    { path: `/api/client/servers/f729c8a1/backups/${fixtureUUID}/restore`, method: 'POST' },
    { path: `/api/client/servers/f729c8a1/backups/${fixtureUUID}`, method: 'DELETE' },
  ]);
  expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({ truncate: true });
});

async function withOmittedArgsWire(
  work: (fixture: {
    relay: ConsoleRelay;
    events: ConsoleEvent[];
    incoming: { event: string; args: string[] }[];
    send(frame: { event: string; args?: unknown[] }): void;
  }) => Promise<void>,
) {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  const origin = `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  let connected: WebSocket | undefined;
  const incoming: { event: string; args: string[] }[] = [];
  upstream.on('connection', (socket) => {
    connected = socket;
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      incoming.push(frame);
      // Wings Message.Args uses json omitempty: these control frames have no args key.
      if (frame.event === 'auth') socket.send(JSON.stringify({ event: 'auth success' }));
    });
  });
  const events: ConsoleEvent[] = [];
  let relay: ConsoleRelay | undefined;
  try {
    const adapter = createPterodactylAdapter({
      ...config,
      webSocketOrigins: [origin],
      timeoutMs: 1000,
      fetcher: vi.fn<typeof fetch>().mockImplementation(async (url) =>
        String(url).endsWith('/websocket')
          ? Response.json({
              data: {
                token: `isolated-jwt-${incoming.length}`,
                socket: `${origin}/api/servers/${fixtureUUID}/ws`,
              },
            })
          : Response.json({ attributes: clientServer }),
      ),
    });
    relay = await adapter.relayConsole(clientServer.identifier, {
      authorize: async () => true,
      onEvent: (event) => events.push(event),
    });
    await work({
      relay,
      events,
      incoming,
      send(frame) {
        if (!connected) throw new Error('Isolated WebSocket not connected');
        connected.send(JSON.stringify(frame));
      },
    });
  } finally {
    relay?.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

describe('installed Wings control frame wire compatibility', () => {
  it('authenticates and refreshes when auth success and token expiring omit args', async () => {
    await withOmittedArgsWire(async ({ relay, events, incoming, send }) => {
      expect(incoming[0]?.event).toBe('auth');
      expect(events).toEqual([]);
      send({ event: 'token expiring' });
      await vi.waitFor(() =>
        expect(incoming.filter((frame) => frame.event === 'auth')).toHaveLength(2),
      );
      await relay.requestStats();
      send({ event: 'status', args: ['running'] });
      await vi.waitFor(() => expect(events).toEqual([{ type: 'status', data: 'running' }]));
    });
  });
  it('closes safely when token expired omits args', async () => {
    await withOmittedArgsWire(async ({ events, send }) => {
      send({ event: 'token expired' });
      await vi.waitFor(() =>
        expect(events).toEqual([
          { type: 'error', code: 'integration_unavailable' },
          { type: 'closed' },
        ]),
      );
    });
  });
  it.each(['status', 'console output', 'install output', 'stats'])(
    'still requires a payload for %s',
    async (event) => {
      await withOmittedArgsWire(async ({ events, send }) => {
        send({ event });
        await vi.waitFor(() =>
          expect(events).toEqual([
            { type: 'error', code: 'integration_unavailable' },
            { type: 'closed' },
          ]),
        );
      });
    },
  );
});
