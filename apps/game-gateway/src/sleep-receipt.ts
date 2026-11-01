import { isDeepStrictEqual } from 'node:util';
import {
  type GatewayRoute,
  type GatewaySnapshot,
  gatewaySnapshotSchema,
} from '@nickhosting/game-sdk';

export interface SleepFence {
  deadline: number;
  observedAt: number;
  generation: string;
  routes: GatewayRoute[];
}

/** Authenticated durable stop receipt may release this fence, never renew topology.
 * Unlike a pre-fetched snapshot, the completion endpoint waits for this exact proof. */
export function sleepReceipt(
  current: GatewaySnapshot,
  input: unknown,
  serverId: string,
  fence: SleepFence,
  now: number,
  maxClockSkewMs: number,
): GatewaySnapshot | undefined {
  const parsed = gatewaySnapshotSchema.safeParse(input);
  if (!parsed.success) return;
  const next = parsed.data;
  if (
    next.gatewayId !== current.gatewayId ||
    next.revision <= current.revision ||
    next.routes.length !== current.routes.length ||
    Date.parse(current.expiresAt) <= now ||
    Date.parse(next.expiresAt) <= now ||
    fence.deadline <= now ||
    Date.parse(next.issuedAt) < Date.parse(current.issuedAt) ||
    Date.parse(next.issuedAt) > now + maxClockSkewMs
  )
    return;
  const identity = ({
    mode: _mode,
    revision: _revision,
    wakeJobId: _wake,
    completedSleep: _completion,
    sleepEligibleAt: _idle,
    ...route
  }: GatewayRoute) => route;
  const members = current.routes.filter((route) => route.serverId === serverId);
  if (!members.length || members.length !== fence.routes.length) return;
  const completion = next.routes.find((route) => route.serverId === serverId)?.completedSleep;
  if (
    !completion ||
    completion.generation !== fence.generation ||
    Date.parse(completion.quiescenceUntil) !== fence.deadline ||
    Date.parse(completion.completedAt) < fence.observedAt ||
    Date.parse(completion.completedAt) > Date.parse(next.issuedAt)
  )
    return;
  for (const before of current.routes) {
    const after = next.routes.find((route) => route.id === before.id);
    if (!after || after.revision > next.revision) return;
    if (before.serverId !== serverId) {
      if (!isDeepStrictEqual(before, after)) return;
      continue;
    }
    const original = fence.routes.find((route) => route.id === before.id);
    if (
      !original ||
      !['online', 'blocked'].includes(before.mode) ||
      before.generation !== fence.generation ||
      after.generation !== fence.generation ||
      after.mode !== 'sleeping' ||
      after.wakeJobId !== undefined ||
      after.revision <= before.revision ||
      before.revision < original.revision ||
      !isDeepStrictEqual(identity(before), identity(original)) ||
      !isDeepStrictEqual(identity(before), identity(after)) ||
      !isDeepStrictEqual(after.completedSleep, completion)
    )
      return;
  }
  return {
    ...next,
    expiresAt: new Date(
      Math.min(Date.parse(current.expiresAt), Date.parse(next.expiresAt), fence.deadline),
    ).toISOString(),
  };
}
