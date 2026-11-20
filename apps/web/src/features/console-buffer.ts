export type ConsoleLine = { type: 'console' | 'status'; data: string };
export type ConsoleBuffer = { lines: ConsoleLine[]; lastStatus?: string };

const capacity = 300;

// A private mutable ring per stream. Only immutable snapshots cross into the
// query cache; suspended tabs may receive thousands of lines between paints.
export function consoleBufferWriter(
  initial: ConsoleBuffer | undefined,
  publish: (snapshot: ConsoleBuffer) => void,
) {
  const ring = initial?.lines.slice(-capacity) ?? [];
  let cursor = ring.length % capacity;
  let lastStatus = initial?.lastStatus;
  let dirty = false;
  let frame: number | undefined;
  let timeout: number | undefined;

  function cancel() {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    window.clearTimeout(timeout);
    frame = undefined;
    timeout = undefined;
  }

  function flush() {
    cancel();
    if (!dirty) return;
    dirty = false;
    const lines =
      ring.length === capacity && cursor
        ? ring.slice(cursor).concat(ring.slice(0, cursor))
        : ring.slice();
    publish({ lines, lastStatus });
  }

  return {
    hasHistory: () => ring.length > 0,
    append(line: ConsoleLine) {
      if (line.type === 'status') {
        if (lastStatus === line.data) return;
        lastStatus = line.data;
      }
      ring[cursor] = line;
      cursor = (cursor + 1) % capacity;
      if (dirty) return;
      dirty = true;
      frame = window.requestAnimationFrame(flush);
      // Animation frames stop in hidden tabs. Keep only one timer outstanding.
      timeout = window.setTimeout(flush, 100);
    },
    flush,
    discard() {
      cancel();
      dirty = false;
      ring.length = 0;
      cursor = 0;
      lastStatus = undefined;
    },
  };
}
