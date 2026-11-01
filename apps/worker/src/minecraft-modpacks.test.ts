import { type JobNotificationPool, listenForJobOutbox } from '@nickhosting/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMinecraftModpackLoop } from './minecraft-modpacks.js';

vi.mock('@nickhosting/database', () => ({ listenForJobOutbox: vi.fn() }));
const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<undefined>((done) => {
    resolve = () => done(undefined);
  });
  return { promise, resolve };
};
function fixture() {
  const listener = { close: vi.fn() };
  vi.mocked(listenForJobOutbox).mockResolvedValue(listener);
  const pending = vi.fn(async (_limit: number) => [] as string[]);
  const process = vi.fn(async (_id: string): Promise<'continue' | undefined> => undefined);
  const service = vi.fn(async () => ({ pending, process }));
  const unavailable = vi.fn();
  const loop = startMinecraftModpackLoop({
    service,
    notificationPool: {} as JobNotificationPool,
    unavailable,
  });
  return { loop, service, pending, process, unavailable, listener };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});
describe('Modpack durable worker loop', () => {
  it('wakes on committed notifications with a bounded fallback and no overlapping polls', async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pending).toHaveBeenCalledWith(20);
    const wake = vi.mocked(listenForJobOutbox).mock.calls[0]?.[1];
    wake?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pending).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.pending).toHaveBeenCalledTimes(3);
    await f.loop.close();
    expect(f.listener.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.pending).toHaveBeenCalledTimes(3);
  });
  it('runs at most two operations and fills a free slot while another backup is still running', async () => {
    const f = fixture();
    const gate = deferred(),
      second = deferred(),
      third = deferred();
    f.pending.mockResolvedValueOnce(['one', 'two', 'three']);
    f.process
      .mockImplementationOnce(() => gate.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.process.mock.calls).toEqual([['one'], ['two']]);
    f.pending.mockResolvedValueOnce(['three']);
    f.loop.wake();
    f.loop.wake();
    f.loop.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pending).toHaveBeenCalledTimes(1);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.process.mock.calls).toEqual([['one'], ['two'], ['three']]);
    expect(f.service).toHaveBeenCalledTimes(2);
    expect(f.pending).toHaveBeenLastCalledWith(20);
    second.resolve();
    third.resolve();
    await f.loop.close();
  });
  it('immediately claims a persisted apply transition without the cleanup cooldown', async () => {
    const f = fixture();
    const apply = deferred();
    f.pending.mockResolvedValue(['install']);
    f.process.mockResolvedValueOnce('continue').mockImplementationOnce(() => apply.promise);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.process.mock.calls).toEqual([['install'], ['install']]);
    apply.resolve();
    await f.loop.close();
  });
  it('does not let a simultaneous cleanup completion delay an apply transition', async () => {
    const f = fixture();
    const apply = deferred();
    f.pending.mockResolvedValueOnce(['install', 'cleanup']).mockResolvedValue(['install']);
    f.process
      .mockResolvedValueOnce('continue')
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => apply.promise);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.process.mock.calls).toEqual([['install'], ['cleanup'], ['install']]);
    apply.resolve();
    await f.loop.close();
  });
  it('waits for an in-flight effect on shutdown without beginning another operation', async () => {
    const f = fixture();
    const gate = deferred();
    f.pending.mockResolvedValueOnce(['one']);
    f.process.mockImplementationOnce(() => gate.promise);
    await vi.advanceTimersByTimeAsync(0);
    let closed = false;
    const close = f.loop.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    gate.resolve();
    await close;
    expect(f.process.mock.calls).toEqual([['one']]);
  });
  it('contains service failures and reconnects a failed notification listener', async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(0);
    f.service.mockRejectedValueOnce(new Error('private connection detail'));
    f.loop.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.unavailable).toHaveBeenCalledOnce();
    const lost = vi.mocked(listenForJobOutbox).mock.calls[0]?.[2];
    lost?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(listenForJobOutbox).toHaveBeenCalledTimes(2);
    await f.loop.close();
  });
  it('bounds successful cleanup retries while allowing later queued work past cooled rows', async () => {
    const f = fixture();
    f.pending.mockResolvedValue(['retained-cleanup', 'queued-install']);
    const gate = deferred();
    f.process.mockImplementation(async (id) => {
      if (id === 'queued-install') await gate.promise;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(f.process.mock.calls).toEqual([['retained-cleanup'], ['queued-install']]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.process.mock.calls.filter(([id]) => id === 'retained-cleanup')).toHaveLength(2);
    gate.resolve();
    await f.loop.close();
  });
  it('does not spin on expired cleanup cooldowns while both slots are occupied', async () => {
    const scheduled = vi.spyOn(globalThis, 'setTimeout');
    const f = fixture();
    f.pending.mockResolvedValueOnce(['retained-cleanup']);
    await vi.advanceTimersByTimeAsync(0);
    const gate = deferred();
    f.pending.mockResolvedValue(['one', 'two']);
    f.process.mockImplementation(() => gate.promise);
    f.loop.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.process.mock.calls).toEqual([['retained-cleanup'], ['one'], ['two']]);
    scheduled.mockClear();
    await vi.advanceTimersByTimeAsync(6000);
    expect(scheduled.mock.calls.length).toBeLessThanOrEqual(2);
    expect(f.pending).toHaveBeenCalledTimes(2);
    gate.resolve();
    await f.loop.close();
    scheduled.mockRestore();
  });
});
