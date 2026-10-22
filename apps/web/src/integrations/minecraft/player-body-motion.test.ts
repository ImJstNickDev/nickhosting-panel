import { describe, expect, it, vi } from 'vitest';
import { createPlayerBodyLease, playerWavePose } from './player-body-motion.js';

describe('decorative player preview resource boundaries', () => {
  it('revokes the previous preview and ignores a stale release', () => {
    const acquire = createPlayerBodyLease();
    const first = vi.fn(),
      second = vi.fn(),
      third = vi.fn();
    const releaseFirst = acquire(first);
    const releaseSecond = acquire(second);
    expect(first).toHaveBeenCalledOnce();
    releaseFirst();
    acquire(third);
    expect(second).toHaveBeenCalledOnce();
    releaseSecond();
    expect(third).not.toHaveBeenCalled();
  });
  it('does not revoke a preview after its lease has been released', () => {
    const acquire = createPlayerBodyLease();
    const cancel = vi.fn();
    acquire(cancel)();
    acquire(vi.fn());
    expect(cancel).not.toHaveBeenCalled();
  });
  it('starts naturally at rest and keeps shoulder angles within radians', () => {
    expect(playerWavePose(0)).toEqual({ x: -0, z: -0 });
    expect(Math.abs(playerWavePose(0.1).z)).toBeLessThan(Math.abs(playerWavePose(0.35).z));
    for (let seconds = 0; seconds < 30; seconds += 0.05) {
      const pose = playerWavePose(seconds);
      expect(pose.x).toBeGreaterThanOrEqual(-0.25);
      expect(pose.z).toBeLessThanOrEqual(0);
      expect(pose.z).toBeGreaterThan(-Math.PI);
    }
  });
});
