import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => vi.mocked(execFile).mockReset());

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
  it.each(['Error response from daemon: No such container:', 'Error: No such object:'])(
    'corroborates Docker CLI missing-object output (%s) before complete retry',
    async (prefix) => {
      const f = fixture();
      const replacement = 'c'.repeat(64);
      let missing = true;
      vi.mocked(execFile).mockImplementation(((
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const command = args.slice(2);
        if (command[0] === 'container' && command[1] === 'inspect' && missing) {
          const old = f.container.id;
          missing = false;
          f.container.id = replacement;
          queueMicrotask(() =>
            callback(
              Object.assign(new Error('private command output'), {
                code: 1,
                killed: false,
                signal: null,
              }),
              '',
              `${prefix} ${old}\n`,
            ),
          );
        } else {
          void (
            command[0] === 'container' && command[1] === 'ls'
              ? Promise.resolve(f.container.id)
              : f.io.docker(command, f.config.dockerSocket)
          ).then((stdout) => callback(null, stdout, ''));
        }
        return {};
      }) as typeof execFile);
      const { docker: _docker, ...dependencies } = f.io;
      const result = await createNetworkObserver(f.config, dependencies).observe();
      expect(result.containers.map((container) => container.id)).toEqual([replacement]);
      expect(
        vi.mocked(execFile).mock.calls.filter((call) => (call[1] as string[])[2] === 'info'),
      ).toHaveLength(2);
    },
  );
});

function useCliFixture(
  f: ReturnType<typeof fixture>,
  inspect: () => {
    stdout: string;
    stderr: string;
    code?: number;
    killed?: boolean;
    signal?: string | null;
  },
  networkInspect?: () => string,
) {
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const command = args.slice(2);
    if (command[0] === 'container' && command[1] === 'inspect') {
      const output = inspect();
      queueMicrotask(() =>
        callback(
          Object.assign(new Error('secret CLI path'), {
            code: output.code ?? 1,
            killed: output.killed ?? false,
            signal: output.signal ?? null,
          }),
          output.stdout,
          output.stderr,
        ),
      );
    } else {
      void (
        command[0] === 'container' && command[1] === 'ls'
          ? Promise.resolve(f.container.id)
          : command[0] === 'network' && command[1] === 'inspect' && networkInspect
            ? Promise.resolve(networkInspect())
            : f.io.docker(command, f.config.dockerSocket)
      ).then((stdout) => callback(null, stdout, ''));
    }
    return {};
  }) as typeof execFile);
  const { docker: _docker, ...dependencies } = f.io;
  return createNetworkObserver(f.config, dependencies);
}

describe('container retry safety and bounded diagnostics', () => {
  it.each([
    {
      name: 'permission failure despite disappearance',
      stderr: 'permission denied /private/path',
      reason: 'container_inspect',
    },
    {
      name: 'mixed missing and permission errors',
      stderr: 'Error: No such object: ID\npermission denied',
      reason: 'container_inspect',
    },
    {
      name: 'unrequested missing ID',
      stderr: `Error: No such object: ${'d'.repeat(64)}`,
      reason: 'container_inspect',
    },
    {
      name: 'killed command',
      stderr: 'Error: No such object: ID',
      killed: true,
      reason: 'container_inspect',
    },
    {
      name: 'signal termination',
      stderr: 'Error: No such object: ID',
      signal: 'SIGTERM',
      reason: 'container_inspect',
    },
    {
      name: 'wrong exit status',
      stderr: 'Error: No such object: ID',
      code: 2,
      reason: 'container_inspect',
    },
    {
      name: 'malformed partial stdout',
      stderr: 'Error: No such object: ID',
      stdout: '{invalid-secret',
      reason: 'container_parse',
    },
  ])('does not retry $name', async ({ stderr, stdout = '', reason, ...error }) => {
    const f = fixture();
    const old = f.container.id;
    const observer = useCliFixture(f, () => {
      f.container.id = 'c'.repeat(64);
      return { stderr: stderr.replace('ID', old), stdout, ...error };
    });
    const failure = await observer.observe().catch((caught: unknown) => caught);
    expect(failure).toMatchObject({ message: 'integration_unavailable', reason });
    expect(JSON.stringify(failure)).not.toContain('secret');
    expect(
      vi.mocked(execFile).mock.calls.filter((call) => (call[1] as string[])[2] === 'info'),
    ).toHaveLength(1);
  });
  it('requires disappearance of the exact missing ID, not merely another changed ID', async () => {
    const f = fixture();
    await expect(
      useCliFixture(f, () => ({
        stdout: '',
        stderr: `Error: No such object: ${f.container.id}`,
      })).observe(),
    ).rejects.toMatchObject({ reason: 'container_inspect' });
  });
  it('rejects malformed sibling network output even when exact container disappearance is corroborated', async () => {
    const f = fixture();
    const old = f.container.id;
    const observer = useCliFixture(
      f,
      () => {
        f.container.id = 'c'.repeat(64);
        return { stdout: '', stderr: `Error: No such object: ${old}` };
      },
      () => '{invalid network',
    );
    await expect(observer.observe()).rejects.toMatchObject({ reason: 'network_parse' });
    expect(
      vi.mocked(execFile).mock.calls.filter((call) => (call[1] as string[])[2] === 'info'),
    ).toHaveLength(1);
  });
  it('rejects simultaneous network inventory change instead of retrying container disappearance', async () => {
    const f = fixture();
    const old = f.container.id;
    const original = f.io.docker;
    let networkLists = 0;
    f.io.docker = vi.fn(async (args, socket) =>
      args[0] === 'network' && args[1] === 'ls' && ++networkLists > 1 ? '' : original(args, socket),
    );
    const observer = useCliFixture(f, () => {
      f.container.id = 'c'.repeat(64);
      return { stdout: '', stderr: `Error: No such object: ${old}` };
    });
    await expect(observer.observe()).rejects.toMatchObject({ reason: 'network_inventory' });
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
  it('accepts a corroborated missing batch only with complete valid surviving rows, then rereads changed bindings', async () => {
    const f = fixture();
    const old = f.container.id;
    const survivor = { ...f.container, id: 'c'.repeat(64), name: '/survivor' };
    let disappeared = false;
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const command = args.slice(2);
      if (command[0] === 'container' && command[1] === 'ls') {
        queueMicrotask(() =>
          callback(null, disappeared ? survivor.id : `${old}\n${survivor.id}`, ''),
        );
      } else if (command[0] === 'container' && command[1] === 'inspect') {
        if (!disappeared) {
          disappeared = true;
          const partial = JSON.stringify(survivor);
          survivor.activeBindings = { '25565/tcp': [{ HostIp: '0.0.0.0', HostPort: '28000' }] };
          survivor.configuredBindings = {
            ...survivor.configuredBindings,
            '25565/tcp': survivor.activeBindings['25565/tcp'],
          };
          queueMicrotask(() =>
            callback(
              Object.assign(new Error('private'), { code: 1, killed: false, signal: null }),
              partial,
              `Error response from daemon: No such container: ${old}`,
            ),
          );
        } else queueMicrotask(() => callback(null, JSON.stringify(survivor), ''));
      } else
        void f.io
          .docker(command, f.config.dockerSocket)
          .then((stdout) => callback(null, stdout, ''));
      return {};
    }) as typeof execFile);
    const { docker: _docker, ...dependencies } = f.io;
    const observation = await createNetworkObserver(f.config, dependencies).observe();
    expect(observation.containers.map((container) => container.id)).toEqual([survivor.id]);
    expect(observation.containers[0]?.configuredBindings).toContainEqual({
      address: '0.0.0.0',
      port: 28000,
      transport: 'tcp',
    });
    expect(observation.containers[0]?.activeBindings).toContainEqual({
      address: '0.0.0.0',
      port: 28000,
      transport: 'tcp',
    });
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
