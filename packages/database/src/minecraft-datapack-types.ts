import type { ColumnType, Generated } from 'kysely';

export interface MinecraftDatapackTables {
  minecraft_datapack_changes: {
    id: string;
    server_id: string;
    actor_user_id: string;
    world: string;
    name: string;
    action: 'install' | 'enable' | 'disable' | 'delete';
    state: 'preparing' | 'ready' | 'dispatched' | 'applied' | 'failed' | 'uncertain' | 'cancelled';
    idempotency_key: string;
    source_id: string | null;
    plan: ColumnType<unknown, string, string>;
    error: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  minecraft_datapack_applies: {
    id: string;
    server_id: string;
    actor_user_id: string;
    world: string;
    idempotency_key: string;
    changes: ColumnType<string[], string, string>;
    state: 'dispatched' | 'published' | 'uncertain' | 'reconciled';
    cleanup: ColumnType<string[], string | undefined, string>;
    cleanup_state: Generated<'pending' | 'complete' | 'failed'>;
    reload: 'not_required' | 'required' | 'requested' | 'uncertain';
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
}
