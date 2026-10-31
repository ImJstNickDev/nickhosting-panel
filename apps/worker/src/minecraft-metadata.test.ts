import { createLogger } from '@nickhosting/core';
import { getSettings } from '@nickhosting/database';
import {
  refreshFabricCatalog,
  refreshFoliaCatalog,
  refreshMinecraftMetadata,
  refreshNeoForgeCatalog,
  refreshPaperCatalog,
  refreshPurpurCatalog,
} from '@nickhosting/server-management';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  pollFabricMetadata,
  pollFoliaMetadata,
  pollMinecraftMetadata,
  pollNeoForgeMetadata,
  pollPaperMetadata,
  pollPurpurMetadata,
} from './minecraft-metadata.js';

vi.mock('@nickhosting/database', () => ({ getSettings: vi.fn() }));
vi.mock('@nickhosting/server-management', () => ({
  refreshMinecraftMetadata: vi.fn(),
  refreshFabricCatalog: vi.fn(),
  refreshFoliaCatalog: vi.fn(),
  refreshPaperCatalog: vi.fn(),
  refreshPurpurCatalog: vi.fn(),
  refreshNeoForgeCatalog: vi.fn(),
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
  vi.mocked(refreshPaperCatalog).mockResolvedValue({ state: 'skipped', changed: 0 });
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

it('keeps Paper discovery independent and reports only safe refresh outcomes', async () => {
  refresh.mockRejectedValue(new Error('unavailable'));
  vi.mocked(refreshPaperCatalog).mockResolvedValue({ state: 'updated', changed: 72 });
  await Promise.all([
    pollMinecraftMetadata(db, {}, logger),
    pollFabricMetadata(db, {}, logger),
    pollPaperMetadata(db, {}, logger),
  ]);
  expect(refreshPaperCatalog).toHaveBeenCalledWith(db, {
    userAgent: 'Fixture https://example.test',
  });
  expect(JSON.stringify(records)).toContain('paper.metadata_refreshed');
  records.length = 0;
  vi.mocked(refreshPaperCatalog).mockRejectedValue(new Error('secret://provider-detail'));
  await pollPaperMetadata(db, {}, logger);
  expect(JSON.stringify(records)).toContain('paper.metadata_refresh_unavailable');
  expect(JSON.stringify(records)).not.toContain('secret');
});

it('does not block Mojang or Fabric while Paper discovery is pending', async () => {
  let finish: (() => void) | undefined;
  vi.mocked(refreshPaperCatalog).mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { state: 'updated', changed: 1 };
  });
  refresh.mockResolvedValue({ state: 'skipped', changed: 0 });
  const paper = pollPaperMetadata(db, {}, logger);
  await Promise.all([pollMinecraftMetadata(db, {}, logger), pollFabricMetadata(db, {}, logger)]);
  expect(refresh).toHaveBeenCalledOnce();
  expect(refreshFabricCatalog).toHaveBeenCalledOnce();
  expect(refreshPaperCatalog).toHaveBeenCalledOnce();
  finish?.();
  await paper;
});

it('refreshes NeoForge independently and contains provider failures', async () => {
  refresh.mockRejectedValue(new Error('unavailable'));
  vi.mocked(refreshNeoForgeCatalog).mockResolvedValue({ state: 'updated', changed: 2 });
  await Promise.all([pollMinecraftMetadata(db, {}, logger), pollNeoForgeMetadata(db, {}, logger)]);
  expect(refreshNeoForgeCatalog).toHaveBeenCalledWith(db, {
    userAgent: 'Fixture https://example.test',
  });
  expect(JSON.stringify(records)).toContain('neoforge.metadata_refreshed');
  records.length = 0;
  vi.mocked(refreshNeoForgeCatalog).mockRejectedValue(new Error('secret://provider-detail'));
  await pollNeoForgeMetadata(db, {}, logger);
  expect(JSON.stringify(records)).toContain('neoforge.metadata_refresh_unavailable');
  expect(JSON.stringify(records)).not.toContain('secret');
});

it('refreshes Purpur independently and contains provider failures', async () => {
  refresh.mockRejectedValue(new Error('unavailable'));
  vi.mocked(refreshPurpurCatalog).mockResolvedValue({ state: 'updated', changed: 2 });
  await Promise.all([pollMinecraftMetadata(db, {}, logger), pollPurpurMetadata(db, {}, logger)]);
  expect(refreshPurpurCatalog).toHaveBeenCalledWith(db, {
    userAgent: 'Fixture https://example.test',
  });
  expect(JSON.stringify(records)).toContain('purpur.metadata_refreshed');
  records.length = 0;
  vi.mocked(refreshPurpurCatalog).mockRejectedValue(new Error('secret://provider-detail'));
  await pollPurpurMetadata(db, {}, logger);
  expect(JSON.stringify(records)).toContain('purpur.metadata_refresh_unavailable');
  expect(JSON.stringify(records)).not.toContain('secret');
});

it('refreshes Folia independently and contains provider failures', async () => {
  refresh.mockRejectedValue(new Error('unavailable'));
  vi.mocked(refreshFoliaCatalog).mockResolvedValue({ state: 'updated', changed: 2 });
  await Promise.all([pollMinecraftMetadata(db, {}, logger), pollFoliaMetadata(db, {}, logger)]);
  expect(refreshFoliaCatalog).toHaveBeenCalledWith(db, {
    userAgent: 'Fixture https://example.test',
  });
  expect(JSON.stringify(records)).toContain('folia.metadata_refreshed');
  records.length = 0;
  vi.mocked(refreshFoliaCatalog).mockRejectedValue(new Error('secret://provider-detail'));
  await pollFoliaMetadata(db, {}, logger);
  expect(JSON.stringify(records)).toContain('folia.metadata_refresh_unavailable');
  expect(JSON.stringify(records)).not.toContain('secret');
});
