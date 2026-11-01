import type { ColumnType, Generated } from 'kysely';

export type StoragePolicy = 'GLOBAL_POOL' | 'PER_USER_BUDGET';
export interface StoragePolicyTables {
  storage_user_budgets: {
    user_id: string;
    storage_mib: string | null;
    updated_at: Generated<Date>;
  };
  storage_policy_transitions: {
    id: string;
    actor_user_id: string;
    status: 'draft' | 'applying' | 'blocked' | 'completed' | 'superseded';
    policy: StoragePolicy;
    previous_policy: StoragePolicy;
    default_user_storage_mib: number;
    plan: ColumnType<unknown, string, string>;
    error_code: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
}
