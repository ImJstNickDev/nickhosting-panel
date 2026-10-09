import { describe, expect, it, vi } from 'vitest';
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
  it('rejects container list changes during observation', async () => {
    const f = fixture();
    const original = f.io.docker;
    let listed = 0;
    f.io.docker = vi.fn(async (args, socket) =>
      args[0] === 'container' && args[1] === 'ls' && ++listed > 1 ? '' : original(args, socket),
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
