import { describe, expect, it, vi } from 'vitest';

import { MissingContainers } from './docker-read-client.js';

import {
  createNetworkObserver,
  type NetworkObserverDependencies,
  parseProcSockets,
} from './network-observer.js';

const header =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
const row = (address: string, state = '0A', inode = '42') =>
  `0: ${address}:63DD 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode} 1 0000000000000000`;
function fixture() {
  const containerId = 'a'.repeat(64),
    networkId = 'b'.repeat(64);
  const container = {
    id: containerId,
    name: '/fixture',
    service: 'Pterodactyl',
    containerType: 'server_process',
    running: true,
    status: 'running',
    networkMode: 'test-bridge',
    networkNames: ['test-bridge'],
    configuredBindings: {
      '25565/tcp': [{ HostIp: '10.0.0.1', HostPort: '25565' }],
      '25565/udp': [{ HostIp: '10.0.0.1', HostPort: '25565' }],
    },
    activeBindings: { '25565/tcp': [{ HostIp: '10.0.0.1', HostPort: '25565' }] },
  };
  const network = {
    id: networkId,
    name: 'test-bridge',
    driver: 'bridge',
    scope: 'local',
    internal: false,
    ipv6: false,
    options: null,
  };
  const io: NetworkObserverDependencies = {
    now: () => 1_800_000_000_000,
    read: vi.fn(async (path) => `${header}\n${path.endsWith('/tcp') ? row('0100007F') : ''}\n`),
    link: vi.fn(async (path) => (path.includes('/fd/') ? 'socket:[42]' : 'net:[100]')),
    namespaceFile: vi.fn(async () => ({ inode: 100n, filesystemType: 0x6e736673n })),
    directory: vi.fn(async () => ['4']),
    interfaces: vi.fn(() => ['127.0.0.1', '10.0.0.1']),
    docker: vi.fn(async (args) => {
      if (args[0] === 'info') return '"test-daemon"';
      if (args[1] === 'ls') return args[0] === 'container' ? containerId : networkId;
      return JSON.stringify(args[0] === 'container' ? container : network);
    }),
  };
  const config = {
    dockerSocket: '/run/test-docker.sock',
    hostProcDirectory: '/host-proc/1',
    expectedHostNamespaceId: 'net:[100]',
    expectedDockerDaemonId: 'test-daemon',
  };
  return { io, config, container, network, observer: () => createNetworkObserver(config, io) };
}

describe('Linux proc network parsers', () => {
  it('decodes IPv4 listener and authenticates process-owned inode', () => {
    expect(
      parseProcSockets(`${header}\n${row('0100007F')}\n`, 'tcp', false, new Set(['42'])),
    ).toEqual([
      { address: '127.0.0.1', port: 25565, transport: 'tcp', inode: '42', processOwned: true },
    ]);
  });
  it('decodes Linux IPv6 words and IPv4-mapped socket addresses', () => {
    expect(
      parseProcSockets(`${header}\n${row('0000000000000000FFFF00000A0200C0')}`, 'tcp', true)[0]
        ?.address,
    ).toBe('::ffff:c000:20a');
    expect(
      parseProcSockets(`${header}\n${row('00000000000000000000000001000000')}`, 'tcp', true)[0]
        ?.address,
    ).toBe('::1');
  });
  it('uses all bound UDP sockets while excluding non-listening TCP sockets', () => {
    expect(parseProcSockets(`${header}\n${row('00000000', '07')}`, 'udp', false)).toHaveLength(1);
    expect(parseProcSockets(`${header}\n${row('00000000', '01')}`, 'tcp', false)).toHaveLength(0);
  });
  it.each([
    'garbage',
    `${header}\nmalformed`,
    `${header}\n${row('GG000000')}`,
    `${header}\n${row('0100007F', 'ZZ')}`,
    `${header}\n${row('0100007F', '0A', 'bad')}`,
  ])('refuses malformed source rather than interpreting absence', (source) => {
    expect(() => parseProcSockets(source, 'tcp', false)).toThrow('integration_unavailable');
  });
});

describe('read-only host network observer', () => {
  it('accepts an independently mounted nsfs proof without a per-boot process PID', async () => {
    const f = fixture();
    const link = f.io.link;
    f.io.link = vi.fn(async (path) => {
      if (path === `${f.config.hostProcDirectory}/ns/net`)
        throw Object.assign(new Error('not a symlink'), { code: 'EINVAL' });
      return link(path);
    });
    expect((await f.observer().observe()).hostNamespaceId).toBe('net:[100]');
    expect(f.io.namespaceFile).toHaveBeenCalledTimes(2);
    expect(f.io.namespaceFile).toHaveBeenCalledWith(`${f.config.hostProcDirectory}/ns/net`);
  });
  it.each([
    { inode: 100n, filesystemType: 0x01021994n },
    { inode: 101n, filesystemType: 0x6e736673n },
    { inode: 0n, filesystemType: 0x6e736673n },
  ])('rejects ordinary files and foreign mounted namespaces: %s', async (identity) => {
    const f = fixture();
    const link = f.io.link;
    f.io.link = vi.fn(async (path) => {
      if (path === `${f.config.hostProcDirectory}/ns/net`)
        throw Object.assign(new Error('not a symlink'), { code: 'EINVAL' });
      return link(path);
    });
    f.io.namespaceFile = vi.fn(async () => identity);
    await expect(f.observer().observe()).rejects.toMatchObject({ reason: 'namespace' });
    expect(f.io.docker).not.toHaveBeenCalled();
  });
  it('rejects replacement of the mounted namespace during observation', async () => {
    const f = fixture();
    const link = f.io.link;
    f.io.link = vi.fn(async (path) => {
      if (path === `${f.config.hostProcDirectory}/ns/net`)
        throw Object.assign(new Error('not a symlink'), { code: 'EINVAL' });
      return link(path);
    });
    f.io.namespaceFile = vi
      .fn()
      .mockResolvedValueOnce({ inode: 100n, filesystemType: 0x6e736673n })
      .mockResolvedValueOnce({ inode: 101n, filesystemType: 0x6e736673n });
    await expect(f.observer().observe()).rejects.toMatchObject({ reason: 'namespace' });
  });
  it.each(['EACCES', 'ENOENT'])(
    'does not bypass an unreadable/missing proc proof: %s',
    async (code) => {
      const f = fixture();
      const link = f.io.link;
      f.io.link = vi.fn(async (path) => {
        if (path === `${f.config.hostProcDirectory}/ns/net`)
          throw Object.assign(new Error('unavailable'), { code });
        return link(path);
      });
      await expect(f.observer().observe()).rejects.toMatchObject({ reason: 'namespace' });
      expect(f.io.namespaceFile).not.toHaveBeenCalled();
    },
  );
  it('verifies namespace/daemon, all container bindings and actual network metadata', async () => {
    const f = fixture();
    const result = await f.observer().observe();
    expect(result.namespaceId).toBe(result.hostNamespaceId);
    expect(result.containers[0]?.configuredBindings).toHaveLength(2);
    expect(result.networks[0]?.options).toEqual({});
    expect(result.sockets[0]?.processOwned).toBe(true);
    expect(f.io.docker).toHaveBeenCalledWith(
      ['container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}'],
      f.config.dockerSocket,
      15000,
    );
    for (const [args] of vi.mocked(f.io.docker).mock.calls) {
      expect(args.join(' ')).not.toContain('.Config.Env');
      expect(['info', 'container', 'network']).toContain(args[0]);
      expect(
        args.some((arg) =>
          ['start', 'stop', 'create', 'rm', 'connect', 'disconnect'].includes(arg),
        ),
      ).toBe(false);
    }
  });
  it('inspects complete large inventories with at most four concurrent chunks across both kinds', async () => {
    const f = fixture();
    const containers = Array.from({ length: 310 }, (_, index) => ({
      ...f.container,
      id: (index + 1).toString(16).padStart(64, '0'),
      name: `/container-${index}`,
      running: index % 2 === 0,
      status: index % 2 === 0 ? 'running' : 'exited',
    }));
    const networks = Array.from({ length: 65 }, (_, index) => ({
      ...f.network,
      id: (index + 1000).toString(16).padStart(64, '0'),
      name: `network-${index}`,
    }));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = f.io.docker;
    let active = 0;
    let maximum = 0;
    let inspected = 0;
    f.io.docker = vi.fn(async (args, socket) => {
      if (args[0] === 'info') return original(args, socket);
      const inventory = args[0] === 'container' ? containers : networks;
      if (args[1] === 'ls')
        return inventory
          .map((row) => row.id)
          .reverse()
          .join('\n');
      maximum = Math.max(maximum, ++active);
      if (active === 4) entered.resolve();
      await release.promise;
      const requested = args.slice(4);
      expect(requested.length).toBeLessThanOrEqual(64);
      inspected += requested.length;
      active--;
      return inventory
        .filter((row) => requested.includes(row.id))
        .reverse()
        .map((row) => JSON.stringify(row))
        .join('\n');
    });
    const observing = f.observer().observe();
    await entered.promise;
    expect(active).toBe(4);
    release.resolve();
    const observation = await observing;
    expect(maximum).toBe(4);
    expect(inspected).toBe(375);
    expect(observation.containers.map((row) => row.id)).toEqual(containers.map((row) => row.id));
    expect(observation.networks.map((row) => row.id)).toEqual(networks.map((row) => row.id));
    expect(vi.mocked(f.io.docker).mock.calls.filter(([args]) => args[1] === 'ls')).toHaveLength(4);
  });

  it('normalizes empty Docker HostIp to wildcard, never exact ownership', async () => {
    const f = fixture();
    Object.assign(f.container.configuredBindings['25565/tcp'][0] ?? {}, { HostIp: '' });
    expect((await f.observer().observe()).containers[0]?.configuredBindings[0]?.address).toBe(
      '0.0.0.0',
    );
  });
  it('refuses foreign Docker daemon identity before collecting metadata', async () => {
    const f = fixture();
    f.config.expectedDockerDaemonId = 'foreign';
    await expect(f.observer().observe()).rejects.toThrow('integration_unavailable');
    expect(f.io.docker).toHaveBeenCalledTimes(1);
  });
  it('refuses unknown, bridged or unreadable host namespace identity', async () => {
    const f = fixture();
    f.io.link = vi.fn(async (path) => (path.startsWith('/host-proc') ? 'net:[101]' : 'net:[100]'));
    await expect(f.observer().observe()).rejects.toThrow('integration_unavailable');
    f.io.link = vi.fn(async () => {
      throw new Error('private-path-secret');
    });
    await expect(f.observer().observe()).rejects.toThrow(/^integration_unavailable$/);
  });
  it('rejects persistent container list churn after one complete retry', async () => {
    const f = fixture();
    const original = f.io.docker;
    let listed = 0;
    f.io.docker = vi.fn(async (args, socket) =>
      args[0] === 'container' && args[1] === 'ls' && ++listed % 2 === 0
        ? ''
        : original(args, socket),
    );
    await expect(f.observer().observe()).rejects.toThrow('integration_unavailable');
  });
  it('rejects unknown port transports and unresolved ephemeral host ports', async () => {
    const f = fixture();
    Object.assign(f.container.configuredBindings, { '25565/sctp': [] });
    await expect(f.observer().observe()).rejects.toThrow('integration_unavailable');
    delete (f.container.configuredBindings as Record<string, unknown>)['25565/sctp'];
    Object.assign(f.container.configuredBindings['25565/tcp'][0] ?? {}, { HostPort: '0' });
    f.container.running = false;
    f.container.status = 'restarting';
    await expect(f.observer().observe()).rejects.toThrow('integration_unavailable');
  });
  it('resolves a running unrelated container random host port against actual published bindings', async () => {
    const f = fixture();
    Object.assign(f.container.configuredBindings['25565/tcp'][0] ?? {}, { HostPort: '' });
    Object.assign(f.container.activeBindings['25565/tcp'][0] ?? {}, { HostPort: '31000' });
    expect((await f.observer().observe()).containers[0]?.configuredBindings[0]?.port).toBe(31000);
  });
  it.each(['internal-network', 'stopped'] as const)(
    'recognizes a proven unassigned random publication: %s',
    async (reason) => {
      const f = fixture();
      Object.assign(f.container.configuredBindings['25565/tcp'][0] ?? {}, { HostPort: '' });
      f.container.activeBindings = {} as typeof f.container.activeBindings;
      if (reason === 'stopped') {
        f.container.running = false;
        f.container.status = 'exited';
      } else f.network.internal = true;
      const observed = (await f.observer().observe()).containers[0];
      expect(observed?.configuredBindings).toEqual([
        { address: '10.0.0.1', port: 25565, transport: 'udp' },
      ]);
      expect(observed?.unassignedPublications).toEqual([
        { address: '10.0.0.1', containerPort: 25565, transport: 'tcp', reason },
      ]);
    },
  );
  it('refuses random missing publications on a running non-internal or mixed network', async () => {
    const f = fixture();
    Object.assign(f.container.configuredBindings['25565/tcp'][0] ?? {}, { HostPort: '' });
    f.container.activeBindings = {} as typeof f.container.activeBindings;
    await expect(f.observer().observe()).rejects.toThrow('integration_unavailable');
    f.network.internal = true;
    f.container.networkNames.push('unknown-network');
    await expect(f.observer().observe()).rejects.toThrow('integration_unavailable');
  });
  it('fails closed when any socket table cannot be read', async () => {
    const f = fixture();
    f.io.read = vi.fn(async () => {
      throw new Error('denied');
    });
    await expect(f.observer().observe()).rejects.toThrow('integration_unavailable');
  });
  it('does not infer socket ownership from a closed or unreadable descriptor', async () => {
    const f = fixture();
    f.io.link = vi.fn(async (path) => {
      if (path.includes('/fd/')) throw new Error('closed');
      return 'net:[100]';
    });
    expect((await f.observer().observe()).sockets[0]?.processOwned).toBe(false);
  });
  it('refuses stale observation after slow Docker metadata calls', async () => {
    const f = fixture();
    let calls = 0;
    f.io.now = () => 1_800_000_000_000 + calls++ * 16000;
    await expect(f.observer().observe()).rejects.toThrow('integration_unavailable');
  });
  it.each(['/run/../docker.sock', '/run/docker.sock/', 'relative', '/run/docker.sock?host=remote'])(
    'rejects ambiguous Docker socket %s',
    (dockerSocket) => {
      const f = fixture();
      expect(() => createNetworkObserver({ ...f.config, dockerSocket }, f.io)).toThrow(
        'configuration_invalid',
      );
    },
  );
});

describe('bounded complete-inventory retry during Wings recreation', () => {
  it('restarts a whole observation after a valid first inventory is replaced between lists', async () => {
    const f = fixture();
    const old = f.container.id;
    const replacement = 'c'.repeat(64);
    const original = f.io.docker;
    let lists = 0;
    f.io.docker = vi.fn(async (args, socket) => {
      if (args[0] === 'container' && args[1] === 'ls') {
        lists++;
        if (lists >= 2) {
          f.container.id = replacement;
          return replacement;
        }
        return old;
      }
      return original(args, socket);
    });
    const result = await f.observer().observe();
    expect(result.containers.map((container) => container.id)).toEqual([replacement]);
    expect(lists).toBe(4);
    expect(vi.mocked(f.io.docker).mock.calls.filter(([args]) => args[0] === 'info')).toHaveLength(
      2,
    );
  });
});

describe('container retry safety and bounded diagnostics', () => {
  it('requires disappearance of every exact missing ID and rejects malformed sibling evidence', async () => {
    const f = fixture();
    const original = f.io.docker;
    f.io.docker = vi.fn(async (args, socket) => {
      if (args[0] === 'container' && args[1] === 'inspect')
        throw new MissingContainers([f.container.id]);
      return original(args, socket);
    });
    await expect(f.observer().observe()).rejects.toMatchObject({ reason: 'container_inspect' });
    const previous = f.io.docker;
    f.io.docker = vi.fn(async (args, socket) => {
      if (args[0] === 'network' && args[1] === 'inspect') return '{invalid';
      return previous(args, socket);
    });
    await expect(f.observer().observe()).rejects.toMatchObject({ reason: 'network_parse' });
  });
  it('corroborates native 404 disappearance before rereading replacement bindings', async () => {
    const f = fixture();
    const old = f.container.id;
    const original = f.io.docker;
    let disappeared = false;
    f.io.docker = vi.fn(async (args, socket) => {
      if (args[0] === 'container' && args[1] === 'ls') return f.container.id;
      if (args[0] === 'container' && args[1] === 'inspect' && !disappeared) {
        disappeared = true;
        f.container.id = 'c'.repeat(64);
        f.container.configuredBindings['25565/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '28000' }];
        throw new MissingContainers([old]);
      }
      return original(args, socket);
    });
    const result = await f.observer().observe();
    expect(result.containers[0]?.id).toBe(f.container.id);
    expect(result.containers[0]?.configuredBindings).toContainEqual({
      address: '0.0.0.0',
      port: 28000,
      transport: 'tcp',
    });
    expect(vi.mocked(f.io.docker).mock.calls.filter(([args]) => args[0] === 'info')).toHaveLength(
      2,
    );
  });
  it.each(['malformed', 'missing', 'duplicate'] as const)(
    'rejects %s inspect rows before considering an unrelated changed ID set',
    async (kind) => {
      const f = fixture();
      const original = f.io.docker;
      let lists = 0;
      f.io.docker = vi.fn(async (args, socket) => {
        if (args[0] === 'container' && args[1] === 'ls' && ++lists > 1) return 'c'.repeat(64);
        if (args[0] === 'container' && args[1] === 'inspect') {
          if (kind === 'malformed') return '{bad';
          if (kind === 'missing') return JSON.stringify({ ...f.container, id: 'c'.repeat(64) });
          return `${JSON.stringify(f.container)}\n${JSON.stringify(f.container)}`;
        }
        return original(args, socket);
      });
      await expect(f.observer().observe()).rejects.toMatchObject({
        reason: kind === 'malformed' ? 'container_parse' : 'container_inventory',
      });
      expect(lists).toBe(1);
    },
  );
  it('retains the first observation timestamp and reduces command budgets on the retry', async () => {
    const f = fixture();
    const original = f.io.docker;
    const start = f.io.now();
    let clock = start;
    let lists = 0;
    f.io.now = () => clock;
    f.io.docker = vi.fn(async (args, socket) => {
      if (args[0] === 'container' && args[1] === 'ls' && ++lists >= 2) {
        f.container.id = 'c'.repeat(64);
        clock = start + 11000;
        return f.container.id;
      }
      return original(args, socket);
    });
    expect((await f.observer().observe()).observedAt).toBe(start);
    const daemonCalls = vi.mocked(f.io.docker).mock.calls.filter(([args]) => args[0] === 'info');
    expect(daemonCalls.map((call) => call[2])).toEqual([15000, 4000]);
  });
  it('does not start a retry after the original deadline', async () => {
    const f = fixture();
    const original = f.io.docker;
    const start = f.io.now();
    let clock = start;
    let lists = 0;
    f.io.now = () => clock;
    f.io.docker = vi.fn(async (args, socket) => {
      if (args[0] === 'container' && args[1] === 'ls' && ++lists > 1) {
        clock = start + 15000;
        return '';
      }
      return original(args, socket);
    });
    await expect(f.observer().observe()).rejects.toMatchObject({ reason: 'observation_timeout' });
    expect(vi.mocked(f.io.docker).mock.calls.filter(([args]) => args[0] === 'info')).toHaveLength(
      1,
    );
  });
  it.each([
    [
      'namespace',
      (f: ReturnType<typeof fixture>) => {
        f.io.link = async () => {
          throw new Error('secret');
        };
      },
    ],
    [
      'socket_observation',
      (f: ReturnType<typeof fixture>) => {
        f.io.read = async () => {
          throw new Error('secret');
        };
      },
    ],
    [
      'interfaces',
      (f: ReturnType<typeof fixture>) => {
        f.io.interfaces = () => [];
      },
    ],
    [
      'daemon_command',
      (f: ReturnType<typeof fixture>) => {
        f.io.docker = async () => {
          throw new Error('secret');
        };
      },
    ],
  ] as const)('classifies %s failures without raw diagnostics or retry', async (reason, mutate) => {
    const f = fixture();
    mutate(f);
    await expect(f.observer().observe()).rejects.toMatchObject({
      message: 'integration_unavailable',
      reason,
    });
  });
});

describe('complete fresh replacement evidence', () => {
  it('corroborates all missing IDs across parallel chunks before allowing a retry', async () => {
    const f = fixture();
    const ids = Array.from({ length: 65 }, (_, index) =>
      (index + 1).toString(16).padStart(64, '0'),
    );
    const original = f.io.docker;
    let lists = 0;
    f.io.docker = vi.fn(async (args, socket) => {
      if (args[0] === 'container' && args[1] === 'ls')
        return (++lists === 1 ? ids : ids.slice(1)).join('\n');
      if (args[0] === 'container' && args[1] === 'inspect')
        throw new MissingContainers([args[4] as string]);
      return original(args, socket);
    });
    await expect(f.observer().observe()).rejects.toMatchObject({ reason: 'container_inspect' });
    expect(vi.mocked(f.io.docker).mock.calls.filter(([args]) => args[0] === 'info')).toHaveLength(
      1,
    );
  });
  it('stops an unresolved command at the original wall deadline without beginning another attempt', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.io.docker = vi.fn(() => new Promise<string>(() => {}));
      const result = f.observer().observe();
      const rejected = expect(result).rejects.toMatchObject({ reason: 'observation_timeout' });
      await vi.advanceTimersByTimeAsync(15000);
      await rejected;
      expect(f.io.docker).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
