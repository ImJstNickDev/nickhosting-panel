/** Independent from provider reconciliation; never overlap ticks or outlive shutdown. */
export function startHostObservationLoop(refresh: () => Promise<void>, failed: () => void) {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void>;
  const tick = async () => {
    const started = performance.now();
    try {
      await refresh();
    } catch {
      try {
        failed();
      } catch {
        // Diagnostics must not terminate observation scheduling.
      }
    } finally {
      if (!closed)
        timer = setTimeout(
          () => {
            pending = tick();
          },
          Math.max(1, 1000 - (performance.now() - started)),
        );
    }
  };
  pending = tick();
  return {
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      await pending;
    },
  };
}
