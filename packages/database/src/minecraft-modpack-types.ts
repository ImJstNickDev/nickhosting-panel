import type { ColumnType, Generated } from 'kysely';

type Json = ColumnType<unknown, string, string>;
export interface MinecraftModpackTables {
  minecraft_modpack_operations: {
    id: string;
    server_id: string;
    actor_user_id: string;
    actor_session_id: string;
    subject_user_id: string;
    support_session_id: string | null;
    resource_owner_id: string;
    physical_host_id: string | null;
    held_bytes: ColumnType<string, string, string>;
    staging_root: string | null;
    idempotency_key: string;
    selection: Json;
    state:
      | 'queued'
      | 'preparing'
      | 'ready'
      | 'blocked'
      | 'apply_queued'
      | 'applying'
      | 'applied'
      | 'failed'
      | 'uncertain'
      | 'cancelled';
    phase: string;
    progress: Json;
    prepared: Json;
    plan: Json;
    plan_digest: string | null;
    blockers: Json;
    apply_request: Json;
    apply_actor_user_id: string | null;
    apply_actor_session_id: string | null;
    apply_subject_user_id: string | null;
    apply_support_session_id: string | null;
    apply_idempotency_key: string | null;
    journal: Json;
    publication: ColumnType<unknown, string | undefined, string>;
    runtime_transition: ColumnType<unknown, string | undefined, string>;
    runtime_preparation: ColumnType<unknown, string | undefined, string>;
    backup_id: string | null;
    restart_required: boolean;
    error: string | null;
    lease_token: string | null;
    lease_until: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  minecraft_modpack_receipts: {
    server_id: string;
    operation_id: string;
    receipt: Json;
    installed_at: Generated<Date>;
  };
}
