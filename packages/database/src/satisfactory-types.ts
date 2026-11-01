import type { ColumnType, Generated } from 'kysely';

type Json = ColumnType<unknown, string, string>;
export interface SatisfactoryModTables {
  satisfactory_mod_states: {
    server_id: string;
    selection: Json;
    files: Json;
    lock: Json;
    updated_at: Generated<Date>;
    revision: Generated<number>;
    vanilla: Generated<boolean>;
    active_profile_id: string | null;
    external_mode: Generated<boolean>;
    external_previous_intent: string | null;
    inventory_fingerprint: string | null;
    recovery: Json | null;
  };
  satisfactory_mod_profiles: {
    id: string;
    server_id: string;
    name: string;
    selection: Json;
    vanilla: Generated<boolean>;
    required_targets: Json;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  satisfactory_mod_plans: {
    id: string;
    server_id: string;
    job_id: string | null;
    revision: number;
    status: Generated<'pending' | 'ready' | 'applied' | 'failed'>;
    selection: Json;
    vanilla: Generated<boolean>;
    profile_id: string | null;
    lock: Json | null;
    files: Json | null;
    changes: Json | null;
    inventory_fingerprint: string | null;
    game_version: number | null;
    created_at: Generated<Date>;
    expires_at: Generated<Date>;
  };
}
