import { DomainError } from '@nickhosting/core';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import type { Variables } from './app.js';
import { registerOpenworldDashboardRoutes } from './openworld-dashboard.js';

it('returns a rate limit with its retry delay without repeating a rejected dashboard request', async () => {
  const app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) => {
    if (!(error instanceof DomainError)) throw error;
    return c.json({ code: error.code }, 429);
  });
  const management = vi.fn(async () => {
    throw new PterodactylError('rate_limited', 'application', 'rejected', 429, 2450);
  });
  registerOpenworldDashboardRoutes(app, { db: {} as never, principal: vi.fn(), management });
  const response = await app.request('/v1/servers/fixture/openworld/dashboard/status');
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('3');
  expect(await response.json()).toEqual({ code: 'rate_limited' });
  expect(management).toHaveBeenCalledTimes(1);
});

it('does not expose the native dashboard password', async () => {
  const app = new Hono<{ Variables: Variables }>();
  registerOpenworldDashboardRoutes(app, { db: {} as never, principal: vi.fn() });
  expect(
    (await app.request('/v1/servers/fixture/openworld/dashboard/password', { method: 'POST' }))
      .status,
  ).toBe(404);
});
