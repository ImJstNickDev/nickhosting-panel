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
  provider_server_projections: {
    server_id: string;
    instance_id: string;
    revision: string;
    payload: unknown;
    synchronized_at: Date;
    valid: boolean;
    identity_invalidated: boolean;
  };
}
