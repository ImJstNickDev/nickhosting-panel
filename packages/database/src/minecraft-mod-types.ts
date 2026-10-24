import type { ColumnType, Generated } from 'kysely';

type Json = ColumnType<unknown, string, string>;
export interface MinecraftModTables {
  minecraft_mod_drafts: {
    server_id: string;
    revision: number;
    actor_user_id: string;
    selection: Json;
    state: 'preparing' | 'ready' | 'failed' | 'uncertain';
    blockers: Json;
    optional: Json;
    error: string | null;
    updated_at: Generated<Date>;
  };
  minecraft_mod_changes: {
    id: string;
    server_id: string;
    revision: number;
    actor_user_id: string;
    action: 'install' | 'enable' | 'disable' | 'delete';
    state:
      | 'queued'
      | 'preparing'
      | 'ready'
      | 'dispatched'
      | 'applied'
      | 'failed'
      | 'uncertain'
      | 'cancelled';
    idempotency_key: string;
    plan: Json;
    error: string | null;
    cleanup_done: Generated<boolean>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  minecraft_mod_applies: {
    id: string;
    server_id: string;
    revision: number;
    actor_user_id: string;
    idempotency_key: string;
    changes: Json;
    moves: Json;
    state: 'dispatched' | 'published' | 'uncertain' | 'reconciled';
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  minecraft_mod_receipts: { server_id: string; path: string; receipt: Json };
  minecraft_mod_restart: { server_id: string; changed_at: Date };
}

/** Separate durable namespace, sharing the exact publication lifecycle schema. */
export type MinecraftPluginTables = {
  [K in keyof MinecraftModTables as K extends `minecraft_mod_${infer Name}`
    ? `minecraft_plugin_${Name}`
    : never]: MinecraftModTables[K];
};
