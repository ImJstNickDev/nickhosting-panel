/** Static captures run synchronously, only while no interactive preview owns the GPU. */
export function createPlayerBodyRendererQueue() {
  let current: (() => void) | undefined;
  const pending = new Set<() => void>();
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(drain, 0);
  };
  const drain = () => {
    scheduled = false;
    if (current) return;
    const next = pending.values().next().value;
    if (!next) return;
    pending.delete(next);
    next();
    schedule();
  };
  return {
    acquire(cancel: () => void) {
      current?.();
      current = cancel;
      return () => {
        if (current !== cancel) return;
        current = undefined;
        schedule();
      };
    },
    snapshot(capture: () => void) {
      pending.add(capture);
      schedule();
      return () => {
        pending.delete(capture);
      };
    },
  };
}

export const playerBodyRenderers = createPlayerBodyRendererQueue();

/** Radians, eased shoulder lift; deliberately independent of upstream WaveAnimation. */
export function playerWavePose(seconds: number) {
  const progress = Math.min(1, Math.max(0, seconds) / 0.35);
  const ease = progress * progress * (3 - 2 * progress);
  return {
    x: -0.25 * ease,
    z: -(2.35 + Math.sin(seconds * 8) * 0.28) * ease,
  };
}
