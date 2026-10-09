import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { posix } from 'node:path';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';

export interface NetworkEndpoint {
  address: string;
  port: number;
  transport: 'tcp' | 'udp';
}
export interface ObservedSocket extends NetworkEndpoint {
  inode: string;
  processOwned: boolean;
}
export interface ObservedContainer {
  id: string;
  name: string;
  service: string | null;
  containerType: string | null;
  running: boolean;
  networkMode: string;
  configuredBindings: NetworkEndpoint[];
  activeBindings: NetworkEndpoint[];
  /** Proven declarations with no assigned host port; never includes fixed provider claims. */
  unassignedPublications?: {
    address: string;
    containerPort: number;
    transport: 'tcp' | 'udp';
    reason: 'stopped' | 'internal-network';
  }[];
}
export interface ObservedNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  ipv6: boolean;
  options: Record<string, string>;
}
export interface NetworkObservation {
  observedAt: number;
  namespaceId: string;
  hostNamespaceId: string;
  dockerDaemonId: string;
  interfaceAddresses: string[];
  sockets: ObservedSocket[];
  containers: ObservedContainer[];
  networks: ObservedNetwork[];
}
export interface NetworkObserver {
  observe(): Promise<NetworkObservation>;
}

export interface NetworkObserverDependencies {
  read(path: string): Promise<string>;
  link(path: string): Promise<string>;
  directory(path: string): Promise<string[]>;
  interfaces(): string[];
  docker(args: readonly string[], socket: string): Promise<string>;
  now(): number;
}
const production: NetworkObserverDependencies = {
  read: (path) => readFile(path, 'utf8'),
  link: readlink,
  directory: (path) => readdir(path),
  interfaces: () =>
    Object.values(networkInterfaces())
      .flatMap((addresses) => addresses ?? [])
      .map((address) => address.address),
  now: Date.now,
  docker: (args, socket) =>
    new Promise((resolve, reject) => {
      execFile(
        'docker',
        ['--host', `unix://${socket}`, ...args],
        {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 4 * 1024 * 1024,
          killSignal: 'SIGKILL',
          shell: false,
          env: Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith('DOCKER_')),
          ),
        },
        (error, stdout) => {
          if (error) reject(new DomainError('integration_unavailable'));
          else resolve(stdout);
        },
      );
    }),
};

const id = z.string().regex(/^[a-f0-9]{64}$/);
const bindings = z
  .record(
    z.string().regex(/^\d{1,5}\/(tcp|udp)$/),
    z.array(z.object({ HostIp: z.string(), HostPort: z.string().regex(/^\d{0,5}$/) })).nullable(),
  )
  .nullable();
const containerSchema = z.object({
  id,
  name: z.string().min(2),
  service: z.string().nullable(),
  containerType: z.string().nullable(),
  running: z.boolean(),
  status: z.enum(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']),
  networkMode: z.string().min(1),
  networkNames: z.array(z.string().min(1)),
  configuredBindings: bindings,
  activeBindings: bindings,
});
const networkSchema = z.object({
  id,
  name: z.string().min(1),
  driver: z.string().min(1),
  scope: z.string().min(1),
  internal: z.boolean(),
  ipv6: z.boolean(),
  options: z.record(z.string(), z.string()).nullable(),
});
// Selective formats deliberately exclude container environment, arbitrary labels and state errors.
const containerFormat =
  '{"id":{{json .Id}},"name":{{json .Name}},"service":{{json (index .Config.Labels "Service")}},' +
  '"containerType":{{json (index .Config.Labels "ContainerType")}},"running":{{json .State.Running}},"status":{{json .State.Status}},' +
  '"networkNames":[{{$sep := ""}}{{range $name,$value := .NetworkSettings.Networks}}{{$sep}}{{json $name}}{{$sep = ","}}{{end}}],' +
  '"networkMode":{{json .HostConfig.NetworkMode}},"configuredBindings":{{json .HostConfig.PortBindings}},' +
  '"activeBindings":{{json .NetworkSettings.Ports}}}';
const networkFormat =
  '{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},' +
  '"internal":{{json .Internal}},"ipv6":{{json .EnableIPv6}},"options":{{json .Options}}}';

function absolutePath(value: string) {
  return (
    posix.isAbsolute(value) &&
    posix.normalize(value) === value &&
    value !== '/' &&
    !value.endsWith('/') &&
    !/[?#]/.test(value) &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  );
}
function namespace(value: string) {
  return /^net:\[\d+\]$/.test(value);
}
function port(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error();
  return parsed;
}
function dockerBindings(
  value: z.infer<typeof bindings>,
  active?: z.infer<typeof bindings>,
  unassigned?: {
    reason: 'stopped' | 'internal-network';
    records: NonNullable<ObservedContainer['unassignedPublications']>;
  },
): NetworkEndpoint[] {
  return Object.entries(value ?? {}).flatMap(([key, entries]) => {
    port(key.split('/')[0] ?? '');
    const transport = key.endsWith('/tcp') ? 'tcp' : 'udp';
    return (entries ?? []).flatMap((entry) => {
      if (entry.HostPort === '' || entry.HostPort === '0') {
        // Random host ports require actual running-container bindings. A
        // stopped or unresolved declaration cannot prove a disjoint endpoint.
        const resolved = active?.[key];
        if (!resolved?.length && unassigned) {
          const address = entry.HostIp || '0.0.0.0';
          if (!isIP(address)) throw new Error();
          unassigned.records.push({
            address,
            containerPort: port(key.split('/')[0] ?? ''),
            transport,
            reason: unassigned.reason,
          });
          return [];
        }
        if (
          !resolved?.length ||
          resolved.some((binding) => !binding.HostPort || binding.HostPort === '0')
        )
          throw new Error();
        return dockerBindings({ [key]: resolved });
      }
      // An empty Docker HostIp means all interfaces, never an exact owned address.
      const address = entry.HostIp || '0.0.0.0';
      if (!isIP(address)) throw new Error();
      return [{ address, port: port(entry.HostPort), transport }];
    });
  });
}

/** Linux proc socket tables encode IPv4 and each IPv6 32-bit word little-endian. */
export function parseProcSockets(
  source: string,
  transport: 'tcp' | 'udp',
  ipv6: boolean,
  ownedInodes: ReadonlySet<string> = new Set(),
): ObservedSocket[] {
  if (source.length > 8 * 1024 * 1024) throw new DomainError('integration_unavailable');
  const lines = source.trim().split('\n');
  if (!lines.shift()?.includes('local_address')) throw new DomainError('integration_unavailable');
  return lines
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const endpoint = parts[1]?.split(':');
      const hex = endpoint?.[0];
      const encodedPort = endpoint?.[1];
      const state = parts[3];
      const inode = parts[9];
      if (
        parts.length < 10 ||
        !hex ||
        !new RegExp(`^[0-9A-Fa-f]{${ipv6 ? 32 : 8}}$`).test(hex) ||
        !encodedPort ||
        !/^[0-9A-Fa-f]{4}$/.test(encodedPort) ||
        !state ||
        !/^[0-9A-Fa-f]{2}$/.test(state) ||
        !inode ||
        !/^\d+$/.test(inode)
      )
        throw new DomainError('integration_unavailable');
      const bytes = Buffer.from(hex, 'hex');
      for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse();
      const address = ipv6
        ? new URL(
            `http://[${Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(':')}]`,
          ).hostname.slice(1, -1)
        : [...bytes].join('.');
      return {
        address,
        port: Number.parseInt(encodedPort, 16),
        transport,
        inode,
        processOwned: ownedInodes.has(inode),
        listening: transport === 'udp' || state.toUpperCase() === '0A',
      };
    })
    .filter((row) => row.listening && row.port !== 0)
    .map(({ listening: _listening, ...row }) => row);
}

/** Read-only same-host namespace observation. Bridged/NAT ingress is deliberately unsupported. */
export function createNetworkObserver(
  config: {
    dockerSocket: string;
    hostProcDirectory: string;
    expectedHostNamespaceId: string;
    expectedDockerDaemonId: string;
  },
  dependencies: Partial<NetworkObserverDependencies> = {},
): NetworkObserver {
  if (
    !absolutePath(config.dockerSocket) ||
    !absolutePath(config.hostProcDirectory) ||
    !namespace(config.expectedHostNamespaceId) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(config.expectedDockerDaemonId)
  )
    throw new DomainError('configuration_invalid');
  const io = { ...production, ...dependencies };
  async function command(args: readonly string[]) {
    const value = await io.docker(args, config.dockerSocket);
    if (typeof value !== 'string' || value.length > 4 * 1024 * 1024) throw new Error();
    return value.trim();
  }
  async function ids(kind: 'container' | 'network') {
    const text = await command([
      kind,
      'ls',
      ...(kind === 'container' ? ['--all'] : []),
      '--no-trunc',
      '--format',
      '{{.ID}}',
    ]);
    const rows = text ? text.split('\n').map((row) => id.parse(row)) : [];
    if (new Set(rows).size !== rows.length || rows.length > 10000) throw new Error();
    return rows.sort();
  }
  return {
    async observe() {
      try {
        const started = io.now();
        const [namespaceId, hostNamespaceId] = await Promise.all([
          io.link('/proc/self/ns/net'),
          io.link(`${config.hostProcDirectory}/ns/net`),
        ]);
        if (
          !namespace(namespaceId) ||
          namespaceId !== hostNamespaceId ||
          hostNamespaceId !== config.expectedHostNamespaceId
        )
          throw new Error();
        const dockerDaemonId = JSON.parse(
          await command(['info', '--format', '{{json .ID}}']),
        ) as unknown;
        if (dockerDaemonId !== config.expectedDockerDaemonId) throw new Error();
        const [beforeContainers, beforeNetworks] = await Promise.all([
          ids('container'),
          ids('network'),
        ]);
        const rawContainers: z.infer<typeof containerSchema>[] = [];
        // Bounded batches avoid command-line limits and fail if any container disappears mid-inspection.
        const networks: ObservedNetwork[] = [];
        await Promise.all([
          (async () => {
            for (let start = 0; start < beforeContainers.length; start += 64) {
              const batch = beforeContainers.slice(start, start + 64);
              const result = await command([
                'container',
                'inspect',
                '--format',
                containerFormat,
                ...batch,
              ]);
              for (const line of result.split('\n')) {
                const row = containerSchema.parse(JSON.parse(line));
                rawContainers.push(row);
              }
            }
          })(),
          (async () => {
            for (let start = 0; start < beforeNetworks.length; start += 64) {
              const result = await command([
                'network',
                'inspect',
                '--format',
                networkFormat,
                ...beforeNetworks.slice(start, start + 64),
              ]);
              for (const line of result.split('\n')) {
                const row = networkSchema.parse(JSON.parse(line));
                networks.push({ ...row, options: row.options ?? {} });
              }
            }
          })(),
        ]);
        const containers: ObservedContainer[] = rawContainers.map((row) => {
          let reason: 'stopped' | 'internal-network' | undefined;
          if (
            !row.running &&
            ['created', 'exited'].includes(row.status) &&
            Object.values(row.activeBindings ?? {}).every((value) => !value?.length)
          )
            reason = 'stopped';
          else if (
            row.running &&
            row.status === 'running' &&
            row.networkNames.length > 0 &&
            row.networkNames.every((name) => {
              const network = networks.find((candidate) => candidate.name === name);
              return (
                network?.driver === 'bridge' &&
                network.internal &&
                [undefined, 'nat'].includes(
                  network.options['com.docker.network.bridge.gateway_mode_ipv4'],
                ) &&
                [undefined, 'nat'].includes(
                  network.options['com.docker.network.bridge.gateway_mode_ipv6'],
                )
              );
            })
          )
            reason = 'internal-network';
          const records: NonNullable<ObservedContainer['unassignedPublications']> = [];
          return {
            ...row,
            configuredBindings: dockerBindings(
              row.configuredBindings,
              row.running ? row.activeBindings : undefined,
              reason ? { reason, records } : undefined,
            ),
            activeBindings: dockerBindings(row.activeBindings),
            unassignedPublications: records,
          };
        });
        const [afterContainers, afterNetworks] = await Promise.all([
          ids('container'),
          ids('network'),
        ]);
        if (
          containers
            .map((row) => row.id)
            .sort()
            .join() !== beforeContainers.join() ||
          networks
            .map((row) => row.id)
            .sort()
            .join() !== beforeNetworks.join() ||
          afterContainers.join() !== beforeContainers.join() ||
          afterNetworks.join() !== beforeNetworks.join()
        )
          throw new Error();
        const ownedInodes = new Set<string>();
        for (const descriptor of await io.directory('/proc/self/fd')) {
          try {
            const match = /^socket:\[(\d+)\]$/.exec(await io.link(`/proc/self/fd/${descriptor}`));
            if (match?.[1]) ownedInodes.add(match[1]);
          } catch {
            /* A descriptor may close during observation; it cannot establish ownership. */
          }
        }
        const sockets: ObservedSocket[] = [];
        for (const transport of ['tcp', 'udp'] as const) {
          for (const ipv6 of [false, true]) {
            sockets.push(
              ...parseProcSockets(
                await io.read(`${config.hostProcDirectory}/net/${transport}${ipv6 ? '6' : ''}`),
                transport,
                ipv6,
                ownedInodes,
              ),
            );
          }
        }
        const interfaceAddresses = io.interfaces();
        if (!interfaceAddresses.length || interfaceAddresses.some((address) => !isIP(address)))
          throw new Error();
        if (
          (await io.link('/proc/self/ns/net')) !== namespaceId ||
          (await io.link(`${config.hostProcDirectory}/ns/net`)) !== hostNamespaceId ||
          io.now() - started > 15000
        )
          throw new Error();
        return {
          observedAt: started,
          namespaceId,
          hostNamespaceId,
          dockerDaemonId: config.expectedDockerDaemonId,
          interfaceAddresses,
          sockets,
          containers,
          networks,
        };
      } catch {
        // No Docker stderr, paths, provider metadata or secret-bearing source appears in errors.
        throw new DomainError('integration_unavailable');
      }
    },
  };
}
