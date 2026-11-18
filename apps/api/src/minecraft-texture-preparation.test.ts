import { expect, it, vi } from 'vitest';
import { scheduleMinecraftTextures } from './minecraft-texture-preparation.js';

it('starts with no viewer, coalesces a request during preparation and shuts down without another scan', async () => {
  vi.useFakeTimers();
  const ready = Promise.withResolvers<void>();
  const prepare = vi.fn(async (id: string) => {
    if (id === 'a') await ready.promise;
  });
  const list = vi.fn(async () => ['a', 'b']);
  const failed = vi.fn();
  const jobs = scheduleMinecraftTextures(list, prepare, failed);
  try {
    await vi.advanceTimersByTimeAsync(1001);
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['a']);
    jobs.request('a');
    jobs.request('b');
    ready.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    expect(failed).not.toHaveBeenCalled();
    await jobs.close();
    await vi.advanceTimersByTimeAsync(300001);
    expect(list).toHaveBeenCalledOnce();
  } finally {
    ready.resolve();
    await jobs.close();
    vi.useRealTimers();
  }
});
