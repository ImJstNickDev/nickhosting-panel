import { DomainError } from '@nickhosting/core';
import { ProviderRateLimitError } from '@nickhosting/external-services';

type Policy = { cacheSeconds: number; requestsPerMinute: number; concurrency: number };
type Budget = { requests: number[]; active: number; cooldownUntil: number; lastUsed: number };
/** One API process shares this bounded cache/budget across users and requests.
 * It is deliberately advisory: durable allocation and provider ownership checks
 * still decide creation. Other applications/API replicas consume their own quota. */
export function createDnsAvailabilityCache(clock: () => number = Date.now) {
  const cache = new Map<string, { value: boolean; expiresAt: number }>();
  const pending = new Map<string, Promise<boolean>>();
  const budgets = new Map<string, Budget>();
  const limited = (retryAfterMs: number) =>
    new DomainError('rate_limited', 429, { retryAfterMs: Math.max(1_000, retryAfterMs) });
  return async function lookup(
    scope: string,
    key: string,
    cost: number,
    policy: Policy,
    read: () => Promise<boolean>,
  ): Promise<boolean> {
    const now = clock(),
      cached = cache.get(key);
    if (policy.cacheSeconds > 0 && cached && cached.expiresAt > now) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.value;
    }
    cache.delete(key);
    const existing = pending.get(key);
    if (existing) return existing;
    let budget = budgets.get(scope);
    if (!budget) {
      if (budgets.size >= 64) {
        for (const [id, state] of budgets)
          if (!state.active && state.lastUsed + 60_000 <= now && state.cooldownUntil <= now)
            budgets.delete(id);
        if (budgets.size >= 64) throw limited(1_000);
      }
      budget = { requests: [], active: 0, cooldownUntil: 0, lastUsed: now };
      budgets.set(scope, budget);
    }
    budget.lastUsed = now;
    budget.requests = budget.requests.filter((at) => at + 60_000 > now);
    if (budget.cooldownUntil > now) throw limited(budget.cooldownUntil - now);
    if (budget.active >= policy.concurrency) throw limited(1_000);
    if (budget.requests.length + cost > policy.requestsPerMinute)
      throw limited((budget.requests[0] ?? now) + 60_000 - now);
    budget.requests.push(...Array.from({ length: cost }, () => now));
    budget.active++;
    const selected = budget;
    const result = Promise.resolve()
      .then(read)
      .then((value) => {
        if (policy.cacheSeconds > 0) {
          while (cache.size >= 512) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
          cache.set(key, { value, expiresAt: clock() + policy.cacheSeconds * 1000 });
        }
        return value;
      })
      .catch((error) => {
        if (error instanceof ProviderRateLimitError) {
          selected.cooldownUntil = Math.max(selected.cooldownUntil, clock() + error.retryAfterMs);
          throw limited(selected.cooldownUntil - clock());
        }
        throw error;
      })
      .finally(() => {
        selected.active--;
        pending.delete(key);
      });
    pending.set(key, result);
    return result;
  };
}
export const cachedDnsAvailability = createDnsAvailabilityCache();
