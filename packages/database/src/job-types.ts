import type { ColumnType, Generated } from 'kysely';

type JsonObject = ColumnType<Record<string, unknown>, string, string>;

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface JobTables {
  operation_jobs: {
    id: string;
    actor_id: string;
    subject_id: string;
    resource_owner_id: string;
    support_session_id: string | null;
    idempotency_key: string;
    command_hash: string;
    command: JsonObject;
    policy_snapshot: JsonObject;
    state: Generated<JobState>;
    attempts: Generated<number>;
    max_attempts: number;
    error_code: string | null;
    next_attempt_at: Generated<Date>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    completed_at: Date | null;
  };
  job_outbox: {
    job_id: string;
    generation: Generated<number>;
    next_dispatch_at: Generated<Date>;
    last_dispatched_at: Date | null;
  };
  job_steps: {
    job_id: string;
    step: string;
    completed_at: Generated<Date>;
  };
  activity_events: {
    id: string;
    job_id: string;
    actor_id: string;
    subject_id: string;
    resource_owner_id: string;
    message_key: string;
    parameters: JsonObject;
    created_at: Generated<Date>;
  };
}
