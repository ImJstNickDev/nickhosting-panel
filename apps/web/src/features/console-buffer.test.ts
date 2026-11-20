import { afterEach, expect, it, vi } from 'vitest';
import { type ConsoleBuffer, consoleBufferWriter } from './console-buffer.js';

function scheduler() {
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let next = 0;
  vi.stubGlobal('window', {
    requestAnimationFrame(callback: () => void) {
      frames.set(++next, callback);
      return next;
    },
    setTimeout(callback: () => void) {
      timers.set(++next, callback);
      return next;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    clearTimeout: (id: number) => timers.delete(id),
  });
  return { frames, timers };
}
afterEach(() => vi.unstubAllGlobals());

it('publishes the ordered final 300 lines once per frame and retains status across eviction', () => {
  const { frames, timers } = scheduler();
  const writes: ConsoleBuffer[] = [];
  const writer = consoleBufferWriter(undefined, (buffer) => writes.push(buffer));
  writer.append({ type: 'status', data: 'offline' });
  for (let i = 0; i < 2000; i++) writer.append({ type: 'console', data: String(i) });
  expect(writer.hasHistory()).toBe(true);
  expect(frames.size).toBe(1);
  expect(timers.size).toBe(1);
  expect(writes).toHaveLength(0);
  for (const paint of frames.values()) paint();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.lines.map((line) => line.data)).toEqual(
    Array.from({ length: 300 }, (_, i) => String(1700 + i)),
  );
  expect(writes[0]?.lastStatus).toBe('offline');
  expect(timers.size).toBe(0);

  const resumed = consoleBufferWriter(writes[0], (buffer) => writes.push(buffer));
  resumed.append({ type: 'status', data: 'offline' });
  expect(frames.size).toBe(0);
  resumed.append({ type: 'status', data: 'running' });
  resumed.append({ type: 'console', data: 'last log' });
  resumed.flush();
  expect(writes).toHaveLength(2);
  expect(writes[1]?.lines.slice(-2)).toEqual([
    { type: 'status', data: 'running' },
    { type: 'console', data: 'last log' },
  ]);
  expect(writes[0]?.lines.at(-1)?.data).toBe('1999');
});

it('flushes in a hidden tab and cancels both pending callbacks when access is revoked', () => {
  const { frames, timers } = scheduler();
  const publish = vi.fn();
  const writer = consoleBufferWriter(undefined, publish);
  writer.append({ type: 'console', data: 'before hiding' });
  for (const deadline of timers.values()) deadline();
  expect(publish).toHaveBeenCalledTimes(1);
  expect(frames.size).toBe(0);
  writer.append({ type: 'console', data: 'pending revocation' });
  writer.discard();
  writer.flush();
  expect(frames.size).toBe(0);
  expect(timers.size).toBe(0);
  expect(writer.hasHistory()).toBe(false);
  expect(publish).toHaveBeenCalledTimes(1);
});
