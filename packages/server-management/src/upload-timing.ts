export interface UploadTiming {
  measure<T>(name: string, work: () => Promise<T>): Promise<T>;
  measureSync<T>(name: string, work: () => T): T;
  start(name: string): () => void;
  snapshot(): Record<string, { count: number; totalMs: number; maxMs: number }>;
}

const disabled: UploadTiming = {
  measure: (_name, work) => work(),
  measureSync: (_name, work) => work(),
  start: () => () => {},
  snapshot: () => ({}),
};

/** Request-local aggregate timings, never SQL, parameters, values or errors.
 * Callers supply code-defined labels only. Invalid/excess labels are ignored so
 * diagnostics cannot reject application work or allocate an unbounded key set. */
export function createUploadTiming(
  enabled = true,
  clock: () => number = () => performance.now(),
): UploadTiming {
  if (!enabled) return disabled;
  const entries = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  const start = (name: string) => {
    let started: number;
    let entry: { count: number; totalMs: number; maxMs: number };
    try {
      if (!/^[a-z][a-zA-Z0-9_.]{0,63}$/.test(name)) return () => {};
      const existing = entries.get(name);
      if (!existing && entries.size >= 64) return () => {};
      started = clock();
      if (!Number.isFinite(started)) return () => {};
      entry = existing ?? { count: 0, totalMs: 0, maxMs: 0 };
      if (!existing) entries.set(name, entry);
    } catch {
      return () => {};
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      try {
        const elapsed = Math.max(0, clock() - started);
        if (!Number.isFinite(elapsed)) return;
        entry.count++;
        entry.totalMs += elapsed;
        entry.maxMs = Math.max(entry.maxMs, elapsed);
      } catch {
        // Instrumentation must never replace the work's original error/result.
      }
    };
  };
  return {
    start,
    async measure(name, work) {
      const stop = start(name);
      try {
        return await work();
      } finally {
        stop();
      }
    },
    measureSync(name, work) {
      const stop = start(name);
      try {
        return work();
      } finally {
        stop();
      }
    },
    snapshot() {
      return Object.fromEntries(
        [...entries]
          .filter(([, entry]) => entry.count > 0)
          .map(([name, entry]) => [
            name,
            {
              count: entry.count,
              totalMs: Math.round(entry.totalMs * 1000) / 1000,
              maxMs: Math.round(entry.maxMs * 1000) / 1000,
            },
          ]),
      );
    },
  };
}
