import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { expect, it, vi } from 'vitest';
import { withProviderReadCaller } from '../../pterodactyl-adapter/src/provider-read-attribution.js';
import {
  createTransport,
  createTransportCoordinator,
} from '../../pterodactyl-adapter/src/transport.js';
import { createProviderRequestBudget } from './provider-request-budget.js';

it('reserves interactive capacity and shares Retry-After across replicas and platform key rotation', async () => {
  const redisUrl = process.env.NH_TEST_REDIS_URL;
  if (
    !redisUrl ||
    !['127.0.0.1', 'localhost', '[::1]', process.env.NH_TEST_VERIFIED_REDIS_HOST].includes(
      new URL(redisUrl).hostname,
    )
  )
    throw new Error('Only verified isolated Redis is permitted');
  const prefix = `provider-${randomUUID()}`;
  const baseURL = 'https://budget-fixture.test/';
  const peerURL = 'https://another-fixture.test/';
  const api = createProviderRequestBudget(redisUrl, prefix);
  const worker = createProviderRequestBudget(redisUrl, prefix);
  const raw = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  const success = () => new Response(null, { status: 204, headers: { 'X-RateLimit-Limit': '5' } });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => success());
  const configured = {
    baseURL,
    fetcher,
    applicationKey: 'test-key-a',
    clientKey: 'separate-client-key',
  };
  const http = createTransport({
    ...configured,
    coordinator: createTransportCoordinator('api', api),
  });
  const observer = createTransport({
    ...configured,
    applicationKey: 'test-key-b',
    coordinator: createTransportCoordinator('worker', worker),
  });
  try {
    await http.empty('application', 'servers', 'GET');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        withProviderReadCaller('worker-reconcile', () =>
          observer.empty('application', 'nodes', 'GET'),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(4);
    await http.empty('application', 'servers/1', 'GET');
    // A full window retains the newest foreground calls when no background
    // capacity remains. Aging out the oldest calls must not reopen quota early.
    const binding = createHash('sha256').update(baseURL).digest('hex');
    const windowKey = `${prefix}:provider-budget:{${binding}}:window`;
    const prior = await raw.zrange(windowKey, 0, '-1');
    expect(prior).toHaveLength(5);
    for (const member of prior) await raw.zadd(windowKey, Date.now() - 55000, member);
    for (let index = 0; index < 5; index++) await http.empty('application', 'servers/1', 'GET');
    const latest = await raw.zrange(windowKey, 0, '-1');
    expect(latest).toHaveLength(5);
    expect(latest.every((member) => !prior.includes(member))).toBe(true);
    await expect(
      withProviderReadCaller('worker-reconcile', () =>
        observer.empty('application', 'nodes', 'GET'),
      ),
    ).rejects.toMatchObject({ reason: 'rate_limited' });
    fetcher.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { 'Retry-After': '12' } }),
    );
    await expect(http.empty('application', 'servers/1', 'PATCH', {})).rejects.toMatchObject({
      reason: 'rate_limited',
      outcome: 'rejected',
    });
    const before = fetcher.mock.calls.length;
    await expect(observer.empty('application', 'servers/1', 'PATCH', {})).rejects.toMatchObject({
      reason: 'rate_limited',
      outcome: 'rejected',
    });
    expect(fetcher).toHaveBeenCalledTimes(before);
    await observer.empty('client', 'servers/one/resources', 'GET');
    await createTransport({
      ...configured,
      baseURL: peerURL,
      coordinator: createTransportCoordinator('api', api),
    }).empty('application', 'nodes', 'GET');
    expect(fetcher).toHaveBeenCalledTimes(before + 2);
  } finally {
    api.close();
    worker.close();
    const keys = [baseURL, peerURL].flatMap((origin) => {
      const binding = createHash('sha256').update(origin).digest('hex');
      return ['window', 'limit', 'cooldown'].map(
        (name) => `${prefix}:provider-budget:{${binding}}:${name}`,
      );
    });
    try {
      await raw.del(...keys);
    } finally {
      raw.disconnect();
    }
  }
});
