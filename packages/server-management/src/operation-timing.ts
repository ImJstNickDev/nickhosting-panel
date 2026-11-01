import { createUploadTiming, type UploadTiming } from './upload-timing.js';

export interface OperationTiming extends UploadTiming {
  child(prefix: string): OperationTiming;
  report(): {
    totalMs: number;
    stages: ReturnType<UploadTiming['snapshot']>;
    spanGroups: { name: string; startMs: number; durationMs: number }[][];
    droppedSpans: number;
    /** Tracked distinct labels omitted from the 64-label aggregate. Beyond the
     * 128-label trace budget, each omitted observation counts in droppedSpans. */
    droppedStageLabels: number;
  };
}

const disabled: OperationTiming = {
  ...createUploadTiming(false),
  child: () => disabled,
  report: () => ({
    totalMs: 0,
    stages: {},
    spanGroups: [],
    droppedSpans: 0,
    droppedStageLabels: 0,
  }),
};
const round = (value: number) => Math.round(value * 1000) / 1000;
const valid = (name: string) => /^[a-z][a-zA-Z0-9_.]{0,63}$/.test(name);

/** One debug-only operation trace. Fixed code labels, never paths or values.
 * Children share aggregates and bounded spans so overlaps remain visible. */
export function createOperationTiming(
  enabled = true,
  clock: () => number = () => performance.now(),
): OperationTiming {
  if (!enabled) return disabled;
  let origin: number;
  try {
    origin = clock();
    if (!Number.isFinite(origin)) return disabled;
  } catch {
    return disabled;
  }
  let current = origin;
  // Reuse the exact start/end sample for aggregates; do not sample twice.
  const aggregate = createUploadTiming(true, () => current);
  const labels = new Set<string>();
  const spans: { name: string; startMs: number; durationMs: number }[] = [];
  let droppedSpans = 0;
  const sample = () => {
    try {
      const value = clock();
      if (Number.isFinite(value)) current = Math.max(current, value);
    } catch {
      // Broken diagnostics cannot alter the operation's result or original error.
    }
    return current;
  };
  function scope(prefix: string): OperationTiming {
    const start = (label: string) => {
      const name = prefix ? `${prefix}.${label}` : label;
      if (!valid(label) || !valid(name)) return () => {};
      if (!labels.has(name) && labels.size >= 128) {
        let stopped = false;
        return () => {
          if (!stopped) droppedSpans++;
          stopped = true;
        };
      }
      labels.add(name);
      const began = sample();
      const finish = aggregate.start(name);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        const ended = sample();
        finish();
        if (spans.length < 256)
          spans.push({ name, startMs: round(began - origin), durationMs: round(ended - began) });
        else droppedSpans++;
      };
    };
    return {
      start,
      async measure(name, work) {
        const finish = start(name);
        try {
          return await work();
        } finally {
          finish();
        }
      },
      measureSync(name, work) {
        const finish = start(name);
        try {
          return work();
        } finally {
          finish();
        }
      },
      snapshot: () => aggregate.snapshot(),
      child(name) {
        const nested = prefix ? `${prefix}.${name}` : name;
        return valid(name) && valid(nested) ? scope(nested) : disabled;
      },
      report: () => ({
        totalMs: round(sample() - origin),
        stages: aggregate.snapshot(),
        // Logger arrays cap at100. Each bounded group fits without truncation.
        spanGroups: Array.from({ length: Math.ceil(spans.length / 96) }, (_, index) =>
          spans.slice(index * 96, (index + 1) * 96).map((span) => ({ ...span })),
        ),
        droppedSpans,
        droppedStageLabels: Math.max(0, labels.size - 64),
      }),
    };
  }
  return scope('');
}
