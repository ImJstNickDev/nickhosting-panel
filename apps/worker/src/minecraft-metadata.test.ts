import { createLogger } from '@nickhosting/core';
import { getSettings } from '@nickhosting/database';
import { refreshFabricCatalog, refreshMinecraftMetadata } from '@nickhosting/server-management';
import { beforeEach, expect, it, vi } from 'vitest';
import { pollFabricMetadata, pollMinecraftMetadata } from './minecraft-metadata.js';

vi.mock('@nickhosting/database', () => ({ getSettings: vi.fn() }));
vi.mock('@nickhosting/server-management', () => ({
  refreshMinecraftMetadata: vi.fn(),
  refreshFabricCatalog: vi.fn(),
}));
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
  vi.mocked(refreshFabricCatalog).mockResolvedValue({ state: 'skipped', changed: 0 });
  get.mockResolvedValue({
    values: { contentMetadataUserAgent: 'Fixture https://example.test' },
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

it('refreshes Fabric independently even when Mojang fails', async () => {
  refresh.mockRejectedValue(new Error('unavailable'));
  vi.mocked(refreshFabricCatalog).mockResolvedValue({ state: 'updated', changed: 3 });
  await Promise.all([pollMinecraftMetadata(db, {}, logger), pollFabricMetadata(db, {}, logger)]);
  expect(refreshFabricCatalog).toHaveBeenCalledWith(db, {
    userAgent: 'Fixture https://example.test',
  });
  expect(JSON.stringify(records)).toContain('fabric.metadata_refreshed');
});

it('lets Mojang poll again while Fabric remains in progress', async () => {
  let finish: (() => void) | undefined;
  vi.mocked(refreshFabricCatalog).mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { state: 'updated', changed: 1 };
  });
  refresh.mockResolvedValue({ state: 'skipped', changed: 0 });
  const fabric = pollFabricMetadata(db, {}, logger);
  await pollMinecraftMetadata(db, {}, logger);
  await pollMinecraftMetadata(db, {}, logger);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(refreshFabricCatalog).toHaveBeenCalledTimes(1);
  finish?.();
  await fabric;
});
