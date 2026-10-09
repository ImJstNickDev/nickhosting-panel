import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';

export interface ContainerObserverExecOptions {
  encoding: 'utf8';
  timeout: number;
  maxBuffer: number;
  killSignal: 'SIGKILL';
  shell: false;
  env: NodeJS.ProcessEnv;
}
/** Injection seam for isolated tests. Production executes only the fixed Docker commands below. */
export type ContainerObserverExec = (
  executable: 'docker',
  args: readonly string[],
  options: ContainerObserverExecOptions,
) => Promise<{ stdout: string }>;

export interface ContainerObserver {
  preflight(): Promise<void>;
  stopped(uuid: string, kind: 'server' | 'installer'): Promise<boolean>;
  /** Optional for injected observers; production exposes independently observed process identity. */
  processStartedAt?(uuid: string): Promise<string | null>;
  /** Docker .Image configuration content hash, not a registry manifest digest or Java proof. */
  imageIdentity?(uuid: string): Promise<string | null>;
}

const execute: ContainerObserverExec = (executable, args, options) =>
  new Promise((resolve, reject) => {
    execFile(executable, [...args], options, (error, stdout) => {
      if (error) reject(new DomainError('integration_unavailable'));
      else resolve({ stdout });
    });
  });

const containerId = z.string().regex(/^[a-f0-9]{64}$/);
const listedSchema = z.object({ id: containerId, name: z.string() }).strict();
const inspectedSchema = z
  .object({
    id: containerId,
    name: z.string(),
    service: z.literal('Pterodactyl'),
    containerType: z.enum(['server_process', 'server_installer']),
    state: z
      .object({
        running: z.boolean(),
        restarting: z.boolean(),
        paused: z.boolean(),
        dead: z.boolean(),
        status: z.enum([
          'created',
          'running',
          'paused',
          'restarting',
          'removing',
          'exited',
          'dead',
        ]),
      })
      .strict(),
  })
  .strict();
const startedAtSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
  .refine((value) => {
    const wholeSeconds = value.slice(0, 19);
    const parsed = Date.parse(`${wholeSeconds}Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === wholeSeconds;
  });
const processSchema = inspectedSchema.extend({
  state: inspectedSchema.shape.state.extend({ startedAt: startedAtSchema }),
});
const imageSchema = inspectedSchema.extend({ image: z.string().regex(/^sha256:[a-f0-9]{64}$/) });

const listFormat = '{"id":{{json .ID}},"name":{{json .Names}}}';
// Never request full inspect output: Config.Env, arbitrary labels and state errors may contain secrets.
const inspectFormat =
  '{"id":{{json .Id}},"name":{{json .Name}},' +
  '"service":{{json (index .Config.Labels "Service")}},' +
  '"containerType":{{json (index .Config.Labels "ContainerType")}},' +
  '"state":{"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},' +
  '"paused":{{json .State.Paused}},"dead":{{json .State.Dead}},"status":{{json .State.Status}}}}';
const processFormat = inspectFormat.replace(
  '"status":{{json .State.Status}}',
  '"status":{{json .State.Status}},"startedAt":{{json .State.StartedAt}}',
);
const imageFormat = inspectFormat.replace('"state":{', '"image":{{json .Image}},"state":{');

function containerName(uuid: string, kind: 'server' | 'installer'): string {
  if (
    !z.uuid().safeParse(uuid).success ||
    uuid !== uuid.toLowerCase() ||
    !['server', 'installer'].includes(kind)
  )
    throw new DomainError('configuration_invalid');
  return kind === 'installer' ? `${uuid}_installer` : uuid;
}

/**
 * Read-only physical observation, not a future-quiescence guarantee. In particular,
 * an absent/created container can still be started by an already pending remote job.
 * Callers must bind this socket to the verified server's physical host and exclude
 * unresolved earlier effects before using the result to release a reservation.
 */
export function createContainerObserver(
  socket: string,
  options: { exec?: ContainerObserverExec } = {},
): ContainerObserver & {
  processStartedAt(uuid: string): Promise<string | null>;
  imageIdentity(uuid: string): Promise<string | null>;
} {
  if (
    typeof socket !== 'string' ||
    !posix.isAbsolute(socket) ||
    socket === '/' ||
    posix.normalize(socket) !== socket ||
    socket.endsWith('/') ||
    /[?#]/.test(socket) ||
    Array.from(socket).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new DomainError('configuration_invalid');
  const run = options.exec ?? execute;
  async function command(args: readonly string[]): Promise<string> {
    try {
      // An inherited remote Docker context/host/TLS setting must never redirect this observer.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('DOCKER_')),
      );
      const { stdout } = await run('docker', ['--host', `unix://${socket}`, ...args], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 65536,
        killSignal: 'SIGKILL',
        shell: false,
        env,
      });
      if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > 65536)
        throw new Error();
      return stdout.trim();
    } catch {
      // CLI stderr, command objects and malformed metadata never enter errors/logging.
      throw new DomainError('integration_unavailable');
    }
  }
  async function list(name: string) {
    const output = await command([
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      `name=^/${name}$`,
      '--format',
      listFormat,
    ]);
    if (!output) return undefined;
    const row = listedSchema.parse(JSON.parse(output));
    if (row.name !== name) throw new Error();
    return row;
  }
  async function inspect<T extends z.infer<typeof inspectedSchema>>(
    name: string,
    kind: 'server' | 'installer',
    schema: z.ZodType<T>,
    format: string,
  ): Promise<T | undefined> {
    const listed = await list(name);
    // Only a successful, exact filtered listing can prove absence; inspect errors cannot.
    if (!listed) return undefined;
    const row = schema.parse(
      JSON.parse(await command(['container', 'inspect', '--format', format, listed.id])),
    );
    if (
      row.id !== listed.id ||
      row.name !== `/${name}` ||
      row.containerType !== (kind === 'installer' ? 'server_installer' : 'server_process')
    )
      throw new Error();
    // A rename/removal/replacement between listing and inspection is not trusted evidence.
    const current = await list(name);
    if (!current || current.id !== listed.id) throw new Error();
    return row;
  }
  return {
    async preflight(): Promise<void> {
      try {
        const output = await command(['info', '--format', '{{json .ID}}']);
        z.string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/)
          .parse(JSON.parse(output));
      } catch {
        throw new DomainError('integration_unavailable');
      }
    },
    async stopped(uuid: string, kind: 'server' | 'installer'): Promise<boolean> {
      const name = containerName(uuid, kind);
      try {
        const row = await inspect(name, kind, inspectedSchema, inspectFormat);
        if (!row) return true;
        const state = row.state;
        if (state.running || state.restarting || state.paused) return false;
        if (state.status === 'dead') return state.dead;
        return !state.dead && ['created', 'exited'].includes(state.status);
      } catch {
        throw new DomainError('integration_unavailable');
      }
    },
    async processStartedAt(uuid: string): Promise<string | null> {
      const name = containerName(uuid, 'server');
      try {
        const row = await inspect(name, 'server', processSchema, processFormat);
        if (!row) return null;
        const state = row.state;
        if (
          !state.running ||
          state.restarting ||
          state.paused ||
          state.dead ||
          state.status !== 'running'
        )
          return null;
        // Preserve Docker's nanosecond precision; millisecond rounding can hide a fast restart.
        const seconds = Date.parse(`${state.startedAt.slice(0, 19)}Z`);
        const fraction = state.startedAt.split('.')[1]?.slice(0, -1) ?? '';
        const nanoseconds = BigInt(seconds) * 1_000_000n + BigInt(fraction.padEnd(9, '0'));
        if (nanoseconds <= 0n || nanoseconds > BigInt(Date.now()) * 1_000_000n) throw new Error();
        return state.startedAt;
      } catch {
        throw new DomainError('integration_unavailable');
      }
    },
    async imageIdentity(uuid: string): Promise<string | null> {
      const name = containerName(uuid, 'server');
      try {
        // Inspect the actual server container, never Config.Image (a mutable tag),
        // an installer container or an image currently cached under the same tag.
        const row = await inspect(name, 'server', imageSchema, imageFormat);
        return row?.image ?? null;
      } catch {
        throw new DomainError('integration_unavailable');
      }
    },
  };
}
