/** A prepared observation may paint while the authoritative read is pending.
 * Once either read fails, or the final data arrives, no late preview may publish. */
export async function readSectionWithPreview<T>(
  signal: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>,
  preview: (signal: AbortSignal) => Promise<T | null>,
  publish: (value: T | null) => void,
): Promise<T> {
  signal.throwIfAborted();
  const finished = new AbortController();
  const lifetime = AbortSignal.any([signal, finished.signal]);
  const current = read(lifetime);
  try {
    const observed = preview(lifetime).then((value) => {
      lifetime.throwIfAborted();
      publish(value);
      return current;
    });
    return await Promise.race([current, observed]);
  } finally {
    finished.abort();
  }
}
