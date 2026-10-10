export interface HealthTables {
  service_heartbeats: {
    service: 'worker' | 'gateway';
    instance_id: string;
    scope_hash: string;
    state: 'running' | 'degraded' | 'stopped' | 'contact';
    observed_at: Date;
  };
}
