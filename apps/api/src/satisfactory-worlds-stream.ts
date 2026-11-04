import { DomainError, type SecretCodec } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { Kysely } from 'kysely';
import type { z } from 'zod';
import {
  type SatisfactoryApi,
  satisfactorySessionsSchema,
} from '../../../games/satisfactory/src/api.js';
import { readOfflineSnapshots } from '../../../games/satisfactory/src/offline-snapshots.js';
import type { SatisfactoryWorldsStreamEvent } from '../../../games/satisfactory/src/worlds-stream.js';
import {
  resolveSatisfactoryApi,
  satisfactoryApiConfigured,
} from '../../../packages/server-management/src/satisfactory-api.js';
import { classifySatisfactorySafetySaves } from '../../../packages/server-management/src/satisfactory-save-retention.js';
import { persistSatisfactoryOfflineSnapshots } from './gateway-satisfactory-offline.js';

type Sessions = z.infer<typeof satisfactorySessionsSchema>;
type Snapshot = { data: Sessions; observedAt: number };
type Runtime = {
  runtime_state: string;
  readiness: string;
  installation_state: string;
  active_operation_id: string | null;
  pterodactyl_uuid: string | null;
  generation: string | null;
  process_started_at: string | null;
};
export interface WorldsStreamDependencies {
  snapshot(signal?: AbortSignal): Promise<Snapshot | undefined>;
  runtime(): Promise<Runtime>;
  configured(): Promise<boolean>;
  api(): Promise<SatisfactoryApi>;
  persist(data: Sessions): Promise<void>;
  classify(names: string[]): Promise<Set<string>>;
}
function phase(runtime: Runtime): 'offline' | 'starting' | 'ready' {
  if (
    runtime.runtime_state === 'starting' ||
    (runtime.runtime_state === 'running' && runtime.readiness !== 'ready') ||
    runtime.installation_state !== 'installed'
  )
    return 'starting';
  return runtime.runtime_state === 'running' ? 'ready' : 'offline';
}
function sameRuntime(a: Runtime, b: Runtime): boolean {
  return (
    phase(b) === 'ready' &&
    a.active_operation_id === b.active_operation_id &&
    a.pterodactyl_uuid === b.pterodactyl_uuid &&
    a.generation === b.generation &&
    a.process_started_at === b.process_started_at
  );
}
async function* classification(
  deps: WorldsStreamDependencies,
  data: Sessions,
  source: 'cache' | 'live',
  signal: AbortSignal,
): AsyncGenerator<SatisfactoryWorldsStreamEvent> {
  signal.throwIfAborted();
  const names = [
    ...(await awaitAbortable(
      deps.classify(
        data.sessions.flatMap((session) => session.saveHeaders.map((save) => save.saveName)),
      ),
      signal,
    )),
  ];
  // Keep even worst-case 4096-character names within the browser event limit.
  for (let index = 0; index < names.length; index += 4) {
    signal.throwIfAborted();
    yield { type: 'classification', source, saveNames: names.slice(index, index + 4) };
  }
}
async function* snapshotEvents(
  deps: WorldsStreamDependencies,
  snapshot: Snapshot,
  source: 'cache' | 'live',
  signal: AbortSignal,
): AsyncGenerator<SatisfactoryWorldsStreamEvent> {
  signal.throwIfAborted();
  yield { type: 'begin', source, observedAt: snapshot.observedAt };
  for (const [index, session] of snapshot.data.sessions.entries()) {
    signal.throwIfAborted();
    yield { type: 'session', source, index, sessionName: session.sessionName };
    for (const save of session.saveHeaders) {
      signal.throwIfAborted();
      yield { type: 'save', source, sessionIndex: index, save };
    }
  }
  yield* classification(deps, snapshot.data, source, signal);
  signal.throwIfAborted();
  yield {
    type: 'complete',
    source,
    currentSessionIndex: snapshot.data.currentSessionIndex,
    observedAt: snapshot.observedAt,
  };
}
// A stream owns one bounded native parser. Other tabs share its persisted result;
// they never create duplicate backend enumeration requests or unbounded fan-out.
const active = new Map<string, Promise<Snapshot | undefined>>();
const maxLiveStreams = 4;
const maxWorldsStreams = 4;
let worldsStreams = 0;
/** Admission covers encrypted snapshots too. Closing a paused generator on abort
 * releases its retained snapshot without waiting for another consumer pull. */
export function streamSatisfactoryWorlds(
  serverId: string,
  deps: WorldsStreamDependencies,
  signal: AbortSignal,
): AsyncGenerator<SatisfactoryWorldsStreamEvent> {
  const events = (async function* () {
    try {
      signal.throwIfAborted();
      if (worldsStreams >= maxWorldsStreams) throw new DomainError('integration_unavailable');
      worldsStreams++;
      try {
        yield* streamAdmittedWorlds(serverId, deps, signal);
      } finally {
        worldsStreams--;
      }
    } finally {
      signal.removeEventListener('abort', close);
    }
  })();
  function close() {
    void events.return(undefined).catch(() => {});
  }
  signal.addEventListener('abort', close, { once: true });
  return events;
}
async function* streamAdmittedWorlds(
  serverId: string,
  deps: WorldsStreamDependencies,
  signal: AbortSignal,
): AsyncGenerator<SatisfactoryWorldsStreamEvent> {
  const [snapshot, runtime, configured] = await awaitAbortable(
    Promise.all([deps.snapshot(signal), deps.runtime(), deps.configured()]),
    signal,
  );
  let hasSnapshot = !!snapshot;
  const state = (value: SatisfactoryWorldsStreamEvent & { type: 'state' }) => value;
  yield state({
    type: 'state',
    phase: configured ? phase(runtime) : 'unavailable',
    configured,
    hasSnapshot,
  });
  if (snapshot) yield* snapshotEvents(deps, snapshot, 'cache', signal);
  signal.throwIfAborted();
  if (!configured || phase(runtime) !== 'ready') return;
  yield state({ type: 'state', phase: 'refreshing', configured, hasSnapshot });
  const pending = active.get(serverId);
  if (pending) {
    const completed = await awaitAbortable(pending, signal);
    const current = await deps.runtime();
    signal.throwIfAborted();
    if (completed && sameRuntime(runtime, current)) {
      yield* snapshotEvents(deps, completed, 'live', signal);
      yield state({ type: 'state', phase: 'ready', configured, hasSnapshot: true });
    } else
      yield state({
        type: 'state',
        phase: phase(current) === 'ready' ? 'starting' : phase(current),
        configured,
        hasSnapshot,
      });
    return;
  }
  if (active.size >= maxLiveStreams) {
    yield state({ type: 'state', phase: 'unavailable', configured, hasSnapshot });
    return;
  }
  let resolve!: (snapshot: Snapshot | undefined) => void;
  const completion = new Promise<Snapshot | undefined>((done) => {
    resolve = done;
  });
  active.set(serverId, completion);
  const releaseAborted = () => {
    if (active.get(serverId) === completion) active.delete(serverId);
    resolve(undefined);
  };
  signal.addEventListener('abort', releaseAborted, { once: true });
  let completed: Snapshot | undefined;
  try {
    const api = await deps.api();
    yield { type: 'begin', source: 'live', observedAt: Date.now() };
    for await (const event of api.streamSessions(signal)) {
      signal.throwIfAborted();
      if (event.type !== 'complete') {
        yield { ...event, source: 'live' };
        continue;
      }
      const current = await deps.runtime();
      signal.throwIfAborted();
      if (!sameRuntime(runtime, current)) {
        yield state({
          type: 'state',
          phase: phase(current) === 'ready' ? 'starting' : phase(current),
          configured,
          hasSnapshot,
        });
        return;
      }
      await deps.persist(event.data);
      completed = { data: event.data, observedAt: Date.now() };
      yield* classification(deps, event.data, 'live', signal);
      yield {
        type: 'complete',
        source: 'live',
        currentSessionIndex: event.data.currentSessionIndex,
        observedAt: completed.observedAt,
      };
      hasSnapshot = true;
    }
    yield state({ type: 'state', phase: 'ready', configured, hasSnapshot });
  } catch {
    if (signal.aborted) return;
    const current = await deps.runtime();
    const currentPhase = phase(current);
    if (currentPhase === 'ready') yield { type: 'error', code: 'integration_unavailable' };
    yield state({
      type: 'state',
      phase: currentPhase === 'ready' ? 'unavailable' : currentPhase,
      configured,
      hasSnapshot,
    });
  } finally {
    signal.removeEventListener('abort', releaseAborted);
    if (active.get(serverId) === completion) active.delete(serverId);
    resolve(completed);
  }
}
async function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
export function satisfactoryWorldsDependencies(
  db: Kysely<Database>,
  codec: SecretCodec,
  serverId: string,
): WorldsStreamDependencies {
  return {
    async snapshot(signal) {
      signal?.throwIfAborted();
      const name = `gateway.satisfactory.observations.${serverId}`;
      const stored = await db
        .selectFrom('encrypted_secrets')
        .select('envelope')
        .where('name', '=', name)
        .executeTakeFirst();
      signal?.throwIfAborted();
      const observation = readOfflineSnapshots(
        stored ? JSON.parse(codec.decrypt(stored.envelope, name)) : {},
      ).EnumerateSessions;
      if (!observation || observation.observedAt < 0 || observation.observedAt > Date.now() + 5000)
        return undefined;
      const parsed = satisfactorySessionsSchema.safeParse(observation.body.data);
      if (!parsed.success) return undefined;
      const removed = await db
        .selectFrom('satisfactory_safety_saves')
        .select(['session_name', 'save_name'])
        .where('server_id', '=', serverId)
        .where('deleted_at', '>=', new Date(observation.observedAt))
        .execute();
      signal?.throwIfAborted();
      // Receipts only hide saves proven removed after this observation. A newer
      // native observation can legitimately report a recreated same-name file.
      const names = new Set(
        removed.map((entry) => JSON.stringify([entry.session_name, entry.save_name])),
      );
      for (const session of parsed.data.sessions)
        session.saveHeaders = session.saveHeaders.filter(
          (save) => !names.has(JSON.stringify([session.sessionName, save.saveName])),
        );
      return { data: parsed.data, observedAt: observation.observedAt };
    },
    async runtime() {
      const server = await db
        .selectFrom('managed_servers as s')
        .leftJoin('gateway_server_states as g', 'g.server_id', 's.id')
        .select([
          's.runtime_state',
          's.readiness',
          's.installation_state',
          's.active_operation_id',
          's.pterodactyl_uuid',
          'g.generation',
          'g.process_started_at',
        ])
        .where('s.id', '=', serverId)
        .where('s.deleted_at', 'is', null)
        .executeTakeFirst();
      if (!server) throw new DomainError('not_found');
      return server;
    },
    configured: () => satisfactoryApiConfigured(db, serverId),
    api: () => resolveSatisfactoryApi(db, codec, serverId),
    persist: (data) =>
      persistSatisfactoryOfflineSnapshots(db, codec, serverId, [], {
        operation: 'EnumerateSessions',
        body: { data },
      }),
    classify: (names) => classifySatisfactorySafetySaves(db, serverId, names),
  };
}
/** Pull-driven response: both the browser's backpressure and disconnect reach
 * the native TLS iterator; no detached producer buffers an entire enumeration. */
export function satisfactoryWorldsStreamResponse(
  events: AsyncGenerator<SatisfactoryWorldsStreamEvent>,
  abort: AbortController,
  signal: AbortSignal = abort.signal,
): Response {
  const encoder = new TextEncoder();
  let ended = false;
  let onAbort: () => void;
  const cleanup = () => signal.removeEventListener('abort', onAbort);
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        start(controller) {
          onAbort = () => {
            if (ended) return;
            ended = true;
            cleanup();
            abort.abort(signal.reason);
            controller.error(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            void events.return(undefined).catch(() => {});
          };
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        },
        async pull(controller) {
          try {
            const item = await events.next();
            if (ended) return;
            if (item.done) {
              ended = true;
              cleanup();
              controller.close();
            } else controller.enqueue(encoder.encode(`${JSON.stringify(item.value)}\n`));
          } catch (error) {
            if (ended) return;
            ended = true;
            cleanup();
            abort.abort(error);
            controller.error(error);
            void events.return(undefined).catch(() => {});
          }
        },
        async cancel() {
          ended = true;
          cleanup();
          abort.abort();
          await events.return(undefined);
        },
      },
      { highWaterMark: 1 },
    ),
    {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    },
  );
}
