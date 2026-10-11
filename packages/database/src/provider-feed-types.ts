export interface ProviderFeedTables {
  provider_change_feeds: {
    instance_id: string;
    provider_url: string;
    callback_url: string;
    healthy_at: Date | null;
    generation: string;
    enabled: boolean;
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
