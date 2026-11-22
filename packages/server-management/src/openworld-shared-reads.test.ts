import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { expect, it, vi } from 'vitest';
import { openworldRetryAfterMs, sharedReads } from './openworld-telemetry.js';

it('recovers at a short provider deadline even when another cache joins just before expiry', async () => {
  let time = 0;
  const now = () => time;
  const tokens = sharedReads<string>(1, now, 5_000);
  const maps = sharedReads<string>(1, now, 1_000);
  const issue = vi.fn(async () => 'new-token');
  const rateLimit = new PterodactylError('rate_limited', 'application', 'rejected', 429, 1_000);
  issue.mockRejectedValueOnce(rateLimit);
  const token = () => tokens.get('game', 60_000, issue);
  const map = () => maps.get('world', 15_000, token);
  const pending = token();
  expect(token()).toBe(pending);
  await expect(pending).rejects.toMatchObject({ reason: 'rate_limited' });

  time = 999;
  const cachedFailure = await map().catch((error: unknown) => error);
  if (!(cachedFailure instanceof PterodactylError)) throw new Error('expected provider throttle');
  expect(openworldRetryAfterMs(cachedFailure)).toBe(1);
  expect(issue).toHaveBeenCalledOnce();

  time = 1_000;
  expect(openworldRetryAfterMs(cachedFailure)).toBe(0);
  expect(await map()).toBe('new-token');
  expect(issue).toHaveBeenCalledTimes(2);
});

it.each([
  [undefined, 60_000],
  [NaN, 60_000],
  [-2, 60_000],
  [0, 0],
  [100, 100],
])(
  'respects valid remaining delays and defaults a missing or invalid value (%s ms)',
  (duration, expected) => {
    const throttle = new PterodactylError('rate_limited', 'application', 'rejected', 429, duration);
    expect(openworldRetryAfterMs(throttle)).toBe(expected);
  },
);
