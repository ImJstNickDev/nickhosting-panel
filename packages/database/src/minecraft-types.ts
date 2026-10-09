import type { ColumnType, Generated } from 'kysely';

type Json = ColumnType<unknown, string, string>;
export interface MinecraftTables {
  minecraft_combinations: {
    id: string;
    mapping_id: string;
    identity_digest: string;
    combination: Json;
    resolved_runtime: Json;
    binding: Json;
    mapping_digest: string;
    enabled: Generated<boolean>;
    created_at: Generated<Date>;
  };
  minecraft_verification_evidence: {
    id: string;
    combination_id: string;
    report: Json;
    signature: string;
    created_at: Generated<Date>;
  };
  minecraft_server_profiles: {
    server_id: string;
    combination_id: string;
    configuration: Json;
    installed: Generated<boolean>;
    installed_manifest: ColumnType<unknown, string | undefined, string>;
    content_state: ColumnType<unknown, string | undefined, string>;
    configuration_state: ColumnType<unknown, string | undefined, string>;
    updated_at: Generated<Date>;
  };
  minecraft_content_items: {
    server_id: string;
    path: string;
    artifact: Json;
    installed_by: string;
    installed_at: Generated<Date>;
  };
}
