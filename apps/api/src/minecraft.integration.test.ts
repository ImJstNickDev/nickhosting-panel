import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ManagementRuntime } from '@nickhosting/server-management';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerMinecraftRoutes } from './minecraft.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let fixture: Awaited<ReturnType<typeof managementFixture>>;
let app: Hono<{ Variables: Variables }>;
let actor: Awaited<ReturnType<typeof managementFixture>>['context'];
const management = vi.fn<() => Promise<ManagementRuntime>>();
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  fixture = await managementFixture(database.db, { interactive: true });
  actor = fixture.context;
  management.mockReset().mockRejectedValue(new DomainError('integration_unavailable'));
  app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    c.json(
      { code: error instanceof DomainError ? error.code : 'internal_error' },
      error instanceof DomainError ? (error.status as 400) : 500,
    ),
  );
  registerMinecraftRoutes(app, {
    db: fixture.db,
    env: {},
    principal: async () => actor,
    body: async (c) => c.req.json(),
    management,
  });
});
describe('Minecraft backend API authorization and user projection', () => {
  it('rejects user access to every technical compatibility administration route', async () => {
    const id = randomUUID();
    for (const [method, path] of [
      ['GET', '/v1/owner/minecraft/manifest'],
      ['GET', '/v1/owner/minecraft/compatibility'],
      ['POST', '/v1/owner/minecraft/compatibility'],
      ['POST', `/v1/owner/minecraft/compatibility/${id}/evidence`],
      ['PUT', `/v1/owner/minecraft/compatibility/${id}/availability`],
    ] as const) {
      const result = await app.request(path, {
        method,
        ...(method !== 'GET' ? { body: '{}' } : {}),
      });
      expect(result.status).toBe(403);
    }
    expect(management).not.toHaveBeenCalled();
  });
  it('returns only the simple four-step wizard when no verified release is available', async () => {
    const choices = await app.request('/v1/minecraft/choices');
    expect(await choices.json()).toEqual([]);
    const response = await app.request('/v1/minecraft/wizard');
    const wizard = await response.json();
    expect(wizard.choices).toEqual([]);
    expect(wizard.steps.map((step: { id: string }) => step.id)).toEqual([
      'choose-game',
      'configure',
      'resources',
      'create',
    ]);
    expect(JSON.stringify(wizard)).not.toMatch(/protocolId|experimental|compatibility/);
    expect(management).not.toHaveBeenCalled();
  });
  it('checks server ownership before world, content, wipe and reinstall provider access', async () => {
    const serverId = await fixture.server();
    actor = (await managementFixture(database.db, { interactive: true })).context;
    for (const [method, suffix] of [
      ['GET', ''],
      ['GET', '/worlds'],
      ['GET', '/wipe-preview'],
      ['POST', '/operations'],
    ] as const) {
      const response = await app.request(`/v1/servers/${serverId}/minecraft${suffix}`, {
        method,
        ...(method === 'POST'
          ? {
              body: JSON.stringify({ action: 'wipe', idempotencyKey: randomUUID(), confirm: true }),
            }
          : {}),
      });
      expect(response.status).toBe(403);
    }
    expect(management).not.toHaveBeenCalled();
  });
  it('never accepts arbitrary wizard runtime or file path assertions', async () => {
    const response = await app.request('/v1/minecraft/wizard', {
      method: 'POST',
      body: JSON.stringify({ sourceId: randomUUID(), release: '26.1', path: '/tmp/untrusted.zip' }),
    });
    expect(response.status).toBe(400);
    expect(management).not.toHaveBeenCalled();
  });
  it('rejects create without a gated Minecraft choice before acquiring content', async () => {
    const response = await app.request('/v1/minecraft/servers', {
      method: 'POST',
      body: JSON.stringify({
        mappingId: fixture.mappingId,
        name: 'test',
        limits: { memory: 1024, cpu: 100, disk: 1024 },
        idempotencyKey: randomUUID(),
      }),
    });
    expect(response.status).toBe(400);
    expect(management).not.toHaveBeenCalled();
  });
});
