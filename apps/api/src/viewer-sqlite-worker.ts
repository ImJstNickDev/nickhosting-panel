/** Autonomous ESM worker: native Node 24 source execution and compiled production. */
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import type { DatagridCell, DatagridColumn, DatagridQuery } from '@nickhosting/game-sdk/ui';

const port = parentPort;
if (!port) throw new Error('viewer_sqlite_unavailable');
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const reference = (identifier: string) => `"datagrid_source".${quote(identifier)}`;
const errorCode = (error: unknown) =>
  error instanceof Error && error.message.startsWith('viewer_')
    ? error.message
    : 'viewer_sqlite_invalid';
type Message = DatagridQuery & {
  id: number;
  operation: 'rows' | 'cell';
  offset: number;
  limit: number;
  rowOffset: number;
  column: string;
  revision: string;
  start: number;
};
const pageNumber = (value: number, maximum: number) =>
  Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const cell = (type: string, raw: SQLOutputValue | undefined, maximum: number): DatagridCell => {
  if (type === 'blob') return { type: 'blob', bytes: Number(raw) };
  if (type === 'null') return { type: 'null', value: null };
  if (type === 'integer') return { type: 'integer', value: String(raw) };
  if (type === 'real') return { type: 'real', value: Number(raw) };
  const characters = Array.from(String(raw));
  return {
    type: 'text',
    value: characters.slice(0, maximum).join(''),
    truncated: characters.length > maximum,
  };
};
try {
  const db = new DatabaseSync(workerData.path, {
    readOnly: true,
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    readBigInts: true,
    limits: {
      length: 16 * 1024 * 1024,
      sqlLength: 128 * 1024,
      column: 512,
      exprDepth: 64,
      attach: 0,
      triggerDepth: 0,
      vdbeOp: 100_000,
    },
  });
  db.exec(
    'PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-4096;',
  );
  const check = db.prepare('PRAGMA quick_check(1)').get();
  if (!check || Object.values(check)[0] !== 'ok') throw new Error('viewer_sqlite_invalid');
  // JS lowercase provides Unicode case handling; instr/LIKE alone are ASCII-only.
  db.function('nh_contains', { deterministic: true, useBigIntArguments: true }, (value, query) =>
    value === null || value instanceof Uint8Array
      ? 0
      : Number(String(value).toLowerCase().includes(String(query))),
  );
  const tables = db
    .prepare(`SELECT name,wr FROM pragma_table_list
    WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 1001`)
    .all();
  if (tables.length > 1000) throw new Error('viewer_sqlite_budget');
  const names = new Map(tables.map((table) => [String(table.name), table.wr === 1n]));
  const schemas = new Map<string, { fields: DatagridColumn[]; order: string[] }>();
  const describe = (table: string) => {
    if (!names.has(table)) throw new Error('viewer_sqlite_table');
    const cached = schemas.get(table);
    if (cached) return cached;
    const columns = db
      .prepare('SELECT name,type,"notnull",pk,hidden FROM pragma_table_xinfo(?) ORDER BY cid')
      .all(table);
    // Include generated columns (hidden 2/3), exclude virtual hidden fields.
    const visible = columns.filter((column) => column.hidden !== 1n);
    if (visible.length === 0) throw new Error('viewer_sqlite_table');
    if (visible.length > 128) throw new Error('viewer_sqlite_budget');
    const primary = visible
      .filter((column) => column.pk !== 0n)
      .sort((a, b) => Number(a.pk) - Number(b.pk));
    // INTEGER PRIMARY KEY aliases read the non-null rowid despite pragma notnull=0.
    // The inline DESC exception has a real PK index and retains SQLite's nullable PK behavior.
    const rowidAlias =
      !names.get(table) &&
      primary.length === 1 &&
      String(primary[0]?.type).toUpperCase() === 'INTEGER' &&
      !db.prepare("SELECT 1 FROM pragma_index_list(?) WHERE origin='pk' LIMIT 1").get(table)
        ? primary[0]
        : undefined;
    const fields = visible.map((column) => ({
      name: String(column.name),
      type: String(column.type),
      nullable: column.notnull === 0n && column !== rowidAlias,
      primaryKey: column.pk !== 0n,
    }));
    const shadowed = new Set(columns.map((column) => String(column.name).toLowerCase()));
    const rowid = names.get(table)
      ? undefined
      : ['rowid', '_rowid_', 'oid'].find((name) => !shadowed.has(name));
    const order = rowid
      ? [rowid]
      : names.get(table) && primary.length
        ? primary.map((column) => String(column.name))
        : fields.map((field) => field.name);
    const schema = { fields, order };
    schemas.set(table, schema);
    return schema;
  };
  // A balanced tree keeps the 128-column search within SQLite's expression-depth budget.
  const disjunction = (terms: string[]): string => {
    if (terms.length <= 1) return terms[0] ?? '0';
    const middle = Math.floor(terms.length / 2);
    return `(${disjunction(terms.slice(0, middle))} OR ${disjunction(terms.slice(middle))})`;
  };
  const queryParts = (message: Message) => {
    const schema = describe(message.table);
    for (const name of [message.sort, message.filterColumn])
      if (name !== undefined && !schema.fields.some((field) => field.name === name))
        throw new Error('viewer_sqlite_column');
    if (
      (message.direction !== undefined && !['asc', 'desc'].includes(message.direction)) ||
      (message.query !== undefined &&
        (typeof message.query !== 'string' || message.query.length > 200))
    )
      throw new Error('viewer_page_invalid');
    const searched =
      message.filterColumn === undefined
        ? schema.fields
        : schema.fields.filter((field) => field.name === message.filterColumn);
    const query = message.query?.toLowerCase() ?? '';
    // CASE excludes BLOBs before invoking the function; no BLOB is materialized in JS.
    const where = query
      ? ` WHERE ${disjunction(searched.map((field) => `CASE WHEN typeof(${reference(field.name)})!='blob' THEN nh_contains(${reference(field.name)},?) ELSE 0 END`))}`
      : '';
    const order = [
      ...(message.sort === undefined
        ? []
        : [`${reference(message.sort)} ${message.direction === 'desc' ? 'DESC' : 'ASC'}`]),
      ...schema.order.map((name) => `${reference(name)} ASC`),
    ];
    return {
      ...schema,
      sql: ` FROM ${quote(message.table)} AS "datagrid_source"${where} ORDER BY ${order.join(',')}`,
      bindings: query ? searched.map(() => query) : [],
    };
  };
  port.postMessage({ id: 0, result: { tables: [...names.keys()].map((name) => ({ name })) } });
  port.on('message', (message: Message) => {
    try {
      if (message.operation === 'cell' && message.revision !== workerData.revision)
        throw new Error('viewer_sqlite_changed');
      const { fields, sql, bindings } = queryParts(message);
      let result: unknown;
      if (message.operation === 'cell') {
        if (
          !pageNumber(message.rowOffset, 1_000_000) ||
          !pageNumber(message.start, Number.MAX_SAFE_INTEGER - 65537)
        )
          throw new Error('viewer_page_invalid');
        if (!fields.some((field) => field.name === message.column))
          throw new Error('viewer_sqlite_column');
        const name = reference(message.column);
        const row = db
          .prepare(`SELECT typeof(${name}) AS type,
          CASE WHEN typeof(${name})='blob' THEN length(${name}) WHEN typeof(${name})='text' THEN substr(${name},?,65537) ELSE ${name} END AS value,
          CASE WHEN typeof(${name})='text' THEN length(${name}) ELSE NULL END AS characters${sql} LIMIT 1 OFFSET ?`)
          .get(message.start + 1, ...bindings, message.rowOffset);
        if (!row) throw new Error('viewer_sqlite_cell');
        const value = cell(String(row.type), row.value, 65536);
        const total = row.characters === null ? null : Number(row.characters);
        result = {
          revision: workerData.revision,
          column: message.column,
          cell: value,
          start: message.start,
          nextStart: total !== null && message.start + 65536 < total ? message.start + 65536 : null,
          totalCharacters: total,
        };
      } else {
        if (
          !pageNumber(message.offset, 1_000_000) ||
          !pageNumber(message.limit, 200) ||
          message.limit < 1
        )
          throw new Error('viewer_page_invalid');
        const expressions = fields.flatMap((field, index) => {
          const name = reference(field.name);
          return [
            `typeof(${name}) AS "t${index}"`,
            `CASE WHEN typeof(${name})='blob' THEN length(${name}) WHEN typeof(${name})='text' THEN substr(${name},1,4097) ELSE ${name} END AS "v${index}"`,
          ];
        });
        const values = db
          .prepare(`SELECT ${expressions.join(',')}${sql} LIMIT ? OFFSET ?`)
          .all(...bindings, message.limit + 1, message.offset);
        result = {
          columns: fields,
          rows: values
            .slice(0, message.limit)
            .map((row) =>
              fields.map((_, index) => cell(String(row[`t${index}`]), row[`v${index}`], 4096)),
            ),
          offset: message.offset,
          nextOffset: values.length > message.limit ? message.offset + message.limit : null,
        };
      }
      if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024)
        throw new Error('viewer_sqlite_budget');
      port.postMessage({ id: message.id, result });
    } catch (error) {
      port.postMessage({ id: message.id, error: errorCode(error) });
    }
  });
  port.once('close', () => db.close());
} catch (error) {
  port.postMessage({ id: 0, error: errorCode(error) });
  port.close();
}
