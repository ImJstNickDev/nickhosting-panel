import { isDeepStrictEqual } from 'node:util';
import {
  type GatewayRoute,
  type GatewaySnapshot,
  gatewaySnapshotSchema,
} from '@nickhosting/game-sdk';

/** A positive protocol observation may advance state, never renew network authority. */
export function readinessReceipt(
  current: GatewaySnapshot,
  observed: GatewaySnapshot,
  input: unknown,
  serverId: string,
  now: number,
  maxClockSkewMs: number,
): GatewaySnapshot | undefined {
  const parsed = gatewaySnapshotSchema.safeParse(input);
  if (!parsed.success) return;
  const next = parsed.data;
  if (
    current.gatewayId !== observed.gatewayId ||
    next.gatewayId !== current.gatewayId ||
    current.revision !== observed.revision ||
    next.revision <= current.revision ||
    !isDeepStrictEqual(current.routes, observed.routes) ||
    Date.parse(current.expiresAt) <= now ||
    Date.parse(observed.expiresAt) <= now ||
    Date.parse(next.expiresAt) <= now ||
    Date.parse(next.issuedAt) > now + maxClockSkewMs ||
    Date.parse(next.issuedAt) < Date.parse(current.issuedAt) ||
    next.routes.length !== current.routes.length
  )
    return;
  let advanced = false;
  const identity = ({
    mode: _mode,
    revision: _revision,
    sleepEligibleAt: _sleep,
    ...route
  }: GatewayRoute) => route;
  for (const before of current.routes) {
    const after = next.routes.find((route) => route.id === before.id);
    if (!after) return;
    if (before.serverId !== serverId) {
      if (!isDeepStrictEqual(before, after)) return;
      continue;
    }
    if (
      before.mode !== 'waking' ||
      after.mode !== 'online' ||
      !before.wakeJobId ||
      after.revision <= before.revision ||
      !isDeepStrictEqual(identity(before), identity(after))
    )
      return;
    advanced = true;
  }
  if (!advanced || next.routes.some((route) => route.revision > next.revision)) return;
  return {
    ...next,
    expiresAt: new Date(
      Math.min(
        Date.parse(current.expiresAt),
        Date.parse(observed.expiresAt),
        Date.parse(next.expiresAt),
      ),
    ).toISOString(),
  };
}
