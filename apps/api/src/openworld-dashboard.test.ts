import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import type { Variables } from './app.js';
import { registerOpenworldDashboardRoutes } from './openworld-dashboard.js';

it('does not expose the native dashboard password', async () => {
  const app = new Hono<{ Variables: Variables }>();
  registerOpenworldDashboardRoutes(app, { db: {} as never, principal: vi.fn() }, vi.fn());
  expect(
    (await app.request('/v1/servers/fixture/openworld/dashboard/password', { method: 'POST' }))
      .status,
  ).toBe(404);
});
