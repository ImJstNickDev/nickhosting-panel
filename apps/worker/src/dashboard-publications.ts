import { type JobNotificationPool, listenForDashboardPublications } from '@nickhosting/database';

/** Commit-time hints handle ordinary toggles/renames. Durable due rows recover
 * a missed signal or a transient provider error after a worker restart. */
export function startDashboardPublicationLoop(
  pool: JobNotificationPool,
  reconcile: () => Promise<number>,
  failed: () => void,
) {
  let stopping = false,
    again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let listener: Awaited<ReturnType<typeof listenForDashboardPublications>> | undefined;
  async function run() {
    if (!listener) {
      try {
        listener = await listenForDashboardPublications(pool, wake, () => {
          listener = undefined;
          wake();
        });
      } catch {
        /* The next poll retries the connection. */
      }
    }
    if (stopping) return;
    try {
      if ((await reconcile()) === 8) again = true;
    } catch {
      failed();
    }
  }
  function wake() {
    if (stopping) return;
    if (pending) {
      again = true;
      return;
    }
    clearTimeout(timer);
    again = false;
    pending = run().finally(() => {
      pending = undefined;
      if (!stopping) timer = setTimeout(wake, again ? 100 : listener ? 30_000 : 5_000);
    });
  }
  wake();
  return {
    async close() {
      stopping = true;
      clearTimeout(timer);
      await pending;
      listener?.close();
    },
  };
}
