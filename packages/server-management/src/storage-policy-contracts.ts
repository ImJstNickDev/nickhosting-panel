import type { StoragePolicy } from '@nickhosting/database';

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
  /** Always present in API responses; optional for previously persisted plans. */
  quotaSource?: 'default' | 'override';
  requiredMiB: number | null;
  servers: StoragePolicyServer[];
}
export interface StoragePolicyTransition {
  id: string;
  status: 'draft' | 'applying' | 'blocked' | 'completed' | 'superseded';
  policy: StoragePolicy;
  previousPolicy: StoragePolicy;
  defaultUserStorageMiB: number;
  createdAt: Date;
  updatedAt: Date;
  errorCode: string | null;
  users: StoragePolicyUser[];
}
