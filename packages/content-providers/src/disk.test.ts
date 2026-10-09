import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ statfs: vi.fn() }));
vi.mock('node:fs/promises', () => ({ statfs: mocks.statfs }));

import { assertContentDiskSpace } from './disk.js';

beforeEach(() => mocks.statfs.mockReset());
it('retains the larger of fixed or percentage disk margins', async () => {
  mocks.statfs.mockResolvedValue({ bsize: 1n, blocks: 10000n, bavail: 1200n });
  await expect(
    assertContentDiskSpace('/staging', 201, { minimumFreeBytes: 500, minimumFreePercent: 10 }),
  ).rejects.toThrow();
  await expect(
    assertContentDiskSpace('/staging', 200, { minimumFreeBytes: 500, minimumFreePercent: 10 }),
  ).resolves.toBeUndefined();
});
it('uses unprivileged available blocks rather than privileged free space', async () => {
  mocks.statfs.mockResolvedValue({ bsize: 1024n, blocks: 10000n, bfree: 5000n, bavail: 10n });
  await expect(
    assertContentDiskSpace('/staging', 1000, { minimumFreeBytes: 10240, minimumFreePercent: 0 }),
  ).rejects.toThrow();
});
it('refuses invalid configurable safety policies', async () => {
  await expect(assertContentDiskSpace('/staging', -1)).rejects.toThrow();
  await expect(
    assertContentDiskSpace('/staging', 0, { minimumFreePercent: 100 }),
  ).rejects.toThrow();
  expect(mocks.statfs).not.toHaveBeenCalled();
});
