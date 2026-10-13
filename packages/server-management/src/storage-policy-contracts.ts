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
