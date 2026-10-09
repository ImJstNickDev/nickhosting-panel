import { statfs } from 'node:fs/promises';
import { fail } from './contracts.js';

export interface ContentDiskPolicy {
  minimumFreeBytes?: number;
  minimumFreePercent?: number;
}
/** Recheck before each file; this never deletes content or claims to reserve unrelated host capacity. */
export async function assertContentDiskSpace(
  directory: string,
  additionalBytes: number,
  policy: ContentDiskPolicy = {},
): Promise<void> {
  const minimumFreeBytes = policy.minimumFreeBytes ?? 512 * 1024 ** 2;
  const minimumFreePercent = policy.minimumFreePercent ?? 10;
  if (
    !Number.isSafeInteger(additionalBytes) ||
    additionalBytes < 0 ||
    !Number.isSafeInteger(minimumFreeBytes) ||
    minimumFreeBytes < 0 ||
    !Number.isFinite(minimumFreePercent) ||
    minimumFreePercent < 0 ||
    minimumFreePercent > 99
  )
    fail('disk_policy');
  const fs = await statfs(directory, { bigint: true });
  const available = fs.bavail * fs.bsize;
  const percentage = (fs.blocks * fs.bsize * BigInt(Math.ceil(minimumFreePercent * 100))) / 10000n;
  const requiredMargin =
    percentage > BigInt(minimumFreeBytes) ? percentage : BigInt(minimumFreeBytes);
  if (available < BigInt(additionalBytes) + requiredMargin) fail('stage_disk_capacity');
}
