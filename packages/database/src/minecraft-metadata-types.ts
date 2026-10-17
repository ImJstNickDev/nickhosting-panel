import type { ColumnType, Generated } from 'kysely';

export interface MinecraftMetadataTables {
  minecraft_release_metadata: {
    id: string;
    release_type: 'release' | 'snapshot' | 'old_alpha' | 'old_beta';
    release_time: Date | null;
    metadata_url: string;
    sha1: string;
  };
  minecraft_metadata_sync: {
    id: 'mojang';
    manifest_json: ColumnType<unknown, string | null, string | null>;
    manifest_hash: string | null;
    last_checked_at: Date | null;
    last_success_at: Date | null;
    next_check_at: Generated<Date>;
    last_error: string | null;
    lease_id: string | null;
    lease_until: Date | null;
  };
}
