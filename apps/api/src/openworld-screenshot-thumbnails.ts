import { Worker } from 'node:worker_threads';
import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import {
  openworldScreenshot,
  openworldScreenshots,
  screenshotRevision,
  screenshotRevisionExists,
} from '../../../games/openworld/src/screenshots.js';
import { resolveOpenworldDashboardTarget } from '../../../packages/server-management/src/openworld-dashboard.js';
import { createOpenworldPlayerChannel } from '../../../packages/server-management/src/openworld-player-channel.js';
import { sharedReads } from '../../../packages/server-management/src/openworld-telemetry.js';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

export function resizeOpenworldScreenshot(
  image: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./openworld-thumbnail-worker.cjs', import.meta.url), {
      workerData: image,
      transferList: [image.buffer],
      execArgv: [],
    });
    const fail = () => reject(new DomainError('integration_unavailable'));
    const timer = setTimeout(() => {
      void worker.terminate();
      fail();
    }, 8000);
    worker.once('message', (bytes) => {
      if (bytes instanceof Uint8Array && bytes.byteLength <= 512 * 1024)
        resolve(bytes as Uint8Array<ArrayBuffer>);
      else fail();
    });
    worker.once('error', fail);
    worker.once('exit', () => {
      clearTimeout(timer);
      fail();
    });
  });
}

export function registerOpenworldThumbnailRoute(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal'> &
    Partial<Pick<ServerRouteOptions, 'management'>>,
  channel = createOpenworldPlayerChannel({
    db: options.db,
    target: async (id) => {
      if (!options.management) throw new DomainError('integration_unavailable');
      return resolveOpenworldDashboardTarget(options.db, (await options.management()).adapter, id);
    },
  }),
  fetcher = fetch,
) {
  const indexes = sharedReads<Awaited<ReturnType<typeof openworldScreenshots>>>(32, Date.now, 0);
  const confirmations = sharedReads<Awaited<ReturnType<typeof openworldScreenshots>>>(
    32,
    Date.now,
    0,
  );
  const previews = sharedReads<Uint8Array<ArrayBuffer>>(64, Date.now, 0);
  let active = 0;
  const queue: Array<() => void> = [];
  app.get('/v1/servers/:id/openworld/screenshots/thumbnail', async (c) => {
    c.header('cache-control', 'private, no-store');
    const who = await options.principal(c);
    const ref = screenshotRevision.safeParse(c.req.query());
    if (!ref.success) throw new DomainError('validation_failed');
    const { name, bytes, mtimeMs } = ref.data;
    const output = await channel.read(
      who,
      c.req.param('id'),
      'screenshots',
      async (origin, token, signal, scope) => {
        const index = await indexes.get(scope.liveKey, 1000, () =>
          openworldScreenshots(origin, token, signal, fetcher),
        );
        if (!screenshotRevisionExists(index.files, ref.data)) throw new DomainError('not_found');
        return previews.get(
          JSON.stringify([scope.liveKey, name, mtimeMs, bytes]),
          60_000,
          async () => {
            if (active >= 1) {
              if (queue.length >= 32) throw new DomainError('rate_limited');
              await new Promise<void>((resolve) => queue.push(resolve));
            } else active++;
            try {
              if (signal.aborted) throw new DomainError('integration_unavailable');
              const original = await openworldScreenshot(origin, token, signal, name, fetcher);
              if (original.byteLength !== bytes) throw new DomainError('not_found');
              const confirmed = await confirmations.get(scope.liveKey, 0, () =>
                openworldScreenshots(origin, token, signal, fetcher),
              );
              if (!screenshotRevisionExists(confirmed.files, ref.data))
                throw new DomainError('not_found');
              return await resizeOpenworldScreenshot(original);
            } finally {
              const next = queue.shift();
              if (next) next();
              else active--;
            }
          },
        );
      },
    );
    c.header('content-type', 'image/png');
    c.header('x-content-type-options', 'nosniff');
    c.header('content-security-policy', "default-src 'none'; sandbox");
    return c.body(output);
  });
}
