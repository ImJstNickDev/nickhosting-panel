import { afterEach, describe, expect, it, vi } from 'vitest';
import { type OpenLogSnapshot, ViewerLogSessions } from './viewer-log-sessions.js';

const managers: ViewerLogSessions[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});
function setup(options: ConstructorParameters<typeof ViewerLogSessions>[0] = {}) {
  const manager = new ViewerLogSessions(options);
  managers.push(manager);
  return manager;
}
function snapshot(revision = 'v1') {
  const controller = new AbortController();
  const query = vi.fn(async () => ({
    rows: [{ line: 1, text: revision, level: 'info' as const }],
    offset: 0,
    total: 1,
    totalLines: 1,
  }));
  const closeValue = vi.fn(async () => {}),
    close = vi.fn(async () => {});
  const create = vi.fn(async () => ({ query, close: closeValue }));
  return { revision, signal: controller.signal, create, close, query, closeValue, controller };
}
const signal = () => new AbortController().signal;
const request = { offset: 0, limit: 200, query: '', level: 'all' as const };
describe('viewer log tab leases', () => {
  it('shares one immutable snapshot, retains it until both tabs close, and isolates owners', async () => {
    const manager = setup(),
      first = snapshot(),
      duplicate = snapshot();
    const a = await manager.open('owner', 'log', 'binding', first, signal());
    const b = await manager.open('owner', 'log', 'binding', duplicate, signal());
    expect(first.create).toHaveBeenCalledTimes(1);
    expect(duplicate.create).not.toHaveBeenCalled();
    expect(duplicate.close).toHaveBeenCalledTimes(1);
    expect(() => manager.inspect('other', a.sessionId)).toThrow();
    await manager.release('other', a.sessionId);
    expect((await manager.query('owner', a.sessionId, request, signal())).revision).toBe('v1');
    await manager.release('owner', a.sessionId);
    expect(first.closeValue).not.toHaveBeenCalled();
    await manager.release('owner', b.sessionId);
    expect(first.closeValue).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
  });
  it('renews leases without downloading and expires abandoned tabs', async () => {
    let now = 0;
    const manager = setup({ idleMs: 90, now: () => now }),
      value = snapshot();
    const opened = await manager.open('owner', 'log', 'binding', value, signal());
    now = 80;
    manager.renew('owner', opened.sessionId);
    now = 100;
    await manager.expire();
    expect(manager.inspect('owner', opened.sessionId).path).toBe('log');
    now = 171;
    await manager.expire();
    expect(() => manager.inspect('owner', opened.sessionId)).toThrow();
    expect(value.create).toHaveBeenCalledTimes(1);
    expect(value.closeValue).toHaveBeenCalledTimes(1);
  });
  it('preserves old data during replacement and after failed refresh, then swaps atomically', async () => {
    const manager = setup(),
      first = snapshot(),
      next = snapshot('v2');
    const opened = await manager.open('owner', 'log', 'binding', first, signal());
    await expect(
      manager.refresh('owner', opened.sessionId, async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');
    const gate = Promise.withResolvers<OpenLogSnapshot>();
    const refreshing = manager.refresh('owner', opened.sessionId, () => gate.promise);
    expect((await manager.query('owner', opened.sessionId, request, signal())).revision).toBe('v1');
    gate.resolve(next);
    expect(await refreshing).toEqual({ revision: 'v2', changed: true });
    expect((await manager.query('owner', opened.sessionId, request, signal())).rows[0]?.text).toBe(
      'v2',
    );
    expect(first.closeValue).toHaveBeenCalledTimes(1);
    const unchanged = snapshot('v2');
    expect(await manager.refresh('owner', opened.sessionId, async () => unchanged)).toEqual({
      revision: 'v2',
      changed: false,
    });
    expect(unchanged.create).not.toHaveBeenCalled();
    expect(unchanged.close).toHaveBeenCalledTimes(1);
  });
  it('revocation drops all leases sharing the snapshot and denies further reads', async () => {
    const manager = setup(),
      value = snapshot();
    const opened = await manager.open('owner', 'log', 'binding', value, signal());
    value.controller.abort();
    await vi.waitFor(() => expect(value.closeValue).toHaveBeenCalledTimes(1));
    await expect(manager.query('owner', opened.sessionId, request, signal())).rejects.toMatchObject(
      { code: 'not_found' },
    );
  });
  it('defers disposal while a reader exits and prevents a closing tab publishing a refresh', async () => {
    const manager = setup(),
      value = snapshot(),
      entered = Promise.withResolvers<void>(),
      done = Promise.withResolvers<Awaited<ReturnType<typeof value.query>>>();
    value.query.mockImplementationOnce(async () => {
      entered.resolve();
      return done.promise;
    });
    const opened = await manager.open('owner', 'log', 'binding', value, signal());
    const querying = manager.query('owner', opened.sessionId, request, signal());
    const rejected = expect(querying).rejects.toThrow();
    await entered.promise;
    const closing = manager.release('owner', opened.sessionId);
    expect(value.closeValue).not.toHaveBeenCalled();
    done.resolve({ rows: [], offset: 0, total: 0, totalLines: 0 });
    await rejected;
    await closing;
    expect(value.closeValue).toHaveBeenCalledTimes(1);
  });
  it('cleans an abandoned pending open after its shared factory settles', async () => {
    const manager = setup(),
      value = snapshot(),
      entered = Promise.withResolvers<void>();
    const created = Promise.withResolvers<Awaited<ReturnType<typeof value.create>>>();
    value.create.mockImplementationOnce(async () => {
      entered.resolve();
      return created.promise;
    });
    const controller = new AbortController();
    const opening = manager.open('owner', 'log', 'binding', value, controller.signal);
    const rejected = expect(opening).rejects.toThrow();
    await entered.promise;
    controller.abort();
    await rejected;
    created.resolve({ query: value.query, close: value.closeValue });
    await vi.waitFor(() => expect(value.closeValue).toHaveBeenCalledTimes(1));
    expect(value.close).toHaveBeenCalledTimes(1);
  });
  it('bounds tab leases before opening extra parsers', async () => {
    const manager = setup({ maximum: 1 });
    await manager.open('owner', 'log', 'binding', snapshot(), signal());
    const next = snapshot('v2');
    await expect(manager.open('owner', 'other', 'binding', next, signal())).rejects.toMatchObject({
      code: 'viewer_cache_busy',
    });
    expect(next.create).not.toHaveBeenCalled();
    expect(next.close).toHaveBeenCalledTimes(1);
  });
});
