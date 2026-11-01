import type { ColumnType, Generated } from 'kysely';

export interface SatisfactoryModTables {
  satisfactory_mod_states: {
    server_id: string;
    selection: ColumnType<unknown, string, string>;
    files: ColumnType<unknown, string, string>;
    lock: ColumnType<unknown, string, string>;
    updated_at: Generated<Date>;
  };
}
