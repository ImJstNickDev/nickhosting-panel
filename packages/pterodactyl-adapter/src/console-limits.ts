import { DomainError } from '@nickhosting/core';
import { PterodactylError } from './transport.js';

interface Bucket {
  tokens: number;
  burst: number;
  refillMs: number;
  updatedAt: number;
}
export function encodeConsoleFrame(event: string, args: string[]): string {
  const wire = JSON.stringify({ event, args });
  // With permessage-deflate disabled this is also the exact wire payload.
  if (Buffer.byteLength(wire, 'utf8') > 4096) throw new DomainError('validation_failed');
  return wire;
}
/** Wings 1.13.4 limits, from the token-bucket constructors (not their comments).
 * Fail locally instead of queuing/replaying commands which may later be stale. */
export function createConsoleOutboundBudget(now = () => performance.now()) {
  const bucket = (burst: number, refillMs: number): Bucket => ({
    tokens: burst,
    burst,
    refillMs,
    updatedAt: now(),
  });
  const global = bucket(10, 200);
  const events = {
    auth: bucket(2, 5000),
    'send logs': bucket(2, 5000),
    'send command': bucket(10, 1000),
    other: bucket(4, 1000),
  };
  return (event: string, args: string[]) => {
    const wire = encodeConsoleFrame(event, args);
    const specific = events[event as keyof typeof events] ?? events.other;
    const timestamp = now();
    let retryAfterMs = 0;
    for (const budget of [global, specific]) {
      budget.tokens = Math.min(
        budget.burst,
        budget.tokens + Math.max(0, timestamp - budget.updatedAt) / budget.refillMs,
      );
      budget.updatedAt = timestamp;
      if (budget.tokens < 1)
        retryAfterMs = Math.max(retryAfterMs, Math.ceil((1 - budget.tokens) * budget.refillMs));
    }
    if (retryAfterMs > 0)
      throw new PterodactylError('rate_limited', 'client', 'rejected', undefined, retryAfterMs);
    global.tokens--;
    specific.tokens--;
    return wire;
  };
}
