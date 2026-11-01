import { type JobNotificationPool, listenForJobOutbox } from '@nickhosting/database';

type Service = {
  pending(limit: number): Promise<string[]>;
  process(id: string): Promise<'continue' | undefined>;
};
/** Durable rows are the queue. Notifications remove idle latency; the bounded
 * fallback also recovers missed notifications and expired worker leases. */
export function startMinecraftModpackLoop(options: {
  service(): Promise<Service | null>;
  notificationPool: JobNotificationPool;
  unavailable(): void;
  intervalMs?: number;
}) {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduledAt = Number.POSITIVE_INFINITY;
  let listener: Awaited<ReturnType<typeof listenForJobOutbox>> | undefined;
  let listening: Promise<void> | undefined;
  let running: Promise<void> | undefined;
  const processing = new Map<string, Promise<void>>();
  const cooldown = new Map<string, number>();
  let again = false;
  const listen = () => {
    if (listener || listening || closed) return;
    listening = listenForJobOutbox(options.notificationPool, wake, () => {
      listener = undefined;
      wake();
    })
      .then((value) => {
        if (closed) value.close();
        else listener = value;
      })
      .catch(() => {
        if (!closed) options.unavailable();
      })
      .finally(() => {
        listening = undefined;
      });
  };
  const schedule = (delay: number) => {
    if (closed) return;
    const due = Date.now() + delay;
    if (timer && scheduledAt <= due) return;
    if (timer) clearTimeout(timer);
    scheduledAt = due;
    timer = setTimeout(wake, delay);
    timer.unref?.();
  };
  const poll = async () => {
    listen();
    try {
      for (const [id, until] of cooldown) if (until <= Date.now()) cooldown.delete(id);
      if (processing.size >= 2) return;
      const service = await options.service();
      if (!service || closed) return;
      // Overscan cooled cleanup rows without increasing the two active slots.
      const ids = [...new Set(await service.pending(20))]
        .filter((id) => !processing.has(id) && !cooldown.has(id))
        .slice(0, 2 - processing.size);
      for (const id of ids) {
        if (closed) break;
        let continueQueuedApply = false;
        const work = Promise.resolve()
          .then(() => service.process(id))
          .then((result) => {
            continueQueuedApply = result === 'continue';
          })
          .catch(() => {
            cooldown.set(id, Date.now() + (options.intervalMs ?? 5000));
            options.unavailable();
          })
          .finally(() => {
            processing.delete(id);
            // Cleanup can retain a claim and return normally. Do not spin on
            // that same durable row when there has been no queue notification.
            if (continueQueuedApply) {
              cooldown.delete(id);
              schedule(0);
            } else {
              cooldown.set(id, Math.max(cooldown.get(id) ?? 0, Date.now() + 1000));
              schedule(1000);
            }
          });
        processing.set(id, work);
      }
    } catch {
      options.unavailable();
    }
  };
  function wake() {
    if (closed) return;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
      scheduledAt = Number.POSITIVE_INFINITY;
    }
    if (running) {
      again = true;
      return;
    }
    again = false;
    running = poll().finally(() => {
      running = undefined;
      const nearestRetry =
        processing.size >= 2
          ? Number.POSITIVE_INFINITY
          : Math.min(...cooldown.values()) - Date.now();
      schedule(again ? 0 : Math.max(0, Math.min(options.intervalMs ?? 5000, nearestRetry)));
    });
  }
  wake();
  return {
    wake,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      listener?.close();
      listener = undefined;
      await Promise.all([running, listening]);
      await Promise.all(processing.values());
    },
  };
}
