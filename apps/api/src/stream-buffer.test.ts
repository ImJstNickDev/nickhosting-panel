import { describe, expect, it, vi } from 'vitest';
import { boundedEventWriter } from './stream-buffer.js';

describe('bounded console output', () => {
  it('disconnects a slow reader once without retaining an unbounded event queue', async () => {
    const write = vi.fn(async () => undefined),
      disconnect = vi.fn();
    const output = boundedEventWriter(write, disconnect, { bytes: 256, events: 2, timeoutMs: 50 });
    for (let i = 0; i < 10000; i++) output.send({ event: 'console', data: 'message' });
    await output.drain();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });
  it('preserves event order for a reader that accepts output', async () => {
    const received: string[] = [],
      disconnect = vi.fn();
    const output = boundedEventWriter(async (e) => {
      received.push(e.data);
    }, disconnect);
    output.send({ event: 'console', data: 'first' });
    output.send({ event: 'closed', data: 'second' });
    await output.drain();
    expect(received).toEqual(['first', 'second']);
    expect(disconnect).not.toHaveBeenCalled();
  });
  it('disconnects even a single indefinitely stalled write', async () => {
    const disconnect = vi.fn();
    const output = boundedEventWriter(() => new Promise(() => {}), disconnect, {
      bytes: 256,
      events: 2,
      timeoutMs: 10,
    });
    output.send({ event: 'console', data: 'message' });
    await output.drain();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
