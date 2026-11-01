import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewerAccessWatch } from './viewer-access-watch.js';

describe('shared viewer access watcher', () => {
  const watches: ViewerAccessWatch[] = [];
  const create = () => {
    const watch = new ViewerAccessWatch(60_000);
    watches.push(watch);
    return watch;
  };
  afterEach(() => {
    for (const watch of watches.splice(0)) watch.close();
  });

  it('singleflights checks shared by one session/server while isolating other sessions', async () => {
    const watch = create();
    const check = Promise.withResolvers<void>();
    const validate = vi.fn(() => check.promise);
    const other = vi.fn(async () => {});
    const a = watch.subscribe('session-a/server', validate);
    const b = watch.subscribe('session-a/server', validate);
    const c = watch.subscribe('session-b/server', other);
    expect(a.signal).toBe(b.signal);
    expect(c.signal).not.toBe(a.signal);
    watch.tick();
    watch.tick();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    check.reject(new Error('session_revoked'));
    await vi.waitFor(() => expect(a.signal.aborted).toBe(true));
    expect(b.signal.aborted).toBe(true);
    expect(c.signal.aborted).toBe(false);
    watch.tick();
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('keeps checking until the final reference closes; release is idempotent', async () => {
    const watch = create();
    const check = vi.fn(async () => {});
    const a = watch.subscribe('shared', check);
    const b = watch.subscribe('shared', check);
    a.release();
    a.release();
    watch.tick();
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    b.release();
    watch.tick();
    expect(check).toHaveBeenCalledTimes(1);
    watch.close();
    expect(a.signal.aborted).toBe(false);
  });

  it('does not let an older failed check remove a new subscription with the same key', async () => {
    const watch = create();
    const pending = Promise.withResolvers<void>();
    const old = watch.subscribe('session/server', () => pending.promise);
    watch.tick();
    old.release();
    const freshCheck = vi.fn(async () => {});
    const fresh = watch.subscribe('session/server', freshCheck);
    pending.reject(new Error('old_session_closed'));
    await vi.waitFor(() => expect(old.signal.aborted).toBe(true));
    watch.tick();
    expect(freshCheck).toHaveBeenCalledTimes(1);
    expect(fresh.signal.aborted).toBe(false);
    watch.close();
    expect(fresh.signal.aborted).toBe(true);
  });
});
