import { describe, expect, it, vi } from 'vitest';
import { consumeWorldsStream } from './worlds-stream.js';

const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const state = { type: 'state', phase: 'starting', configured: true, hasSnapshot: true };

describe('Worlds browser stream consumer', () => {
  it('delivers a record before the response closes and handles split UTF-8 records beyond 64KiB', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const received: unknown[] = [];
    const consuming = consumeWorldsStream(stream, new AbortController().signal, (event) =>
      received.push(event),
    );
    controller.enqueue(encode(state));
    await vi.waitFor(() => expect(received).toEqual([state]));
    const bytes = encode({
      type: 'session',
      source: 'cache',
      index: 0,
      sessionName: 'Fabbrica è 🏭',
    });
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    for (let index = 0; index < 2000; index++) controller.enqueue(encode(state));
    controller.close();
    await consuming;
    expect(received).toHaveLength(2002);
    expect(received[1]).toMatchObject({ sessionName: 'Fabbrica è 🏭' });
  });
  it('cancels the underlying reader on abort rather than waiting for the next network chunk', async () => {
    const cancel = vi.fn(),
      abort = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const consuming = consumeWorldsStream(stream, abort.signal, vi.fn());
    abort.abort();
    await expect(consuming).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects oversized records and invalid schemas while releasing the stream', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(262145)));
      },
      cancel,
    });
    await expect(
      consumeWorldsStream(stream, new AbortController().signal, vi.fn()),
    ).rejects.toThrow('invalid_worlds_stream');
    expect(cancel).toHaveBeenCalledOnce();
    const invalid = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode({ ...state, phase: 'invented' }));
        controller.close();
      },
    });
    await expect(
      consumeWorldsStream(invalid, new AbortController().signal, vi.fn()),
    ).rejects.toThrow();
  });
});
