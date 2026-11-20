import { createLogger } from '@nickhosting/core';
import { getSettings, listenForMinecraftCatalogRequests } from '@nickhosting/database';
import {
  readMinecraftCatalogSchedule,
  refreshFabricCatalog,
  refreshMinecraftMetadata,
  refreshPaperCatalog,
} from '@nickhosting/server-management';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startMinecraftMetadataLoop } from './minecraft-metadata.js';

vi.mock('@nickhosting/database', () => ({
  getSettings: vi.fn(),
  listenForMinecraftCatalogRequests: vi.fn(),
}));
vi.mock('@nickhosting/server-management', () => ({
  readMinecraftCatalogSchedule: vi.fn(),
  refreshMinecraftMetadata: vi.fn(),
  refreshFabricCatalog: vi.fn(),
  refreshQuiltCatalog: vi.fn(),
  refreshFoliaCatalog: vi.fn(),
  refreshPaperCatalog: vi.fn(),
  refreshPurpurCatalog: vi.fn(),
  refreshForgeCatalog: vi.fn(),
  refreshNeoForgeCatalog: vi.fn(),
}));
const base = new Date('2026-01-01');
const row = (
  id: Awaited<ReturnType<typeof readMinecraftCatalogSchedule>>[number]['id'],
  delay: number,
  lease?: number,
) => ({
  id,
  next_check_at: new Date(base.getTime() + delay),
  lease_until: lease === undefined ? null : new Date(base.getTime() + lease),
});
const schedule = vi.mocked(readMinecraftCatalogSchedule);
const listen = vi.mocked(listenForMinecraftCatalogRequests);
const subscription = { close: vi.fn() };
const records: unknown[] = [];
const env = { NH_MINECRAFT_METADATA_USER_AGENT: 'Fixture https://example.test' };
const start = () =>
  startMinecraftMetadataLoop(
    {} as Parameters<typeof startMinecraftMetadataLoop>[0],
    {} as Parameters<typeof startMinecraftMetadataLoop>[1],
    env,
    createLogger((record) => records.push(record)),
  );
beforeEach(() => {
  records.length = 0;
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(base);
  listen.mockResolvedValue(subscription);
  vi.mocked(getSettings).mockResolvedValue({
    values: { contentMetadataUserAgent: env.NH_MINECRAFT_METADATA_USER_AGENT },
  } as Awaited<ReturnType<typeof getSettings>>);
});
afterEach(() => vi.useRealTimers());

it('checks only the schedule at rest, wakes at the earliest eligible deadline and drains notifications on close', async () => {
  schedule.mockResolvedValue([row('mojang', 120000), row('fabric', 1000, 4000)]);
  vi.mocked(refreshFabricCatalog).mockResolvedValue({ state: 'skipped', changed: 0 });
  const loop = start();
  await vi.advanceTimersByTimeAsync(3999);
  expect(schedule).toHaveBeenCalledOnce();
  expect(refreshFabricCatalog).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(refreshFabricCatalog).toHaveBeenCalledOnce();
  expect(refreshMinecraftMetadata).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(59999);
  expect(schedule).toHaveBeenCalledTimes(2);
  expect(getSettings).not.toHaveBeenCalled();
  expect(records).toEqual([]);
  await loop.close();
  listen.mock.calls[0]?.[1]();
  await vi.advanceTimersByTimeAsync(60000);
  expect(schedule).toHaveBeenCalledTimes(2);
  expect(subscription.close).toHaveBeenCalledOnce();
});

it('rechecks a committed manual request immediately and retries after a listener disconnect', async () => {
  schedule.mockResolvedValue([row('mojang', 100000)]);
  vi.mocked(refreshFabricCatalog).mockResolvedValue({ state: 'updated', changed: 2 });
  const loop = start();
  await vi.advanceTimersByTimeAsync(1);
  schedule.mockResolvedValue([row('mojang', 100000), row('fabric', 1)]);
  listen.mock.calls[0]?.[1]();
  await vi.advanceTimersByTimeAsync(0);
  expect(refreshFabricCatalog).toHaveBeenCalledOnce();
  expect(JSON.stringify(records)).toContain('fabric.metadata_refreshed');
  listen.mockRejectedValueOnce(new Error('listener unavailable'));
  schedule.mockResolvedValue([row('mojang', 100000)]);
  listen.mock.calls[0]?.[2]();
  await vi.advanceTimersByTimeAsync(1);
  expect(listen).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(listen).toHaveBeenCalledTimes(3);
  await loop.close();
});

it('bootstraps missing Mojang, shares settings among winners and continues other providers during a slow refresh', async () => {
  const fabric = Promise.withResolvers<{ state: 'updated'; changed: number }>();
  schedule
    .mockResolvedValueOnce([row('fabric', 0)])
    .mockResolvedValue([row('mojang', 100000), row('fabric', 0), row('paper', 0)]);
  vi.mocked(refreshFabricCatalog).mockImplementation(async (_db, options) => {
    expect(await options.loadUserAgent?.()).toBe(env.NH_MINECRAFT_METADATA_USER_AGENT);
    return fabric.promise;
  });
  vi.mocked(refreshMinecraftMetadata).mockImplementation(async (_db, options) => {
    expect(await options.loadUserAgent?.()).toBe(env.NH_MINECRAFT_METADATA_USER_AGENT);
    return { state: 'unchanged', changed: 0 };
  });
  vi.mocked(refreshPaperCatalog).mockRejectedValue(new Error('secret://fixture'));
  const loop = start();
  await vi.advanceTimersByTimeAsync(0);
  expect(getSettings).toHaveBeenCalledOnce();
  listen.mock.calls[0]?.[1]();
  await vi.advanceTimersByTimeAsync(0);
  expect(refreshFabricCatalog).toHaveBeenCalledOnce();
  expect(refreshPaperCatalog).toHaveBeenCalledOnce();
  expect(JSON.stringify(records)).toContain('paper.metadata_refresh_unavailable');
  expect(JSON.stringify(records)).not.toContain('secret://fixture');
  let closed = false;
  const closing = loop.close().then(() => {
    closed = true;
  });
  await vi.advanceTimersByTimeAsync(100000);
  expect(closed).toBe(false);
  fabric.resolve({ state: 'updated', changed: 2 });
  await closing;
});
