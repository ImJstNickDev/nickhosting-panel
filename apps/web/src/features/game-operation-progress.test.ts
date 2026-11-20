import { afterEach, expect, it, vi } from 'vitest';
import { gameProgressInterval, watchGameOperation } from './game-operation-progress.js';

afterEach(() => vi.useRealTimers());

it('coalesces a burst and catches up once for hints committed during a read', async () => {
  vi.useFakeTimers();
  const stream = Object.assign(new EventTarget(), {
    close: vi.fn(),
    onerror: undefined as (() => void) | undefined,
  });
  const first = Promise.withResolvers<void>();
  const refresh = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
  const connected = vi.fn();
  const stop = watchGameOperation(stream as unknown as EventSource, 's', 'j', connected, refresh);
  const hint = (value: unknown) =>
    stream.dispatchEvent(new MessageEvent('activity', { data: JSON.stringify(value) }));
  stream.dispatchEvent(new Event('ready'));
  for (let i = 0; i < 200; i++) hint({ server_id: 's', job_id: 'j' });
  await vi.advanceTimersByTimeAsync(40);
  expect(refresh).toHaveBeenCalledTimes(1);
  hint({ serverId: 's' });
  hint({ server_id: 's', job_id: 'j' });
  first.resolve();
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).toHaveBeenCalledTimes(2);
  hint({ server_id: 's', job_id: 'another' });
  hint({ server_id: 'another', job_id: 'j' });
  stream.dispatchEvent(new MessageEvent('activity', { data: '?' }));
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).toHaveBeenCalledTimes(2);
  stream.onerror?.();
  expect(connected.mock.calls).toEqual([[true], [false]]);
  stream.dispatchEvent(new Event('ready'));
  await vi.advanceTimersByTimeAsync(50);
  expect(refresh).toHaveBeenCalledTimes(3);
  hint({ serverId: 's' });
  stop();
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).toHaveBeenCalledTimes(3);
  expect(stream.close).toHaveBeenCalledOnce();
});

it('uses slow verification on a healthy stream and keeps fallback, transfer and recovery live', () => {
  const running = { state: 'running', effectState: 'prepared' };
  expect(gameProgressInterval(running, true)).toBe(15000);
  expect(gameProgressInterval(running, false)).toBe(3000);
  expect(gameProgressInterval(running, false, Date.now() + 3000)).toBe(500);
  expect(
    gameProgressInterval({ ...running, fileTransfer: { completedFiles: 1, totalFiles: 4 } }, true),
  ).toBe(2000);
  expect(gameProgressInterval({ state: 'failed', effectState: 'uncertain' }, false)).toBe(3000);
  expect(gameProgressInterval({ state: 'succeeded', effectState: 'confirmed' }, false)).toBe(false);
});
