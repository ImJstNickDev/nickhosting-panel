import type { ColumnType, Generated } from 'kysely';

export type ScheduleAction = 'start' | 'stop' | 'restart' | 'backup';
export type ScheduleTiming =
  | { kind: 'once'; at: string }
  | { kind: 'interval'; firstAt: string; everySeconds: number };

export interface ScheduleTables {
  server_schedules: {
    id: string;
    server_id: string;
    creator_id: string;
    name: string;
    action: ScheduleAction;
    timing: ColumnType<ScheduleTiming, string, string>;
    time_zone: string;
    enabled: boolean;
    revision: Generated<number>;
    next_run_at: Date | null;
    deleted_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  schedule_occurrences: {
    id: string;
    schedule_id: string;
    revision: number;
    due_at: Date;
    action: ScheduleAction;
    status: 'dispatched' | 'skipped';
    reason: string | null;
    missed_count: number;
    job_id: string | null;
    created_at: Generated<Date>;
  };
}
