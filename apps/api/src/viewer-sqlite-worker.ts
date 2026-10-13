/** Serialized into an isolated Node worker; only fixed read-only queries are accepted. */
export function sqliteViewerWorker(): void {
  const { parentPort, workerData } =
    require('node:worker_threads') as typeof import('node:worker_threads');
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const port = parentPort;
  if (!port) return;
  const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
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
    const tables = db
      .prepare(`SELECT name FROM pragma_table_list
      WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name LIMIT 1001`)
      .all();
    if (tables.length > 1000) throw new Error('viewer_sqlite_budget');
    const names = new Set(tables.map((table) => String(table.name)));
    const columns = new Map<
      string,
      { name: string; type: string; nullable: boolean; primaryKey: boolean }[]
    >();
    const describe = (table: string) => {
      if (!names.has(table)) throw new Error('viewer_sqlite_table');
      let result = columns.get(table);
      if (!result) {
        result = db
          .prepare(
            'SELECT name,type,"notnull",pk FROM pragma_table_xinfo(?) WHERE hidden=0 ORDER BY cid',
          )
          .all(table)
          .map((column) => ({
            name: String(column.name),
            type: String(column.type),
            nullable: column.notnull === 0n,
            primaryKey: column.pk !== 0n,
          }));
        if (result.length > 128) throw new Error('viewer_sqlite_budget');
        columns.set(table, result);
      }
      return result;
    };
    port.postMessage({ id: 0, result: { tables: [...names].map((name) => ({ name })) } });
    port.on('message', (message: { id: number; table: string; offset: number; limit: number }) => {
      try {
        if (
          !Number.isSafeInteger(message.offset) ||
          message.offset < 0 ||
          message.offset > 1_000_000 ||
          !Number.isSafeInteger(message.limit) ||
          message.limit < 1 ||
          message.limit > 200
        )
          throw new Error('viewer_page_invalid');
        const fields = describe(message.table);
        if (fields.length === 0) throw new Error('viewer_sqlite_table');
        // Large BLOBs are represented by byte counts; long strings are explicitly truncated.
        const expressions = fields.flatMap((field, index) => {
          const name = quote(field.name);
          return [
            `typeof(${name}) AS "t${index}"`,
            `CASE WHEN typeof(${name})='blob' THEN length(${name})
            WHEN typeof(${name})='text' THEN substr(${name},1,4097) ELSE ${name} END AS "v${index}"`,
          ];
        });
        const values = db
          .prepare(`SELECT ${expressions.join(',')} FROM ${quote(message.table)} LIMIT ? OFFSET ?`)
          .all(message.limit + 1, message.offset);
        const hasMore = values.length > message.limit;
        const rows = values.slice(0, message.limit).map((row) =>
          fields.map((_, index) => {
            const type = String(row[`t${index}`]);
            const raw = row[`v${index}`];
            if (type === 'blob') return { type: 'blob', bytes: Number(raw) };
            if (type === 'null') return { type: 'null', value: null };
            if (type === 'integer') return { type: 'integer', value: String(raw) };
            if (type === 'real') return { type: 'real', value: Number(raw) };
            const text = String(raw);
            return { type: 'text', value: text.slice(0, 4096), truncated: text.length > 4096 };
          }),
        );
        const result = {
          columns: fields,
          rows,
          offset: message.offset,
          nextOffset: hasMore ? message.offset + message.limit : null,
        };
        if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024)
          throw new Error('viewer_sqlite_budget');
        port.postMessage({ id: message.id, result });
      } catch (error) {
        const code =
          error instanceof Error && error.message.startsWith('viewer_')
            ? error.message
            : 'viewer_sqlite_invalid';
        port.postMessage({ id: message.id, error: code });
      }
    });
    port.once('close', () => db.close());
  } catch (error) {
    const code =
      error instanceof Error && error.message.startsWith('viewer_')
        ? error.message
        : 'viewer_sqlite_invalid';
    port.postMessage({ id: 0, error: code });
    port.close();
  }
}
