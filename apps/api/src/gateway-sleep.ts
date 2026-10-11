import { DomainError } from '@nickhosting/core';
import { type createDatabase, listenForGatewayChanges } from '@nickhosting/database';
import { getGatewaySnapshot } from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Variables } from './app.js';

const requestSchema = z
  .object({
    routeId: z.uuid(),
    generation: z.uuid(),
    quiescenceUntil: z.iso.datetime({ offset: true }),
  })
  .strict();
type Snapshot = Awaited<ReturnType<typeof getGatewaySnapshot>>;
type Subscriber = { changed(): void; lost(): void };

/** One optional LISTEN connection per API, never one connection per waiting route.
 * Notifications are only hints; subscribing before reading closes the lost-commit gap. */
export function registerGatewaySleepRoutes(
  app: Hono<{ Variables: Variables }>,
  options: {
    db: ReturnType<typeof createDatabase>['db'];
    pool?: ReturnType<typeof createDatabase>['pool'];
    env: Readonly<Record<string, string | undefined>>;
    body: (c: Context) => Promise<unknown>;
    authenticate: (c: Context<{ Variables: Variables }>) => Promise<unknown>;
  },
) {
  type Session = {
    subscribers: Set<Subscriber>;
    ready: Promise<void>;
    listener?: { close(): void };
  };
  let session: Session | undefined;
  const subscribe = (subscriber: Subscriber) => {
    if (!options.pool) throw new DomainError('integration_unavailable');
    if (session && session.subscribers.size >= 128) throw new DomainError('conflict');
    if (!session) {
      const created: Session = { subscribers: new Set(), ready: Promise.resolve() };
      session = created;
      created.ready = listenForGatewayChanges(
        options.pool,
        () => {
          for (const item of created.subscribers) item.changed();
        },
        () => {
          for (const item of [...created.subscribers]) item.lost();
        },
      )
        .then((listener) => {
          created.listener = listener;
          if (!created.subscribers.size) listener.close();
        })
        .catch(() => {
          for (const item of [...created.subscribers]) item.lost();
        });
    }
    const selected = session;
    selected.subscribers.add(subscriber);
    return {
      ready: selected.ready,
      close() {
        selected.subscribers.delete(subscriber);
        if (!selected.subscribers.size) {
          selected.listener?.close();
          if (session === selected) session = undefined;
        }
      },
    };
  };

  app.post('/internal/gateway/:gatewayId/sleep-completion', async (c) => {
    if (!c.get('gatewayAuthenticated')) throw new DomainError('unauthenticated');
    const parsed = requestSchema.safeParse(await options.body(c));
    if (!parsed.success) throw new DomainError('validation_failed');
    const input = parsed.data;
    const remaining = Math.min(20000, Date.parse(input.quiescenceUntil) - Date.now());
    if (remaining <= 0 || c.req.raw.signal.aborted) return c.body(null, 204);
    let done = false;
    let checking = false;
    let dirty = false;
    let subscribed = false;
    let complete!: (snapshot: Snapshot | undefined) => void;
    let fail!: (error: unknown) => void;
    const result = new Promise<Snapshot | undefined>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    const finish = (snapshot?: Snapshot) => {
      if (done) return;
      done = true;
      complete(snapshot);
    };
    const check = async () => {
      dirty = true;
      if (!subscribed || checking || done) return;
      checking = true;
      try {
        do {
          dirty = false;
          // Recheck current service credentials/settings on every delivery attempt.
          await options.authenticate(c);
          if (done) return;
          const snapshot = await getGatewaySnapshot(options.db, options.env);
          if (done) return;
          const route = snapshot.routes.find((route) => route.id === input.routeId);
          if (!route || route.generation !== input.generation) throw new DomainError('conflict');
          const proof = route.completedSleep;
          if (
            proof?.generation === input.generation &&
            proof.quiescenceUntil === input.quiescenceUntil
          ) {
            // A token rotation during the snapshot read cannot grant a receipt.
            await options.authenticate(c);
            if (!done) finish(snapshot);
          }
        } while (dirty && !done);
      } catch (error) {
        if (!done) {
          done = true;
          fail(error);
        }
      } finally {
        checking = false;
      }
    };
    const abort = () => finish();
    const timer = setTimeout(abort, remaining);
    timer.unref();
    c.req.raw.signal.addEventListener('abort', abort, { once: true });
    let subscription: ReturnType<typeof subscribe> | undefined;
    try {
      subscription = subscribe({
        changed: () => {
          void check();
        },
        lost: abort,
      });
      void subscription.ready.then(() => {
        subscribed = true;
        void check();
      });
      if (c.req.raw.signal.aborted) abort();
      const snapshot = await result;
      return snapshot ? c.json(snapshot) : c.body(null, 204);
    } finally {
      done = true;
      clearTimeout(timer);
      c.req.raw.signal.removeEventListener('abort', abort);
      subscription?.close();
    }
  });
}
