import { constants } from 'node:fs';
import { open, readdir, readFile, readlink, statfs } from 'node:fs/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { posix } from 'node:path';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { dockerReadCommand, MissingContainers } from './docker-read-client.js';

export type NetworkObservationFailure =
  | 'namespace'
  | 'daemon_command'
  | 'daemon_identity'
  | 'container_list'
  | 'network_list'
  | 'container_inspect'
  | 'network_inspect'
  | 'container_parse'
  | 'network_parse'
  | 'container_bindings'
  | 'container_inventory'
  | 'network_inventory'
  | 'container_churn'
  | 'socket_observation'
  | 'interfaces'
  | 'observation_timeout';

/** Only a fixed category crosses the observer boundary, never Docker output. */
export class NetworkObservationError extends DomainError {
  constructor(readonly reason: NetworkObservationFailure) {
    super('integration_unavailable');
  }
}
class ContainerChurn extends Error {}

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
  namespaceFile(path: string): Promise<{ inode: bigint; filesystemType: bigint }>;
  directory(path: string): Promise<string[]>;
  interfaces(): string[];
  docker(args: readonly string[], socket: string, timeoutMs?: number): Promise<string>;
  now(): number;
}
const production: NetworkObserverDependencies = {
  read: (path) => readFile(path, 'utf8'),
  link: readlink,
  async namespaceFile(path) {
    // A read-only bind of the host's init network namespace survives reboot
    // without exposing a host process tree or requiring ptrace privileges.
    // Inspect the opened descriptor so replacement cannot mix two identities.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const [metadata, filesystem] = await Promise.all([
        file.stat({ bigint: true }),
        statfs(`/proc/self/fd/${file.fd}`, { bigint: true }),
      ]);
      return { inode: metadata.ino, filesystemType: filesystem.type };
    } finally {
      await file.close();
    }
  },
  directory: (path) => readdir(path),
  interfaces: () =>
    Object.values(networkInterfaces())
      .flatMap((addresses) => addresses ?? [])
      .map((address) => address.address),
  now: Date.now,
  docker: dockerReadCommand,
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
  async function hostNamespace() {
    const path = `${config.hostProcDirectory}/ns/net`;
    try {
      return await io.link(path);
    } catch (error) {
      // Preserve legacy proc-directory proofs. Only a non-symlink may be a
      // namespace bind; missing/unreadable proofs must never take this fallback.
      if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw error;
      const file = await io.namespaceFile(path);
      // Linux NSFS_MAGIC: an ordinary file with a matching inode is not proof.
      if (file.filesystemType !== 0x6e736673n || file.inode <= 0n) throw new Error();
      return `net:[${file.inode}]`;
    }
  }
  return {
    async observe() {
      const started = io.now();
      const deadline = started + 15000;
      let expired = false;
      function remaining() {
        const value = deadline - io.now();
        if (expired || value <= 0) throw new NetworkObservationError('observation_timeout');
        return value;
      }
      async function stage<T>(
        reason: NetworkObservationFailure,
        run: () => T | Promise<T>,
      ): Promise<T> {
        remaining();
        try {
          const result = await run();
          remaining();
          return result;
        } catch (error) {
          if (error instanceof NetworkObservationError || error instanceof MissingContainers)
            throw error;
          throw new NetworkObservationError(reason);
        }
      }
      async function command(args: readonly string[], reason: NetworkObservationFailure) {
        return stage(reason, async () => {
          const value = await io.docker(args, config.dockerSocket, remaining());
          if (typeof value !== 'string' || value.length > 4 * 1024 * 1024) throw new Error();
          return value.trim();
        });
      }
      async function ids(kind: 'container' | 'network') {
        return stage(kind === 'container' ? 'container_list' : 'network_list', async () => {
          const text = await command(
            [
              kind,
              'ls',
              ...(kind === 'container' ? ['--all'] : []),
              '--no-trunc',
              '--format',
              '{{.ID}}',
            ],
            kind === 'container' ? 'container_list' : 'network_list',
          );
          const rows = text ? text.split('\n').map((row) => id.parse(row)) : [];
          if (new Set(rows).size !== rows.length || rows.length > 10000) throw new Error();
          return rows.sort();
        });
      }
      async function attempt(): Promise<NetworkObservation> {
        const [namespaceId, hostNamespaceId] = await stage('namespace', async () => {
          const values = await Promise.all([io.link('/proc/self/ns/net'), hostNamespace()]);
          if (
            !namespace(values[0]) ||
            values[0] !== values[1] ||
            values[1] !== config.expectedHostNamespaceId
          )
            throw new Error();
          return values;
        });
        const daemon = await command(['info', '--format', '{{json .ID}}'], 'daemon_command');
        await stage('daemon_identity', () => {
          if (JSON.parse(daemon) !== config.expectedDockerDaemonId) throw new Error();
        });
        const [beforeContainers, beforeNetworks] = await Promise.all([
          ids('container'),
          ids('network'),
        ]);
        const rawContainers: z.infer<typeof containerSchema>[] = [];
        const networks: ObservedNetwork[] = [];
        // Bound total CLI inspection concurrency across BOTH inventories. Every
        // chunk is still complete and individually checked; settle all issued
        // chunks so malformed evidence cannot be hidden by container churn.
        const tasks: (() => Promise<void>)[] = [];
        for (let start = 0; start < beforeContainers.length; start += 64) {
          const expected = beforeContainers.slice(start, start + 64);
          tasks.push(async () => {
            const result = await command(
              ['container', 'inspect', '--format', containerFormat, ...expected],
              'container_inspect',
            );
            await stage('container_parse', () => {
              const rows = result
                .split('\n')
                .map((line) => containerSchema.parse(JSON.parse(line)));
              if (
                rows
                  .map((row) => row.id)
                  .sort()
                  .join() !== expected.join()
              )
                throw new NetworkObservationError('container_inventory');
              rawContainers.push(...rows);
            });
          });
        }
        for (let start = 0; start < beforeNetworks.length; start += 64) {
          const expected = beforeNetworks.slice(start, start + 64);
          tasks.push(async () => {
            const result = await command(
              ['network', 'inspect', '--format', networkFormat, ...expected],
              'network_inspect',
            );
            await stage('network_parse', () => {
              const rows = result.split('\n').map((line) => networkSchema.parse(JSON.parse(line)));
              if (
                rows
                  .map((row) => row.id)
                  .sort()
                  .join() !== expected.join()
              )
                throw new NetworkObservationError('network_inventory');
              networks.push(...rows.map((row) => ({ ...row, options: row.options ?? {} })));
            });
          });
        }
        const inspections: PromiseSettledResult<void>[] = new Array(tasks.length);
        let nextTask = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, tasks.length) }, async () => {
            while (nextTask < tasks.length) {
              const index = nextTask++;
              const task = tasks[index];
              if (!task) return;
              try {
                await task();
                inspections[index] = { status: 'fulfilled', value: undefined };
              } catch (reason) {
                inspections[index] = { status: 'rejected', reason };
              }
            }
          }),
        );
        // Stable observation order does not depend on which CLI call finished first.
        rawContainers.sort((a, b) => a.id.localeCompare(b.id));
        networks.sort((a, b) => a.id.localeCompare(b.id));
        for (const result of inspections) {
          if (result.status === 'rejected' && !(result.reason instanceof MissingContainers))
            throw result.reason;
        }
        if (
          networks
            .map((row) => row.id)
            .sort()
            .join() !== beforeNetworks.join()
        )
          throw new NetworkObservationError('network_inventory');
        const missing = inspections.flatMap((result) =>
          result.status === 'rejected' ? (result.reason as MissingContainers).ids : [],
        );
        if (missing.length) {
          const [current, currentNetworks] = await Promise.all([ids('container'), ids('network')]);
          if (currentNetworks.join() !== beforeNetworks.join())
            throw new NetworkObservationError('network_inventory');
          // Parallel chunks can report separate disappearances. Corroborate
          // every claimed ID, never let the first valid disappearance hide an
          // invalid missing-object response from a different chunk.
          if (
            missing.every((value) => beforeContainers.includes(value) && !current.includes(value))
          )
            throw new ContainerChurn();
          throw new NetworkObservationError('container_inspect');
        }
        if (
          rawContainers
            .map((row) => row.id)
            .sort()
            .join() !== beforeContainers.join()
        )
          throw new NetworkObservationError('container_inventory');
        const containers: ObservedContainer[] = await stage('container_bindings', () =>
          rawContainers.map((row) => {
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
          }),
        );
        const [afterContainers, afterNetworks] = await Promise.all([
          ids('container'),
          ids('network'),
        ]);
        if (afterNetworks.join() !== beforeNetworks.join())
          throw new NetworkObservationError('network_inventory');
        if (afterContainers.join() !== beforeContainers.join()) throw new ContainerChurn();
        return stage('socket_observation', async () => {
          const ownedInodes = new Set<string>();
          for (const descriptor of await io.directory('/proc/self/fd')) {
            remaining();
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
              remaining();
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
          const interfaceAddresses = await stage('interfaces', () => {
            const addresses = io.interfaces();
            if (!addresses.length || addresses.some((address) => !isIP(address))) throw new Error();
            return addresses;
          });
          await stage('namespace', async () => {
            if ((await io.link('/proc/self/ns/net')) !== namespaceId) throw new Error();
            remaining();
            if ((await hostNamespace()) !== hostNamespaceId) throw new Error();
          });
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
        });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const complete = async () => {
        for (let number = 0; number < 2; number++) {
          try {
            return await attempt();
          } catch (error) {
            remaining();
            if (!(error instanceof ContainerChurn)) throw error;
            if (number === 1) throw new NetworkObservationError('container_churn');
          }
        }
        throw new NetworkObservationError('container_churn');
      };
      try {
        return await Promise.race([
          complete(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              expired = true;
              reject(new NetworkObservationError('observation_timeout'));
            }, remaining());
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
