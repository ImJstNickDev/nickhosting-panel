/** Bound asynchronous SSE output independently of the upstream rate limit. */
export function boundedEventWriter(
  write: (event: { event: string; data: string }) => Promise<unknown>,
  disconnect: () => void,
  limits = { bytes: 262144, events: 64, timeoutMs: 5000 },
) {
  let bytes = 0;
  let events = 0;
  let closed = false;
  let pending = Promise.resolve();
  const fail = () => {
    if (closed) return;
    closed = true;
    disconnect();
  };
  return {
    send(event: { event: string; data: string }) {
      if (closed) return;
      const size = Buffer.byteLength(event.event) + Buffer.byteLength(event.data) + 32;
      if (bytes + size > limits.bytes || events + 1 > limits.events) return fail();
      bytes += size;
      events++;
      pending = pending.then(async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (closed) return;
          await Promise.race([
            write(event),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('slow stream')), limits.timeoutMs);
            }),
          ]);
        } catch {
          fail();
        } finally {
          if (timer) clearTimeout(timer);
          bytes -= size;
          events--;
        }
      });
    },
    drain: () => pending,
    close: () => {
      closed = true;
    },
  };
}
