import { afterEach, describe, expect, it, vi } from 'vitest';
import { startProviderFeedLoop } from './provider-feed.js';

afterEach(() => vi.useRealTimers());
describe('provider feed background loop', () => {
  it('refreshes immediately then every fifteen seconds and cancels on close', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {});
    const loop = startProviderFeedLoop(refresh, vi.fn());
    await vi.advanceTimersByTimeAsync(30000);
    expect(refresh).toHaveBeenCalledTimes(3);
    await loop.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
  it('never overlaps slow refreshes and waits for in-flight work on shutdown', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<void>();
    const refresh = vi.fn(() => pending.promise);
    const loop = startProviderFeedLoop(refresh, vi.fn());
    await vi.advanceTimersByTimeAsync(60000);
    expect(refresh).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = loop.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    pending.resolve();
    await closing;
    await vi.advanceTimersByTimeAsync(30000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('reports a failed provider refresh and retries on the next interval', async () => {
    vi.useFakeTimers();
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValue(undefined);
    const failed = vi.fn();
    const loop = startProviderFeedLoop(refresh, failed);
    await vi.advanceTimersByTimeAsync(15000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenCalledTimes(1);
    await loop.close();
  });
});
