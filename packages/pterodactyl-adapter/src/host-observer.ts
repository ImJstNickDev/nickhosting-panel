import { chmod, lstat, readFile, realpath, statfs, unlink } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { cpus } from 'node:os';
import { dirname, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { type ContainerObserver, createContainerObserver } from './container-observer.js';

const pathSchema = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      posix.isAbsolute(value) &&
      value !== '/' &&
      posix.normalize(value) === value &&
      !Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
  );
const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const operation = z.discriminatedUnion('method', [
  z.object({ method: z.literal('preflight') }).strict(),
  z.object({ method: z.literal('sample'), path: pathSchema }).strict(),
  z.object({ method: z.literal('stopped'), uuid, kind: z.enum(['server', 'installer']) }).strict(),
  z.object({ method: z.literal('processStartedAt'), uuid }).strict(),
  z.object({ method: z.literal('imageIdentity'), uuid }).strict(),
]);
const sampleSchema = z
  .object({
    totalMemoryMiB: z.number().finite().positive(),
    availableMemoryMiB: z.number().finite().nonnegative(),
    cpuCapacityPercent: z.number().finite().positive(),
    cpuBusyPercent: z.number().finite().nonnegative(),
    availableDiskMiB: z.number().finite().nonnegative(),
    observedAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (value) =>
      value.availableMemoryMiB <= value.totalMemoryMiB &&
      value.cpuBusyPercent <= value.cpuCapacityPercent,
  );
export type HostObservationSample = z.infer<typeof sampleSchema>;
const unavailable = () => new DomainError('integration_unavailable');
const limit = 65536;

async function physicalSample(path: string): Promise<HostObservationSample> {
  const before = cpus();
  await delay(250);
  const after = cpus();
  if (!before.length || before.length !== after.length) throw unavailable();
  let idle = 0,
    total = 0;
  for (let i = 0; i < before.length; i++) {
    const a = after[i]?.times,
      b = before[i]?.times;
    if (!a || !b) throw unavailable();
    idle += a.idle - b.idle;
    total +=
      Object.values(a).reduce((sum, value) => sum + value, 0) -
      Object.values(b).reduce((sum, value) => sum + value, 0);
  }
  const memory = await readFile('/proc/meminfo', 'utf8');
  const amount = (name: string) =>
    Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(memory)?.[1]) / 1024;
  const disk = await statfs(path);
  const capacity = before.length * 100;
  return sampleSchema.parse({
    totalMemoryMiB: amount('MemTotal'),
    availableMemoryMiB: amount('MemAvailable'),
    cpuCapacityPercent: capacity,
    cpuBusyPercent:
      total > 0 ? Math.min(capacity, Math.max(0, (1 - idle / total) * capacity)) : capacity,
    availableDiskMiB: (disk.bavail * disk.bsize) / 1048576,
    observedAt: new Date().toISOString(),
  });
}

export function createRemoteHostObserver(socket: string, observerId: string) {
  pathSchema.parse(socket);
  identity.parse(observerId);
  async function call<T>(input: z.infer<typeof operation>, schema: z.ZodType<T>): Promise<T> {
    operation.parse(input);
    return new Promise<T>((resolve, reject) => {
      const body = JSON.stringify(input);
      const req = request(
        {
          socketPath: socket,
          path: '/observe',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) req.destroy();
            else chunks.push(chunk);
          });
          res.on('error', () => reject(unavailable()));
          res.on('end', () => {
            clearTimeout(timer);
            try {
              if (res.statusCode !== 200 || size > limit) throw unavailable();
              const envelope = z
                .object({ observerId: z.literal(observerId), value: schema })
                .strict()
                .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
              resolve(envelope.value);
            } catch {
              reject(unavailable());
            }
          });
        },
      );
      const timer = setTimeout(() => req.destroy(), 20000);
      req.on('error', () => {
        clearTimeout(timer);
        reject(unavailable());
      });
      req.end(body);
    });
  }
  return {
    async preflight() {
      await call({ method: 'preflight' }, z.literal(true));
    },
    sample: (path: string) => call({ method: 'sample', path }, sampleSchema),
    stopped: (uuid: string, kind: 'server' | 'installer') =>
      call({ method: 'stopped', uuid, kind }, z.boolean()),
    processStartedAt: (uuid: string) =>
      call(
        { method: 'processStartedAt', uuid },
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
          .nullable(),
      ),
    imageIdentity: (uuid: string) =>
      call(
        { method: 'imageIdentity', uuid },
        z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .nullable(),
      ),
  };
}

/** Host-native, read-only helper. Never mount the Docker socket into API/worker. */
export async function serveHostObserver(options: {
  socket: string;
  dockerSocket: string;
  observerId: string;
  allowedDiskPaths: string[];
  containerObserver?: ContainerObserver;
  sample?: (path: string) => Promise<HostObservationSample>;
  /** Explicit service-manager restart recovery only; default never removes a path. */
  recoverStaleSocket?: boolean;
}) {
  pathSchema.parse(options.socket);
  identity.parse(options.observerId);
  const parent = dirname(options.socket);
  const parentInfo = await lstat(parent);
  if (
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    (await realpath(parent)) !== parent ||
    (parentInfo.mode & 0o077) !== 0 ||
    parentInfo.uid !== process.getuid?.()
  )
    throw unavailable();
  if (options.recoverStaleSocket) {
    const prior = await lstat(options.socket).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw unavailable();
    });
    if (prior) {
      if (!prior.isSocket() || prior.uid !== process.getuid?.()) throw unavailable();
      await new Promise<void>((resolve, reject) => {
        const probe = connect(options.socket);
        const timer = setTimeout(() => {
          probe.destroy();
          reject(unavailable());
        }, 1000);
        probe.once('connect', () => {
          clearTimeout(timer);
          probe.destroy();
          reject(unavailable());
        });
        probe.once('error', (error: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          probe.destroy();
          if (error.code === 'ECONNREFUSED') resolve();
          else reject(unavailable());
        });
      });
      const current = await lstat(options.socket);
      // The private directory and a single-instance service manager are required:
      // Node has no atomic unlink-if-inode syscall. Never recover concurrently.
      if (
        !current.isSocket() ||
        current.uid !== prior.uid ||
        current.dev !== prior.dev ||
        current.ino !== prior.ino ||
        current.ctimeMs !== prior.ctimeMs
      )
        throw unavailable();
      await unlink(options.socket);
    }
  }
  const paths = z.array(pathSchema).min(1).max(32).parse(options.allowedDiskPaths);
  for (const path of paths)
    if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory()) throw unavailable();
  const observer = options.containerObserver ?? createContainerObserver(options.dockerSocket);
  let active = 0;
  const server = createServer(async (req, res) => {
    const fail = () => {
      if (!res.destroyed) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"integration_unavailable"}');
      }
    };
    if (
      req.method !== 'POST' ||
      req.url !== '/observe' ||
      req.headers['content-type'] !== 'application/json' ||
      active >= 8
    ) {
      fail();
      req.resume();
      return;
    }
    active++;
    const timer = setTimeout(() => req.destroy(), 20000);
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) throw unavailable();
        chunks.push(chunk);
      }
      const input = operation.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      let value: unknown;
      switch (input.method) {
        case 'preflight':
          await observer.preflight();
          value = true;
          break;
        case 'sample':
          if (
            !paths.includes(input.path) ||
            (await realpath(input.path)) !== input.path ||
            !(await lstat(input.path)).isDirectory()
          )
            throw unavailable();
          value = sampleSchema.parse(await (options.sample ?? physicalSample)(input.path));
          break;
        case 'stopped':
          value = await observer.stopped(input.uuid, input.kind);
          break;
        case 'processStartedAt':
          if (!observer.processStartedAt) throw unavailable();
          value = await observer.processStartedAt(input.uuid);
          break;
        case 'imageIdentity':
          if (!observer.imageIdentity) throw unavailable();
          value = await observer.imageIdentity(input.uuid);
          break;
      }
      const body = JSON.stringify({ observerId: options.observerId, value });
      if (Buffer.byteLength(body) > limit) throw unavailable();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    } catch {
      fail();
    } finally {
      active--;
      clearTimeout(timer);
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 8;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socket, () => resolve());
  });
  try {
    await chmod(options.socket, 0o600);
  } catch {
    server.close();
    throw unavailable();
  }
  return {
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(unavailable()) : resolve())),
      );
    },
  };
}
