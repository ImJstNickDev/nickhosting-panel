import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { cachedFileSource, ViewerCache } from './viewer-cache.js';
import { openSqliteViewer, type ViewerSqliteSource } from './viewer-sqlite.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((action) => action()));
});
async function setup(extra?: (database: DatabaseSync) => void) {
  const root = await mkdtemp(join(tmpdir(), 'nh-viewer-sqlite-'));
  const path = join(root, 'source.db');
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, avatar BLOB);
    INSERT INTO players VALUES (9007199254740993,'Nick',zeroblob(100));
    INSERT INTO players VALUES (2,'Second',NULL);
    CREATE TABLE "quote""table" (value TEXT);
    INSERT INTO "quote""table" VALUES ('safe');`);
  extra?.(database);
  database.close();
  const metadata = await stat(path);
  const cache = new ViewerCache({ root: join(root, 'cache') });
  cleanup.push(async () => {
    await cache.close();
    await rm(root, { recursive: true, force: true });
  });
  const source: ViewerSqliteSource = {
    ...cachedFileSource(path, metadata.size, metadata.mtimeMs),
    restat: () => stat(path),
    siblingExists: async () => false,
  };
  return { source, cache, path, root };
}
describe('read-only SQLite snapshots', () => {
  it('browses tables with typed cells, exact 64-bit integers and bounded BLOB representation', async () => {
    const { source, cache, path } = await setup();
    const before = await readFile(path);
    const viewer = await openSqliteViewer(source, { cache, key: 'test' });
    cleanup.push(() => viewer.close());
    expect(viewer.consistency).toBe('unverified');
    expect(viewer.tables().map((table) => table.name)).toContain('players');
    const first = await viewer.rows({ table: 'players', limit: 1 });
    expect(first.nextOffset).toBe(1);
    expect(first.columns[0]).toMatchObject({ name: 'id', nullable: false });
    const second = await viewer.rows({ table: 'players', offset: 1 });
    expect(second.rows[0]?.[0]).toEqual({ type: 'integer', value: '9007199254740993' });
    expect(second.rows[0]?.[2]).toEqual({ type: 'blob', bytes: 100 });
    expect(await readFile(path)).toEqual(before);
  });
  it('rejects table-name SQL injection and caps pagination', async () => {
    const { source, cache } = await setup();
    const viewer = await openSqliteViewer(source, { cache, key: 'test' });
    cleanup.push(() => viewer.close());
    await expect(viewer.rows({ table: 'players; DELETE FROM players' })).rejects.toMatchObject({
      code: 'viewer_sqlite_table',
    });
    await expect(viewer.rows({ table: 'players', limit: 201 })).rejects.toMatchObject({
      code: 'viewer_page_invalid',
    });
    const result = await viewer.rows({ table: 'quote"table' });
    expect(result.rows[0]?.[0]).toMatchObject({ value: 'safe' });
  });
  it('refuses sidecars/WAL and a source changed while snapshotting', async () => {
    const { source, cache } = await setup();
    await expect(
      openSqliteViewer({ ...source, siblingExists: async () => true }, { cache, key: 'a' }),
    ).rejects.toMatchObject({ code: 'viewer_sqlite_wal' });
    await expect(
      openSqliteViewer(
        { ...source, restat: async () => ({ size: source.size, mtimeMs: source.mtimeMs + 1 }) },
        { cache, key: 'b' },
      ),
    ).rejects.toMatchObject({ code: 'viewer_sqlite_changed' });
  });
  it('terminates the worker and rejects subsequent queries on revocation', async () => {
    const { source, cache } = await setup();
    const controller = new AbortController();
    const viewer = await openSqliteViewer(source, { cache, key: 'a', signal: controller.signal });
    cleanup.push(() => viewer.close());
    controller.abort();
    expect(viewer.closedSignal.aborted).toBe(true);
    await expect(viewer.rows({ table: 'players' })).rejects.toMatchObject({
      code: 'viewer_session_closed',
    });
  });
  it('cancels only one query subscriber without poisoning the retained worker', async () => {
    const { source, cache } = await setup();
    const viewer = await openSqliteViewer(source, { cache, key: 'a' });
    cleanup.push(() => viewer.close());
    const controller = new AbortController();
    const canceled = viewer.rows({ table: 'players' }, controller.signal);
    controller.abort(new Error('tab closed'));
    await expect(canceled).rejects.toThrow('tab closed');
    expect(viewer.closedSignal.aborted).toBe(false);
    expect((await viewer.rows({ table: 'players' })).rows).toHaveLength(2);
  });
  it('sorts and filters before pagination using literal Unicode search and stable ties', async () => {
    const { source, cache } = await setup((db) => {
      db.exec(`CREATE TABLE search (id INTEGER, value TEXT, data BLOB);
        INSERT INTO search VALUES (1,'École',X'4142'),(2,'éCOLE',NULL),(3,'100%_literal',NULL),(4,'x'' OR 1=1 --',NULL),(5,NULL,NULL);`);
    });
    const viewer = await openSqliteViewer(source, { cache, key: 'search' });
    cleanup.push(() => viewer.close());
    const query = { table: 'search', query: 'école', sort: 'value', limit: 1 };
    const first = await viewer.rows(query);
    const second = await viewer.rows({ ...query, offset: 1 });
    expect(first.rows[0]?.[0]).toEqual({ type: 'integer', value: '1' });
    expect(second.rows[0]?.[0]).toEqual({ type: 'integer', value: '2' });
    expect(second.nextOffset).toBeNull();
    for (const literal of ['%_', "' OR 1=1 --"])
      expect((await viewer.rows({ table: 'search', query: literal })).rows).toHaveLength(1);
    expect(
      (await viewer.rows({ table: 'search', query: 'AB', filterColumn: 'data' })).rows,
    ).toEqual([]);
    expect(
      (await viewer.rows({ table: 'search', query: '2', filterColumn: 'id' })).rows,
    ).toHaveLength(1);
    for (const invalid of [{ sort: 'id; DELETE FROM search' }, { filterColumn: 'missing' }])
      await expect(viewer.rows({ table: 'search', ...invalid })).rejects.toMatchObject({
        code: 'viewer_sqlite_column',
      });
    await expect(viewer.rows({ table: 'search', query: 'x'.repeat(201) })).rejects.toMatchObject({
      code: 'viewer_page_invalid',
    });
  });
  it('orders ties with unshadowed rowid aliases, composite WITHOUT ROWID keys and full-column fallback', async () => {
    const { source, cache } = await setup((db) => {
      db.exec(`CREATE TABLE shadow (rowid TEXT, value TEXT);
        INSERT INTO shadow VALUES ('z','same'),('a','same'),('m','same');
        CREATE TABLE keyed (b INTEGER, a INTEGER, value TEXT, PRIMARY KEY(a,b)) WITHOUT ROWID;
        INSERT INTO keyed VALUES (2,1,'same'),(1,2,'same'),(1,1,'same');
        CREATE TABLE allshadow (rowid TEXT, _rowid_ TEXT, oid TEXT);
        INSERT INTO allshadow VALUES ('same','z','3'),('same','a','1');
        CREATE TABLE descpk (id INTEGER PRIMARY KEY DESC);
        INSERT INTO descpk VALUES (NULL);
        CREATE TABLE textpk (id TEXT PRIMARY KEY);
        INSERT INTO textpk VALUES (NULL);`);
    });
    const viewer = await openSqliteViewer(source, { cache, key: 'ties' });
    cleanup.push(() => viewer.close());
    const ids: string[] = [];
    for (let offset = 0; offset < 3; offset++) {
      const page = await viewer.rows({
        table: 'shadow',
        sort: 'value',
        direction: 'desc',
        limit: 1,
        offset,
      });
      const firstCell = page.rows[0]?.[0];
      if (firstCell?.type !== 'text') throw new Error('expected text fixture');
      ids.push(firstCell.value);
    }
    expect(ids).toEqual(['z', 'a', 'm']);
    const keyed = await viewer.rows({ table: 'keyed', sort: 'value', limit: 2 });
    expect(keyed.columns.slice(0, 2).map((column) => column.nullable)).toEqual([false, false]);
    for (const table of ['descpk', 'textpk']) {
      const nullable = await viewer.rows({ table });
      expect(nullable.columns[0]).toMatchObject({ primaryKey: true, nullable: true });
      expect(nullable.rows[0]?.[0]).toEqual({ type: 'null', value: null });
    }
    expect(keyed.rows.map((row) => row.slice(0, 2))).toEqual([
      [
        { type: 'integer', value: '1' },
        { type: 'integer', value: '1' },
      ],
      [
        { type: 'integer', value: '2' },
        { type: 'integer', value: '1' },
      ],
    ]);
    expect((await viewer.rows({ table: 'allshadow', sort: 'rowid' })).rows[0]?.[1]).toMatchObject({
      value: 'a',
    });
  });
  it('returns Unicode code-point cell slices with exact lengths and checks revision before row lookup', async () => {
    const long = `${'😀'.repeat(65537)}é`;
    const { source, cache } = await setup((db) => {
      db.exec(
        'CREATE TABLE detail (id INTEGER PRIMARY KEY, value TEXT, fraction REAL, empty TEXT, data BLOB)',
      );
      db.prepare('INSERT INTO detail VALUES (?,?,?,?,?)').run(
        42,
        long,
        1.5,
        null,
        new Uint8Array(123),
      );
    });
    const viewer = await openSqliteViewer(source, { cache, key: 'details' });
    cleanup.push(() => viewer.close());
    const page = await viewer.rows({ table: 'detail' });
    expect(page.rows[0]?.[1]).toEqual({ type: 'text', value: '😀'.repeat(4096), truncated: true });
    expect(page.rows[0]?.[2]).toEqual({ type: 'real', value: 1.5 });
    expect(page.rows[0]?.[3]).toEqual({ type: 'null', value: null });
    const query = { table: 'detail', rowOffset: 0, column: 'value', revision: viewer.revision };
    const first = await viewer.cell(query);
    expect(first).toMatchObject({
      start: 0,
      nextStart: 65536,
      totalCharacters: 65538,
      cell: { value: '😀'.repeat(65536), truncated: true },
    });
    expect(await viewer.cell({ ...query, start: first.nextStart ?? 0 })).toMatchObject({
      start: 65536,
      nextStart: null,
      totalCharacters: 65538,
      cell: { value: '😀é', truncated: false },
    });
    expect(await viewer.cell({ ...query, column: 'data' })).toMatchObject({
      cell: { type: 'blob', bytes: 123 },
      totalCharacters: null,
      nextStart: null,
    });
    await expect(
      viewer.cell({ ...query, table: 'nonexistent', revision: 'stale' }),
    ).rejects.toMatchObject({ code: 'viewer_sqlite_changed' });
    await expect(viewer.cell({ ...query, rowOffset: 1 })).rejects.toMatchObject({
      code: 'viewer_sqlite_cell',
    });
  });
  it('keeps generated output aliases separate from source column sorting and detail selection', async () => {
    const { source, cache } = await setup((db) => {
      db.exec(`CREATE TABLE collision (t0 TEXT, v0 INTEGER, type TEXT, value TEXT, characters INTEGER);
        INSERT INTO collision VALUES ('z',2,'a','b',7),('a',1,'z','a',8);`);
    });
    const viewer = await openSqliteViewer(source, { cache, key: 'aliases' });
    cleanup.push(() => viewer.close());
    for (const sort of ['t0', 'v0', 'type', 'value', 'characters']) {
      const page = await viewer.rows({ table: 'collision', sort });
      for (let rowOffset = 0; rowOffset < 2; rowOffset++) {
        const detail = await viewer.cell({
          table: 'collision',
          sort,
          rowOffset,
          column: 't0',
          revision: viewer.revision,
        });
        expect(detail.cell).toEqual(page.rows[rowOffset]?.[0]);
      }
    }
    expect((await viewer.rows({ table: 'collision', sort: 't0' })).rows[0]?.[0]).toMatchObject({
      value: 'a',
    });
    expect((await viewer.rows({ table: 'collision', sort: 'v0' })).rows[0]?.[1]).toMatchObject({
      value: '1',
    });
  });
  it('searches every supported column without exceeding the expression-depth limit', async () => {
    const { source, cache } = await setup((db) => {
      db.exec(
        `CREATE TABLE wide (${Array.from({ length: 128 }, (_, index) => `c${index} TEXT`).join(',')}); INSERT INTO wide (c127) VALUES ('last-column');`,
      );
    });
    const viewer = await openSqliteViewer(source, { cache, key: 'wide' });
    cleanup.push(() => viewer.close());
    expect((await viewer.rows({ table: 'wide', query: 'COLUMN' })).rows).toHaveLength(1);
  });
  it('executes actual tsx development and tsc-emitted production session workers', async () => {
    const { path, root } = await setup();
    const run = promisify(execFile);
    const repository = fileURLToPath(new URL('../../../', import.meta.url));
    const helper = fileURLToPath(new URL('./testing/sqlite-runtime.ts', import.meta.url));
    const development = await run('pnpm', ['exec', 'tsx', helper, path, join(root, 'dev-cache')], {
      cwd: repository,
    });
    expect(JSON.parse(development.stdout).detail.cell).toMatchObject({ value: 'Nick' });
    const build = join(root, 'compiled');
    const config = join(root, 'tsconfig.json');
    await writeFile(
      config,
      JSON.stringify({
        extends: join(repository, 'tsconfig.json'),
        compilerOptions: {
          noEmit: false,
          rootDir: repository,
          outDir: build,
          typeRoots: [join(repository, 'node_modules/@types')],
        },
        include: [helper, join(repository, 'apps/api/src/viewer-sqlite-worker.ts')],
        exclude: [],
      }),
    );
    await run('pnpm', ['exec', 'tsc', '-p', config], { cwd: repository }).catch((error) => {
      throw new Error(error.stdout + error.stderr);
    });
    await writeFile(join(build, 'package.json'), '{"type":"module"}');
    const production = await run(process.execPath, [
      join(build, 'apps/api/src/testing/sqlite-runtime.js'),
      path,
      join(root, 'prod-cache'),
    ]);
    expect(JSON.parse(production.stdout)).toEqual(JSON.parse(development.stdout));
  }, 30_000);
});
