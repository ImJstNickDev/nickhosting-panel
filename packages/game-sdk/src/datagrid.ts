/** Read-only Datagrid transport. No SQL or executable expressions cross this boundary. */
export type DatagridCell =
  | { type: 'null'; value: null }
  | { type: 'integer'; value: string }
  | { type: 'real'; value: number }
  | { type: 'text'; value: string; truncated: boolean }
  | { type: 'blob'; bytes: number };

export interface DatagridColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface DatagridQuery {
  table: string;
  offset?: number;
  limit?: number;
  query?: string;
  filterColumn?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
}

export interface DatagridPage {
  tables: string[];
  /** Opaque source revision; cell requests must supply the revision of their row. */
  revision: string;
  consistency: 'unverified' | 'provider-snapshot';
  table?: string;
  columns?: string[];
  schema?: DatagridColumn[];
  rows?: DatagridCell[][];
  offset?: number;
  hasMore?: boolean;
}

export interface DatagridCellDetail {
  revision: string;
  column: string;
  cell: DatagridCell;
  /** Text slices are indexed in Unicode code points, as SQLite substr(). */
  start: number;
  nextStart: number | null;
  totalCharacters: number | null;
}
