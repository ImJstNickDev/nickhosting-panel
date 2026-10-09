import type { Generated } from 'kysely';

export type GatewayServerState =
  | 'sleeping'
  | 'waking'
  | 'online'
  | 'blocked'
  | 'maintenance'
  | 'manually_stopped';

export interface GatewayTables {
  gateway_server_states: {
    server_id: string;
    generation: string;
    enabled: boolean;
    protocol_id: string;
    game_version: string;
    state: GatewayServerState;
    idle_timeout_seconds: number | null;
    readiness_timeout_seconds: number;
    readiness_max_age_seconds: number;
    estimate_max_age_seconds: number;
    wake_retry_seconds: number;
    wake_job_id: string | null;
    sleep_job_id: string | null;
    process_started_at: string | null;
    readiness_observed_at: Date | null;
    startup_deadline_at: Date | null;
    idle_since: Date | null;
    last_observed_at: Date | null;
    last_activity_at: Date | null;
    blocked_until: Date | null;
    error_code: string | null;
    updated_at: Generated<Date>;
  };
  gateway_startup_samples: {
    server_id: string;
    job_id: string;
    fingerprint: string;
    process_started_at: string;
    ready_at: Date;
    duration_ms: number;
  };
}
