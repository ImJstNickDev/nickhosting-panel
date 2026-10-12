// Scheduling, not bandwidth throttling: keep one large transfer progressing
// while the remaining slots drain small files. XHR cannot promise byte shares.
export const largeUploadBytes = 16 * 1024 ** 2;
export type SizedUpload = { file: { size: number }; path: string };

export function nextUpload<T extends SizedUpload>(
  pending: readonly T[],
  active: readonly T[],
): T | undefined {
  const large = pending.filter((item) => item.file.size >= largeUploadBytes);
  const small = pending.filter((item) => item.file.size < largeUploadBytes);
  if (!large.length && !active.some((item) => item.file.size >= largeUploadBytes))
    return pending[0];
  const candidates =
    active.some((item) => item.file.size >= largeUploadBytes) && small.length
      ? small
      : large.length
        ? large
        : small;
  const smallest = candidates === small;
  return candidates.reduce<T | undefined>(
    (selected, item) =>
      !selected ||
      (smallest ? item.file.size < selected.file.size : item.file.size > selected.file.size)
        ? item
        : selected,
    undefined,
  );
}

/** Disjoint paths only; later duplicates wait for the preceding batch to settle. */
export function planUploadBatch<T extends SizedUpload>(
  pending: readonly T[],
  maxBytes: number,
  maxFiles: number,
): T[] {
  const remaining = [...pending],
    selected: T[] = [];
  let bytes = 0;
  while (remaining.length && selected.length < maxFiles) {
    const item = nextUpload(remaining, selected);
    if (!item) break;
    remaining.splice(remaining.indexOf(item), 1);
    if (
      item.file.size > maxBytes - bytes ||
      selected.some(
        (other) =>
          item.path.toLowerCase() === other.path.toLowerCase() ||
          item.path.toLowerCase().startsWith(`${other.path.toLowerCase()}/`) ||
          other.path.toLowerCase().startsWith(`${item.path.toLowerCase()}/`),
      )
    )
      continue;
    selected.push(item);
    bytes += item.file.size;
  }
  return selected;
}

/** Refill immediately after each completion, rather than waiting for a group. */
export async function runUploadPool<T>(options: {
  concurrency: number;
  next(active: readonly T[]): T | undefined;
  run(item: T): Promise<void>;
}): Promise<void> {
  const active = new Map<T, Promise<void>>();
  const concurrency = Math.max(1, Math.min(6, Math.trunc(options.concurrency)));
  try {
    while (true) {
      while (active.size < concurrency) {
        const item = options.next([...active.keys()]);
        if (!item) break;
        const work = Promise.resolve()
          .then(() => options.run(item))
          .finally(() => active.delete(item));
        active.set(item, work);
      }
      if (!active.size) return;
      await Promise.race(active.values());
    }
  } finally {
    await Promise.allSettled(active.values());
  }
}
