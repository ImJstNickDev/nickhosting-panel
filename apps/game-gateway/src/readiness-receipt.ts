import { isDeepStrictEqual } from 'node:util';
import {
  type GatewayRoute,
  type GatewaySnapshot,
  gatewaySnapshotSchema,
} from '@nickhosting/game-sdk';

/** Only the same wake operation may hand its local responder to an online route. */
export function isReadinessTransition(before: GatewayRoute, after: GatewayRoute): boolean {
  if (
    before.mode !== 'waking' ||
    after.mode !== 'online' ||
    !before.wakeJobId ||
    after.revision <= before.revision
  )
    return false;
  const identity = ({
    mode: _mode,
    revision: _revision,
    sleepEligibleAt: _sleep,
    ...route
  }: GatewayRoute) => route;
  const previous = identity(before);
  // Core removes the countdown when the same job becomes ready. Its removal
  // is part of this transition; every other presentation or policy edit still
  // requires ordinary validation.
  if (
    previous.presentation &&
    after.presentation &&
    after.presentation.startupBeganAt === undefined &&
    after.presentation.estimatedStartupSeconds === undefined
  ) {
    const {
      startupBeganAt: _began,
      estimatedStartupSeconds: _estimate,
      ...rest
    } = previous.presentation;
    previous.presentation = rest;
  }
  return isDeepStrictEqual(previous, identity(after));
}

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
  for (const before of current.routes) {
    const after = next.routes.find((route) => route.id === before.id);
    if (!after) return;
    if (before.serverId !== serverId) {
      if (!isDeepStrictEqual(before, after)) return;
      continue;
    }
    if (!isReadinessTransition(before, after)) return;
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
