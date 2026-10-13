import { api } from '../api/client.js';

export type StorageMode = 'GLOBAL_POOL' | 'PER_USER_BUDGET';
export interface StoragePolicyServer {
  serverId: string;
  name: string;
  usageBytes: number | null;
  observedAt: string | null;
  currentDiskMiB: number;
  minimumDiskMiB: number | null;
  proposedDiskMiB: number | null;
  backupSlots: number;
  status: 'pending' | 'applied' | 'blocked';
  errorCode: string | null;
}
export interface StoragePolicyUser {
  userId: string;
  name: string;
  quotaMiB: number;
  quotaSource?: 'default' | 'override';
  requiredMiB: number | null;
  servers: StoragePolicyServer[];
}
export interface StorageTransition {
  id: string;
  status: 'draft' | 'applying' | 'blocked' | 'completed' | 'superseded';
  policy: StorageMode;
  previousPolicy: StorageMode;
  defaultUserStorageMiB: number;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
  users: StoragePolicyUser[];
}
export interface StoragePolicyStatus {
  policy: StorageMode;
  defaultUserStorageMiB: number;
  lockedKeys: string[];
  transition: StorageTransition | null;
}
export interface StorageAllocation {
  userId: string;
  quotaMiB: number;
  servers: Array<{ serverId: string; diskMiB: number }>;
}

const root = '/v1/owner/storage-policy';
// Preview writes a durable draft. Aborting a fetch cannot undo that write, so
// serialize mutations even across a settings-page unmount/remount.
let mutationQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation);
  mutationQueue = result.catch(() => undefined);
  return result;
}
export const storagePolicyApi = {
  status: (signal?: AbortSignal) => api<StoragePolicyStatus>(root, { signal }),
  preview: (policy: StorageMode, defaultUserStorageMiB: number) =>
    serialized(() =>
      api<StorageTransition>(`${root}/preview`, { body: { policy, defaultUserStorageMiB } }),
    ),
  apply: (id: string, users: StorageAllocation[]) =>
    serialized(() =>
      api<StorageTransition>(`${root}/${encodeURIComponent(id)}/apply`, { body: { users } }),
    ),
  retry: (id: string) =>
    serialized(() =>
      api<StorageTransition>(`${root}/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
    ),
  refresh: (id: string) =>
    serialized(() =>
      api<StorageTransition>(`${root}/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
    ),
};
