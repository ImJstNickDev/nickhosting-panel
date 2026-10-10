import { DomainError } from '@nickhosting/core';
import {
  createSchedule,
  deleteSchedule,
  getAutomationConsent,
  listScheduleOutcomes,
  listSchedules,
  setAutomationConsent,
  updateSchedule,
} from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import type { Variables } from './app.js';
import type { ServerRouteOptions } from './servers.js';

async function body(c: Context<{ Variables: Variables }>) {
  if (!c.req.header('content-type')?.startsWith('application/json'))
    throw new DomainError('validation_failed');
  try {
    return await c.req.json();
  } catch {
    throw new DomainError('validation_failed');
  }
}

export function registerScheduleRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Omit<ServerRouteOptions, 'acquireUploadSlot'>,
) {
  const { db, env, principal } = options;
  app.get('/v1/servers/:id/automation-consent', async (c) =>
    c.json(await getAutomationConsent(db, await principal(c), c.req.param('id'))),
  );
  app.put('/v1/servers/:id/automation-consent', async (c) =>
    c.json(
      await setAutomationConsent(
        db,
        await principal(c, true),
        c.req.param('id'),
        await body(c),
        env,
      ),
    ),
  );
  app.get('/v1/servers/:id/schedules', async (c) =>
    c.json(await listSchedules(db, await principal(c), c.req.param('id'))),
  );
  app.post('/v1/servers/:id/schedules', async (c) =>
    c.json(
      await createSchedule(db, await principal(c, true), c.req.param('id'), await body(c), env),
      201,
    ),
  );
  app.put('/v1/servers/:id/schedules/:scheduleId', async (c) =>
    c.json(
      await updateSchedule(
        db,
        await principal(c, true),
        c.req.param('id'),
        c.req.param('scheduleId'),
        await body(c),
        env,
      ),
    ),
  );
  app.delete('/v1/servers/:id/schedules/:scheduleId', async (c) => {
    await deleteSchedule(
      db,
      await principal(c, true),
      c.req.param('id'),
      c.req.param('scheduleId'),
      await body(c),
      env,
    );
    return c.body(null, 204);
  });
  app.get('/v1/servers/:id/schedules/:scheduleId/outcomes', async (c) =>
    c.json(
      await listScheduleOutcomes(
        db,
        await principal(c),
        c.req.param('id'),
        c.req.param('scheduleId'),
        c.req.query(),
      ),
    ),
  );
}
