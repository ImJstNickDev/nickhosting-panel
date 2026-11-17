import { Agent, request } from 'node:http';
import { z } from 'zod';

/** Only exact missing inspect targets are eligible for observer inventory retry. */
export class MissingContainers extends Error {
  constructor(readonly ids: string[]) {
    super('docker_containers_missing');
  }
}

const id = z.string().regex(/^[a-f0-9]{64}$/);
const publication = z
  .record(
    z.string().regex(/^\d{1,5}\/(tcp|udp)$/),
    z.array(z.object({ HostIp: z.string(), HostPort: z.string().regex(/^\d{0,5}$/) })).nullable(),
  )
  .nullable();
const container = z.object({
  Id: id,
  Name: z.string().min(2),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  State: z.object({
    Running: z.boolean(),
    Status: z.enum(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']),
  }),
  HostConfig: z.object({ NetworkMode: z.string().min(1), PortBindings: publication }),
  NetworkSettings: z.object({
    Ports: publication,
    Networks: z.record(z.string().min(1), z.unknown()),
  }),
});
const network = z.object({
  Id: id,
  Name: z.string().min(1),
  Driver: z.string().min(1),
  Scope: z.string().min(1),
  Internal: z.boolean(),
  EnableIPv6: z.boolean(),
  Options: z.record(z.string(), z.string()).nullable(),
});

// One bounded pool across all simultaneous observations. No shell, child process,
// TCP destination, redirects or mutation endpoint is exposed by this transport.
const agent = new Agent({ keepAlive: true, maxSockets: 8, maxTotalSockets: 8, maxFreeSockets: 8 });
class MissingObject extends Error {}
async function readJson(
  socketPath: string,
  path: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('docker_read_timeout');
  if (signal?.aborted) throw new Error('docker_read_cancelled');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        req.destroy();
        reject(error);
      } else resolve(value);
    };
    const req = request(
      { socketPath, path, method: 'GET', agent, signal, headers: { Accept: 'application/json' } },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          finish(
            response.statusCode === 404 ? new MissingObject() : new Error('docker_read_failed'),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) {
            response.destroy();
            finish(new Error('docker_read_oversize'));
          } else chunks.push(chunk);
        });
        response.on('error', () => finish(new Error('docker_read_failed')));
        response.on('aborted', () => finish(new Error('docker_read_failed')));
        response.on('end', () => {
          try {
            finish(undefined, JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')));
          } catch {
            finish(new Error('docker_read_invalid'));
          }
        });
      },
    );
    const timer = setTimeout(() => finish(new Error('docker_read_timeout')), remaining);
    req.on('error', () => finish(new Error('docker_read_failed')));
    req.end();
  });
}

/** Compatibility seam for the observer's injected deterministic inventory tests. */
export async function dockerReadCommand(
  args: readonly string[],
  socket: string,
  timeoutMs = 10000,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + Math.min(15000, timeoutMs);
  if (args[0] === 'info') {
    return JSON.stringify(
      z.object({ ID: z.string().min(1) }).parse(await readJson(socket, '/info', deadline, signal))
        .ID,
    );
  }
  const kind = args[0];
  if (kind !== 'container' && kind !== 'network') throw new Error('docker_read_operation');
  if (args[1] === 'ls') {
    const rows = z
      .array(z.object({ Id: id }))
      .max(10000)
      .parse(
        await readJson(
          socket,
          kind === 'container' ? '/containers/json?all=true' : '/networks',
          deadline,
          signal,
        ),
      );
    return rows.map((row) => row.Id).join('\n');
  }
  if (args[1] !== 'inspect') throw new Error('docker_read_operation');
  const ids = z.array(id).min(1).max(64).parse(args.slice(4));
  if (new Set(ids).size !== ids.length) throw new Error('docker_read_operation');
  // Docker's network list includes the complete metadata used by the safety
  // validator. Read it freshly once per chunk instead of N inspect requests.
  if (kind === 'network') {
    const values = z
      .array(network)
      .max(10000)
      .parse(await readJson(socket, '/networks', deadline, signal));
    const indexed = new Map(values.map((value) => [value.Id, value]));
    if (indexed.size !== values.length) throw new Error('docker_read_identity');
    return ids
      .map((target) => {
        const value = indexed.get(target);
        if (!value) throw new Error('docker_read_identity');
        return JSON.stringify({
          id: value.Id,
          name: value.Name,
          driver: value.Driver,
          scope: value.Scope,
          internal: value.Internal,
          ipv6: value.EnableIPv6,
          options: value.Options,
        });
      })
      .join('\n');
  }
  const rows: string[] = [];
  const missing: string[] = [];
  let next = 0;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(8, ids.length) }, async () => {
      while (next < ids.length) {
        if (signal?.aborted) {
          failure ??= new Error('docker_read_cancelled');
          return;
        }
        const target = ids[next++];
        if (!target) return;
        try {
          const raw = await readJson(
            socket,
            kind === 'container' ? `/containers/${target}/json` : `/networks/${target}`,
            deadline,
            signal,
          );
          const value = container.parse(raw);
          if (value.Id !== target) throw new Error('docker_read_identity');
          rows.push(
            JSON.stringify({
              id: value.Id,
              name: value.Name,
              service: value.Config.Labels?.Service ?? null,
              containerType: value.Config.Labels?.ContainerType ?? null,
              running: value.State.Running,
              status: value.State.Status,
              networkMode: value.HostConfig.NetworkMode,
              networkNames: Object.keys(value.NetworkSettings.Networks),
              configuredBindings: value.HostConfig.PortBindings,
              activeBindings: value.NetworkSettings.Ports,
            }),
          );
        } catch (error) {
          if (error instanceof MissingObject) missing.push(target);
          else failure ??= new Error('docker_read_invalid');
        }
      }
    }),
  );
  if (failure) throw failure;
  if (missing.length) throw new MissingContainers(missing);
  return rows.join('\n');
}
