import type { Generated } from 'kysely';

export interface ProviderFeedTables {
  provider_backup_events: {
    event_id: string;
    instance_id: string;
    server_id: string;
    backup_id: string;
    type: 'backup.completed' | 'backup.restore-completed';
    occurred_at: Date;
    payload: unknown;
    received_at: Generated<Date>;
  };
  backup_labels: { server_id: string; backup_id: string; name: string };
  provider_change_feeds: {
    instance_id: string;
    provider_url: string;
    callback_url: string;
    healthy_at: Date | null;
    generation: string;
    enabled: boolean;
    backup_events: Generated<boolean>;
    capabilities_checked_at: Generated<Date | null>;
  };
  provider_feed_link_retries: {
    instance_id: string;
    server_id: string;
    binding: string;
    attempts: number;
    retry_at: Date;
  };
  provider_server_projections: {
    scope_healthy_at: Generated<Date | null>;
    scope_owner_id: Generated<string | null>;
    scope_provider_user_id: Generated<number | null>;
    scope_credential: Generated<string | null>;
    server_id: string;
    instance_id: string;
    revision: string;
    payload: unknown;
    synchronized_at: Date;
    valid: boolean;
    identity_invalidated: boolean;
  };
}
