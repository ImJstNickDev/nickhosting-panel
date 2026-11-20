import type { ColumnType, Generated } from 'kysely';

type Json = ColumnType<unknown, string, string>;
export interface MinecraftTables {
  minecraft_world_indexes: {
    server_id: string;
    generation: Generated<string>;
    operation_generation: Generated<string>;
    next_scan_at: Date;
    lease_id: string | null;
    lease_until: Date | null;
    finished_id: string | null;
    denied_reason: 'forbidden' | 'provenance_mismatch' | 'not_found' | null;
    successful_generation: string | null;
    binding: string | null;
    local_binding: string | null;
    snapshot: Json;
    level_stamps: ColumnType<unknown, string | undefined, string>;
    non_world_directories: Generated<string[]>;
    observed_at: Date | null;
    last_file_change_at: Date | null;
  };
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
    runtime_image_digest: Generated<string | null>;
    runtime_image_transition: ColumnType<unknown, string | undefined, string>;
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
