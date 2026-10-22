/** One lease across cards and detail previews: no background fleet of WebGL renderers. */
export function createPlayerBodyLease() {
  let current: (() => void) | undefined;
  return (cancel: () => void) => {
    current?.();
    current = cancel;
    return () => {
      if (current === cancel) current = undefined;
    };
  };
}

export const acquirePlayerBody = createPlayerBodyLease();

/** Radians, eased shoulder lift; deliberately independent of upstream WaveAnimation. */
export function playerWavePose(seconds: number) {
  const progress = Math.min(1, Math.max(0, seconds) / 0.35);
  const ease = progress * progress * (3 - 2 * progress);
  return {
    x: -0.25 * ease,
    z: -(2.35 + Math.sin(seconds * 8) * 0.28) * ease,
  };
}
