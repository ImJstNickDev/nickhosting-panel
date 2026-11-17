import {
  type SatisfactoryWorldsStreamEvent,
  satisfactoryWorldsStreamEventSchema,
} from '../worlds-stream.js';

/** Consume bounded records as they arrive; a response body is never buffered. */
export async function consumeWorldsStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: SatisfactoryWorldsStreamEvent) => void,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '',
    bytes = 0,
    records = 0;
  const abort = () => {
    void reader.cancel();
  };
  signal.addEventListener('abort', abort, { once: true });
  const record = (line: string) => {
    if (!line.trim()) return;
    if (line.length > 262144 || ++records > 300000) throw new Error('invalid_worlds_stream');
    onEvent(satisfactoryWorldsStreamEventSchema.parse(JSON.parse(line)));
  };
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024 * 1024) throw new Error('worlds_stream_too_large');
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary = pending.indexOf('\n');
      while (boundary >= 0) {
        record(pending.slice(0, boundary));
        pending = pending.slice(boundary + 1);
        // Cached responses can already have many chunks queued. Yield bounded work
        // so rendering and cancellation do not wait for the final network frame.
        if (records % 512 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        boundary = pending.indexOf('\n');
      }
      if (pending.length > 262144) throw new Error('invalid_worlds_stream');
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    pending += decoder.decode();
    if (pending.trim()) record(pending);
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
