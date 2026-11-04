import { expect, it, vi } from 'vitest';
import { SatisfactoryApi } from '../../../games/satisfactory/src/api.js';
import {
  satisfactoryWorldsStreamResponse,
  streamSatisfactoryWorlds,
  type WorldsStreamDependencies,
} from './satisfactory-worlds-stream.js';

const save = {
  saveVersion: 1,
  buildVersion: 123,
  saveName: 'factory',
  mapName: 'Persistent_Level',
  mapOptions: '',
  sessionName: 'Factory',
  playDurationSeconds: 123,
  saveDateTime: '2026-11-02T00:00:00Z',
  isModdedSave: false,
  isEditedSave: false,
  isCreativeModeEnabled: false,
};
const data = {
  sessions: [{ sessionName: 'Factory', saveHeaders: [save] }],
  currentSessionIndex: 0,
};
const ready = {
  runtime_state: 'running',
  readiness: 'ready',
  installation_state: 'installed',
  active_operation_id: null,
  pterodactyl_uuid: 'uuid',
  generation: 'generation',
  process_started_at: '2026-11-02',
};
function fixture(overrides: Partial<WorldsStreamDependencies> = {}): WorldsStreamDependencies {
  return {
    snapshot: vi.fn(async () => ({ data, observedAt: 100 })),
    runtime: vi.fn(async () => ready),
    configured: vi.fn(async () => true),
    api: vi.fn(
      async () =>
        new SatisfactoryApi({
          request: vi.fn(),
          async *streamRequest() {
            yield Buffer.from(JSON.stringify({ data }));
          },
        }),
    ),
    persist: vi.fn(async () => {}),
    classify: vi.fn(async () => new Set<string>()),
    ...overrides,
  };
}
it.each([
  { runtime_state: 'offline', readiness: 'unknown' },
  { runtime_state: 'starting', readiness: 'loading' },
  { runtime_state: 'running', readiness: 'loading' },
])(
  'serves the existing encrypted snapshot without backend access during $runtime_state/$readiness',
  async (runtime) => {
    const deps = fixture({ runtime: vi.fn(async () => ({ ...ready, ...runtime })) });
    const events = await collect(
      streamSatisfactoryWorlds('cached', deps, new AbortController().signal),
    );
    expect(events).toContainEqual({
      type: 'complete',
      source: 'cache',
      currentSessionIndex: 0,
      observedAt: 100,
    });
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(deps.api).not.toHaveBeenCalled();
  },
);
it('does not invent an empty enumeration when no cached observation exists', async () => {
  const deps = fixture({
    snapshot: async () => undefined,
    runtime: async () => ({ ...ready, runtime_state: 'offline' }),
  });
  expect(
    await collect(streamSatisfactoryWorlds('unknown', deps, new AbortController().signal)),
  ).toEqual([{ type: 'state', phase: 'offline', configured: true, hasSnapshot: false }]);
});
it('propagates real native save events through the HTTP body before the native response ends', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ended = false;
  const deps = fixture({
    snapshot: async () => undefined,
    api: async () =>
      new SatisfactoryApi({
        request: vi.fn(),
        async *streamRequest() {
          yield Buffer.from(
            `{"data":{"sessions":[{"sessionName":"Factory","saveHeaders":[${JSON.stringify(save)}`,
          );
          await gate;
          ended = true;
          yield Buffer.from(']}],"currentSessionIndex":0}}');
        },
      }),
  });
  const abort = new AbortController();
  const response = satisfactoryWorldsStreamResponse(
    streamSatisfactoryWorlds('progressive', deps, abort.signal),
    abort,
  );
  if (!response.body) throw new Error('missing response body');
  const reader = response.body.getReader();
  const events: unknown[] = [];
  while (!events.some((event) => (event as { type: string }).type === 'save')) {
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    events.push(JSON.parse(new TextDecoder().decode(chunk.value)));
  }
  expect(ended).toBe(false);
  expect(deps.persist).not.toHaveBeenCalled();
  release();
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    events.push(JSON.parse(new TextDecoder().decode(item.value)));
  }
  expect(events).toContainEqual(expect.objectContaining({ type: 'complete', source: 'live' }));
  expect(deps.persist).toHaveBeenCalledExactlyOnceWith(data);
});
it('keeps cache authoritative after a late native error, with no partial persistence', async () => {
  const deps = fixture({
    api: async () =>
      new SatisfactoryApi({
        request: vi.fn(),
        async *streamRequest() {
          yield Buffer.from(JSON.stringify({ data, errorCode: 'insufficient_scope' }));
        },
      }),
  });
  const events = await collect(
    streamSatisfactoryWorlds('late-error', deps, new AbortController().signal),
  );
  expect(events).toContainEqual(expect.objectContaining({ type: 'complete', source: 'cache' }));
  expect(events).not.toContainEqual(expect.objectContaining({ type: 'complete', source: 'live' }));
  expect(events).toContainEqual({ type: 'error', code: 'integration_unavailable' });
  expect(deps.persist).not.toHaveBeenCalled();
});
it('treats a concurrent lifecycle transition as waiting, and never commits data from the previous generation', async () => {
  const runtime = vi
    .fn()
    .mockResolvedValueOnce(ready)
    .mockResolvedValue({
      ...ready,
      runtime_state: 'starting',
      readiness: 'loading',
      active_operation_id: 'new',
    });
  const deps = fixture({ runtime });
  const events = await collect(
    streamSatisfactoryWorlds('transition', deps, new AbortController().signal),
  );
  expect(events).toContainEqual({
    type: 'state',
    phase: 'starting',
    configured: true,
    hasSnapshot: true,
  });
  expect(events.some((event) => event.type === 'error')).toBe(false);
  expect(deps.persist).not.toHaveBeenCalled();
});
it('coalesces simultaneous tabs and streams the validated result to both', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deps = fixture({
    snapshot: async () => undefined,
    api: vi.fn(
      async () =>
        new SatisfactoryApi({
          request: vi.fn(),
          async *streamRequest() {
            await gate;
            yield Buffer.from(JSON.stringify({ data }));
          },
        }),
    ),
  });
  const leader = streamSatisfactoryWorlds('shared', deps, new AbortController().signal);
  await leader.next();
  await leader.next();
  await leader.next();
  const follower = collect(streamSatisfactoryWorlds('shared', deps, new AbortController().signal));
  await Promise.resolve();
  release();
  const [a, b] = await Promise.all([collect(leader), follower]);
  expect(deps.api).toHaveBeenCalledOnce();
  expect(a).toContainEqual(expect.objectContaining({ type: 'complete', source: 'live' }));
  expect(b).toContainEqual(expect.objectContaining({ type: 'complete', source: 'live' }));
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

it('rejects an old native response after a stop/start ABA gateway generation change', async () => {
  const runtime = vi
    .fn()
    .mockResolvedValueOnce(ready)
    .mockResolvedValue({ ...ready, generation: 'restarted' });
  const deps = fixture({ runtime });
  const events = await collect(
    streamSatisfactoryWorlds('generation', deps, new AbortController().signal),
  );
  expect(events).not.toContainEqual(expect.objectContaining({ type: 'complete', source: 'live' }));
  expect(deps.persist).not.toHaveBeenCalled();
});

it('admits cached snapshots before decryption and reuses the budget after a paused reader aborts', async () => {
  const held = Array.from({ length: 4 }, (_, index) => {
    const abort = new AbortController();
    const deps = fixture({ runtime: async () => ({ ...ready, runtime_state: 'offline' }) });
    return {
      abort,
      deps,
      stream: streamSatisfactoryWorlds(`held-cache-${index}`, deps, abort.signal),
    };
  });
  try {
    for (const item of held) expect((await item.stream.next()).value?.type).toBe('state');
    const overflow = fixture();
    await expect(
      streamSatisfactoryWorlds('overflow', overflow, new AbortController().signal).next(),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(overflow.snapshot).not.toHaveBeenCalled();
    expect(overflow.runtime).not.toHaveBeenCalled();
    const first = held[0];
    if (!first) throw new Error('missing held stream');
    first.abort.abort();
    // No further next() is required to release a yielded cached snapshot.
    await vi.waitFor(async () => {
      const probe = streamSatisfactoryWorlds(
        'released-slot',
        fixture({ runtime: async () => ({ ...ready, runtime_state: 'offline' }) }),
        new AbortController().signal,
      );
      try {
        expect((await probe.next()).value?.type).toBe('state');
      } finally {
        await probe.return(undefined);
      }
    });
    expect((await first.stream.next()).done).toBe(true);
  } finally {
    for (const item of held) {
      item.abort.abort();
      await item.stream.return(undefined);
    }
  }
});

it('expires a cached HTTP response even when the consumer stops pulling', async () => {
  const abort = new AbortController();
  const deadline = AbortSignal.timeout(50);
  const signal = AbortSignal.any([abort.signal, deadline]);
  const deps = fixture({ runtime: async () => ({ ...ready, runtime_state: 'offline' }) });
  const stream = streamSatisfactoryWorlds('cached-deadline', deps, signal);
  const response = satisfactoryWorldsStreamResponse(stream, abort, signal);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing response body');
  expect((await reader.read()).done).toBe(false);
  await vi.waitFor(() => expect(deadline.aborted).toBe(true));
  expect(abort.signal.aborted).toBe(true);
  await expect(reader.read()).rejects.toMatchObject({ name: 'TimeoutError' });
  expect((await stream.next()).done).toBe(true);
  expect(deps.classify).not.toHaveBeenCalled();
  expect(deps.api).not.toHaveBeenCalled();
  reader.releaseLock();
});

it('cancels admission waiting on snapshot I/O without retaining a pending stream', async () => {
  const abort = new AbortController();
  const deps = fixture({ snapshot: async () => new Promise(() => {}) });
  const stream = streamSatisfactoryWorlds('pending-snapshot', deps, abort.signal);
  const pending = stream.next();
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect((await stream.next()).done).toBe(true);
  expect(deps.api).not.toHaveBeenCalled();
});
