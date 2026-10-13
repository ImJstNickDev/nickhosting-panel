import { DomainError } from '@nickhosting/core';

/** Wings disk=0 removes only the server quota; transfer and host budgets remain finite. */
export function serverStorageLimitBytes(diskMiB: number): number | null {
  const bytes = diskMiB * 1_048_576;
  if (!Number.isSafeInteger(diskMiB) || diskMiB < 0 || !Number.isSafeInteger(bytes))
    throw new DomainError('configuration_invalid');
  return diskMiB === 0 ? null : bytes;
}

export function assertServerStorageCapacity(diskMiB: number, requiredBytes: number): void {
  const limit = serverStorageLimitBytes(diskMiB);
  if (
    !Number.isSafeInteger(requiredBytes) ||
    requiredBytes < 0 ||
    (limit !== null && requiredBytes > limit)
  )
    throw new DomainError('resources_unavailable');
}
