import { DomainError, type SecretCodec } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import {
  downloadOpenworldRelease,
  readOpenworldInstallTicket,
} from '@nickhosting/server-management';
import type { Hono } from 'hono';
import type { Kysely } from 'kysely';
import type { Variables } from './app.js';

export function registerOpenworldArtifactRoute(
  app: Hono<{ Variables: Variables }>,
  {
    db,
    codec,
    env,
  }: {
    db: Kysely<Database>;
    codec: SecretCodec;
    env: Readonly<Record<string, string | undefined>>;
  },
) {
  let downloads = 0;
  app.get('/v1/runtime-artifacts/openworld', async (c) => {
    const release = readOpenworldInstallTicket(codec, c.req.query('ticket'));
    if (c.req.raw.method === 'HEAD') {
      c.header('Content-Type', 'application/zip');
      c.header('Content-Length', String(release.size));
      return c.body(null);
    }
    if (downloads >= 2) {
      c.header('Retry-After', '10');
      throw new DomainError('rate_limited');
    }
    const signal = c.req.raw.signal;
    let active = true;
    const finish = () => {
      signal.removeEventListener('abort', finish);
      if (active) downloads--;
      active = false;
    };
    downloads++;
    try {
      const bytes = await downloadOpenworldRelease(db, codec, env, release);
      signal.throwIfAborted();
      signal.addEventListener('abort', finish, { once: true });
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length || signal.aborted) {
            controller.close();
            finish();
            return;
          }
          const end = Math.min(bytes.length, offset + 64 * 1024);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
        cancel: finish,
      });
      c.header('Content-Type', 'application/zip');
      c.header('Content-Length', String(bytes.length));
      return c.body(body);
    } catch (error) {
      finish();
      throw error;
    }
  });
}
