import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHostObservationLoop } from './host-observations.js';

afterEach(() => vi.useRealTimers());
describe('independent physical observation loop', () => {
  it('samples every second and closes without leaving a timer', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {});
    const loop = startHostObservationLoop(refresh, vi.fn());
    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).toHaveBeenCalledTimes(4);
    await loop.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(4);
  });
  it('never overlaps slow samples and waits for in-flight work during shutdown', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<void>();
    const refresh = vi.fn(() => pending.promise);
    const loop = startHostObservationLoop(refresh, vi.fn());
    await vi.advanceTimersByTimeAsync(6000);
    expect(refresh).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = loop.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    pending.resolve();
    await closing;
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('continues after sample or diagnostic failure', async () => {
    vi.useFakeTimers();
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('sample failed'))
      .mockResolvedValue(undefined);
    const failed = vi.fn(() => {
      throw new Error('logger failed');
    });
    const loop = startHostObservationLoop(refresh, failed);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenCalledOnce();
    await loop.close();
  });
});
