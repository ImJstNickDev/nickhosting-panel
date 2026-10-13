import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { cachedFileSource, ViewerCache } from './viewer-cache.js';
import { openSqliteViewer, type ViewerSqliteSource } from './viewer-sqlite.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((action) => action()));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'nh-viewer-sqlite-'));
  const path = join(root, 'source.db');
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, avatar BLOB);
    INSERT INTO players VALUES (9007199254740993,'Nick',zeroblob(100));
    INSERT INTO players VALUES (2,'Second',NULL);
    CREATE TABLE "quote""table" (value TEXT);
    INSERT INTO "quote""table" VALUES ('safe');`);
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
  return { source, cache, path };
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
});
