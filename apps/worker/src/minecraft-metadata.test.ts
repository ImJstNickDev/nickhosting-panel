import { createLogger } from '@nickhosting/core';
import { getSettings } from '@nickhosting/database';
import { refreshMinecraftMetadata } from '@nickhosting/server-management';
import { beforeEach, expect, it, vi } from 'vitest';
import { pollMinecraftMetadata } from './minecraft-metadata.js';

vi.mock('@nickhosting/database', () => ({ getSettings: vi.fn() }));
vi.mock('@nickhosting/server-management', () => ({ refreshMinecraftMetadata: vi.fn() }));
const db = {} as Parameters<typeof pollMinecraftMetadata>[0];
const get = vi.mocked(getSettings);
const refresh = vi.mocked(refreshMinecraftMetadata);
const records: unknown[] = [];
const logger = createLogger((record) => {
  records.push(record);
});
beforeEach(() => {
  records.length = 0;
  vi.clearAllMocks();
  get.mockResolvedValue({
    values: { minecraftMetadataUserAgent: 'Fixture https://example.test' },
  } as Awaited<ReturnType<typeof getSettings>>);
});
it('uses resolved Owner/environment settings and does not log skipped checks', async () => {
  refresh.mockResolvedValue({ state: 'skipped', changed: 0 });
  const env = { NH_MINECRAFT_METADATA_USER_AGENT: 'Fixture https://example.test' };
  await pollMinecraftMetadata(db, env, logger);
  expect(get).toHaveBeenCalledWith(db, env);
  expect(refresh).toHaveBeenCalledWith(db, { userAgent: 'Fixture https://example.test' });
  expect(records).toHaveLength(0);
});
it('reports safe result counts for successful periodic refresh', async () => {
  refresh.mockResolvedValue({ state: 'updated', changed: 2 });
  await pollMinecraftMetadata(db, {}, logger);
  expect(records).toHaveLength(1);
  expect(JSON.stringify(records)).toContain('minecraft.metadata_refreshed');
});
it('contains failures without leaking request or database details into logs', async () => {
  refresh.mockRejectedValue(new Error('secret://do-not-log'));
  await pollMinecraftMetadata(db, {}, logger);
  expect(JSON.stringify(records)).toContain('minecraft.metadata_refresh_unavailable');
  expect(JSON.stringify(records)).not.toContain('secret');
});
