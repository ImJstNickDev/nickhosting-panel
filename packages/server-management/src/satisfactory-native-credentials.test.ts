import type { Database } from '@nickhosting/database';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import {
  type CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeSatisfactoryNativeCredentials } from '../../../games/satisfactory/src/native-credentials.js';
import { verifyManagedIdentity } from './lifecycle.js';
import { readStoppedSatisfactoryCredentials } from './satisfactory-native-credentials.js';

vi.mock('./lifecycle.js', () => ({ verifyManagedIdentity: vi.fn() }));
vi.mock('../../../games/satisfactory/src/native-credentials.js', () => ({
  decodeSatisfactoryNativeCredentials: vi.fn(),
}));
const native = { build: 513885, serverName: 'Synthetic', serverSecret: 'A'.repeat(512) };
const buildPath = 'Engine/Binaries/Linux/FactoryServer-Linux-Shipping.version';
const settingsPath = '.config/Epic/FactoryGame/Saved/SaveGames/ServerSettings.12345.sav';

function fixture() {
  const server = {
    id: 'server',
    game_id: 'satisfactory',
    deleted_at: null,
    installation_state: 'installed',
    active_operation_id: null as string | null,
    runtime_state: 'offline',
    connection_mode: 'gateway',
    gatewayEnabled: true,
    gatewayState: 'sleeping',
    intent: 'sleeping',
    automatic_starts_paused: false,
    pterodactyl_id: 1,
    pterodactyl_identifier: 'abcdefgh',
    pterodactyl_uuid: 'provider-uuid',
    node_id: 'node',
    generation: '5',
  };
  const allocation = { id: 'allocation', node_id: 'node', port: 12345, protocols: ['tcp', 'udp'] };
  const control = { locked: true, activeJob: false };
  const queries: string[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection() {
      return {
        async executeQuery<R>(query: CompiledQuery) {
          queries.push(query.sql);
          let rows: unknown[] = [];
          if (query.sql.includes('pg_try_advisory')) rows = [{ acquired: control.locked }];
          else if (query.sql.includes('from "managed_servers"')) rows = [{ ...server }];
          else if (query.sql.includes('from "operation_jobs"'))
            rows = control.activeJob ? [{ id: 'active' }] : [];
          else if (query.sql.includes('from "server_allocations"')) rows = [{ ...allocation }];
          return { rows: rows as R[] };
        },
        async *streamQuery<R>() {
          yield { rows: [] as R[] };
        },
      };
    }
  }
  const db = new Kysely<Database>({
    dialect: {
      createDriver: () => new Driver(),
      createAdapter: () => new PostgresAdapter(),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createIntrospector: (db) => new PostgresIntrospector(db),
    },
  });
  const contents = new Map([
    [buildPath, Buffer.from('{"Changelist":513885}')],
    [settingsPath, Buffer.from('synthetic-native-settings')],
  ]);
  const entries = new Map<
    string,
    Array<{
      name: string;
      is_file: boolean;
      is_symlink: boolean;
      size: number;
      modified_at: string;
      created_at: string;
    }>
  >();
  for (const [path, bytes] of contents) {
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const directory = parts.slice(0, i).join('/');
      const list = entries.get(directory) ?? [];
      if (!list.some((entry) => entry.name === parts[i]))
        list.push({
          name: parts[i] as string,
          is_file: i === parts.length - 1,
          is_symlink: false,
          size: i === parts.length - 1 ? bytes.length : 0,
          modified_at: '2026-01-01',
          created_at: '2026-01-01',
        });
      entries.set(directory, list);
    }
  }
  const readFile = vi.fn(async (_id: string, path: string) =>
    Buffer.from(contents.get(path) as Buffer),
  );
  const listFiles = vi.fn(async (_id: string, path = '') => entries.get(path) ?? []);
  const getApplicationServer = vi.fn(async () => ({ uuid: 'provider-uuid' }));
  const confirmStopped = vi.fn(async () => true);
  const adapter = { readFile, listFiles, getApplicationServer } as unknown as PterodactylAdapter;
  const read = () => readStoppedSatisfactoryCredentials(db, 'server', { adapter, confirmStopped });
  return {
    adapter,
    read,
    db,
    server,
    allocation,
    control,
    queries,
    contents,
    entries,
    readFile,
    listFiles,
    getApplicationServer,
    confirmStopped,
  };
}

beforeEach(() => {
  vi.mocked(verifyManagedIdentity).mockReset();
  vi.mocked(decodeSatisfactoryNativeCredentials).mockReset().mockReturnValue(native);
});

describe('stopped native credential authority', () => {
  it('uses six bounded directory batches while retaining both full metadata fences and byte reads', async () => {
    const f = fixture();
    const batch = vi.fn(async (_identifier: string, directories: string[]) =>
      directories.map((directory) => ({ directory, files: f.entries.get(directory) ?? [] })),
    );
    Object.assign(f.adapter, { listDirectoriesBatch: batch });
    expect(await f.read()).toBeDefined();
    expect(batch).toHaveBeenCalledTimes(6);
    expect(f.listFiles).not.toHaveBeenCalled();
    expect(f.readFile).toHaveBeenCalledTimes(4);
    expect(
      batch.mock.calls
        .slice(0, 3)
        .every((call) => call[1].join('|') === '|Engine|Engine/Binaries|Engine/Binaries/Linux'),
    ).toBe(true);
    expect(
      batch.mock.calls
        .slice(3)
        .every(
          (call) =>
            call[1].join('|') ===
            '|.config|.config/Epic|.config/Epic/FactoryGame|.config/Epic/FactoryGame/Saved|.config/Epic/FactoryGame/Saved/SaveGames',
        ),
    ).toBe(true);
    await f.db.destroy();
  });

  it('fails closed on batch errors or malformed directory mappings without sequential fallback', async () => {
    for (const failure of ['throw', 'missing', 'reorder', 'duplicate', 'error'] as const) {
      const f = fixture();
      const batch = vi.fn(async (_identifier: string, directories: string[]) => {
        if (failure === 'throw') throw new Error('private upstream error');
        const results = directories.map((directory) => ({
          directory,
          files: f.entries.get(directory) ?? [],
        }));
        if (failure === 'missing') return results.slice(1);
        if (failure === 'reorder') return results.reverse();
        if (failure === 'duplicate' && results[1] && results[0])
          results[1].directory = results[0].directory;
        if (failure === 'error')
          return results.map((entry, index) =>
            index === 1 ? { directory: entry.directory, error: 'forbidden' } : entry,
          );
        return results;
      });
      Object.assign(f.adapter, { listDirectoriesBatch: batch });
      expect(await f.read()).toBeUndefined();
      expect(batch).toHaveBeenCalledTimes(1);
      expect(f.listFiles).not.toHaveBeenCalled();
      expect(f.readFile).not.toHaveBeenCalled();
      await f.db.destroy();
    }
  });

  it('preserves symlink and changing-metadata rejection when listing directories in batches', async () => {
    for (const failure of ['symlink', 'changed'] as const) {
      const f = fixture();
      let calls = 0;
      const batch = vi.fn(async (_identifier: string, directories: string[]) => {
        calls++;
        const results = directories.map((directory) => ({
          directory,
          files: (f.entries.get(directory) ?? []).map((entry) => ({ ...entry })),
        }));
        const entry = results[1]?.files[0];
        if (!entry) throw new Error('fixture');
        if (failure === 'symlink') entry.is_symlink = true;
        else if (calls === 2) entry.modified_at = 'changed';
        return results;
      });
      Object.assign(f.adapter, { listDirectoriesBatch: batch });
      expect(await f.read()).toBeUndefined();
      expect(f.listFiles).not.toHaveBeenCalled();
      await f.db.destroy();
    }
  });

  it('checks shared lifecycle lock, provider identity and fresh stop before and after bounded stable reads', async () => {
    const f = fixture();
    expect(await f.read()).toMatchObject({
      credentials: native,
      generation: '5',
      providerUuid: 'provider-uuid',
      port: 12345,
      digest: expect.stringMatching(/^[a-f\d]{64}$/),
    });
    expect(f.confirmStopped).toHaveBeenCalledTimes(2);
    expect(verifyManagedIdentity).toHaveBeenCalledTimes(2);
    expect(f.readFile.mock.calls.map((call) => call[1])).toEqual([
      buildPath,
      buildPath,
      settingsPath,
      settingsPath,
    ]);
    expect(f.queries[0]).toContain('pg_try_advisory_lock_shared');
    expect(f.queries.at(-1)).toContain('pg_advisory_unlock_shared');
    await f.db.destroy();
  });

  it('does not read files for other games, active jobs, installation, deleted, manual or non-sleeping states', async () => {
    for (const patch of [
      { game_id: 'minecraft' },
      { installation_state: 'installing' },
      { active_operation_id: 'job' },
      { runtime_state: 'running' },
      { gatewayState: 'waking' },
      { intent: 'manually_stopped' },
      { intent: 'maintenance' },
      { gatewayEnabled: false },
      { automatic_starts_paused: true },
      { deleted_at: new Date() },
    ]) {
      const f = fixture();
      Object.assign(f.server, patch);
      expect(await f.read()).toBeUndefined();
      expect(f.readFile).not.toHaveBeenCalled();
      await f.db.destroy();
    }
    const f = fixture();
    f.control.activeJob = true;
    expect(await f.read()).toBeUndefined();
    expect(f.readFile).not.toHaveBeenCalled();
    await f.db.destroy();
  });

  it('refuses unavailable locks and revoked identity without filesystem access', async () => {
    const f = fixture();
    f.control.locked = false;
    expect(await f.read()).toBeUndefined();
    expect(f.getApplicationServer).not.toHaveBeenCalled();
    expect(f.queries.some((query) => query.includes('unlock'))).toBe(false);
    f.control.locked = true;
    vi.mocked(verifyManagedIdentity).mockRejectedValueOnce(new Error('private provider details'));
    expect(await f.read()).toBeUndefined();
    expect(f.readFile).not.toHaveBeenCalled();
    expect(f.queries.at(-1)).toContain('pg_advisory_unlock_shared');
    await f.db.destroy();
  });

  it('requires stopped proof and an unambiguous valid game allocation before reading', async () => {
    const stopped = fixture();
    stopped.confirmStopped.mockResolvedValue(false);
    expect(await stopped.read()).toBeUndefined();
    expect(stopped.readFile).not.toHaveBeenCalled();
    await stopped.db.destroy();
    for (const port of [0, 65536, 1.5]) {
      const invalid = fixture();
      invalid.allocation.port = port;
      expect(await invalid.read()).toBeUndefined();
      expect(invalid.readFile).not.toHaveBeenCalled();
      await invalid.db.destroy();
    }
    const duplicate = fixture();
    const list = duplicate.entries.get('.config/Epic/FactoryGame/Saved/SaveGames');
    if (!list?.[0]) throw new Error('fixture');
    list.push({ ...list[0] });
    expect(await duplicate.read()).toBeUndefined();
    await duplicate.db.destroy();
  });

  it('coalesces overlapping identical authority reads, clones each result and never caches settled reads', async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 40 }, () => f.read()));
    expect(results.every(Boolean)).toBe(true);
    expect(f.readFile).toHaveBeenCalledTimes(4);
    expect(f.confirmStopped).toHaveBeenCalledTimes(2);
    expect(verifyManagedIdentity).toHaveBeenCalledTimes(2);
    expect(f.queries.filter((query) => query.includes('pg_try_advisory_lock_shared'))).toHaveLength(
      1,
    );
    expect(results[0]).not.toBe(results[1]);
    expect(results[0]?.credentials).not.toBe(results[1]?.credentials);
    if (!results[0]) throw new Error('fixture');
    results[0].credentials.serverSecret = 'caller-local mutation';
    expect(results[1]?.credentials.serverSecret).toBe(native.serverSecret);
    expect(await f.read()).toBeDefined();
    expect(f.readFile).toHaveBeenCalledTimes(8);
    await f.db.destroy();
  });

  it('caps distinct authority work at two before connection acquisition, without queuing unrelated reads', async () => {
    const first = fixture(),
      second = fixture(),
      third = fixture();
    const acquired = [first, second, third].map((f) => vi.spyOn(f.db, 'connection'));
    let releaseFirst!: () => void, releaseSecond!: () => void;
    const gateFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const gateSecond = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    first.confirmStopped.mockImplementationOnce(async () => {
      await gateFirst;
      return true;
    });
    second.confirmStopped.mockImplementationOnce(async () => {
      await gateSecond;
      return false;
    });
    const a = first.read(),
      b = second.read();
    try {
      expect(await third.read()).toBeUndefined();
      expect(acquired[2]).not.toHaveBeenCalled();
      expect(third.queries).toHaveLength(0);
      await third.db.selectFrom('operation_jobs').select('id').execute();
      expect(third.queries).toHaveLength(1);
      releaseSecond();
      expect(await b).toBeUndefined();
      expect(await third.read()).toBeDefined();
      expect(acquired[2]).toHaveBeenCalledTimes(1);
      releaseFirst();
      expect(await a).toBeDefined();
      expect(await first.read()).toBeDefined();
      expect(acquired[0]).toHaveBeenCalledTimes(2);
    } finally {
      releaseFirst();
      releaseSecond();
      await Promise.all([a, b]);
      for (const spy of acquired) spy.mockRestore();
      await Promise.all([first.db.destroy(), second.db.destroy(), third.db.destroy()]);
    }
  });

  it('does not coalesce callers with distinct stop authority callbacks', async () => {
    const f = fixture();
    const good = f.read();
    const refused = readStoppedSatisfactoryCredentials(f.db, 'server', {
      adapter: f.adapter,
      confirmStopped: async () => false,
    });
    expect(await good).toBeDefined();
    expect(await refused).toBeUndefined();
    expect(f.queries.filter((query) => query.includes('pg_try_advisory_lock_shared'))).toHaveLength(
      2,
    );
    await f.db.destroy();
  });

  it('rejects symlink ancestors and files, missing files and oversized settings', async () => {
    for (const directory of [
      '',
      '.config',
      '.config/Epic',
      '.config/Epic/FactoryGame',
      '.config/Epic/FactoryGame/Saved',
      '.config/Epic/FactoryGame/Saved/SaveGames',
    ]) {
      const f = fixture();
      const target = f.entries
        .get(directory)
        ?.find((entry) => directory !== '' || entry.name === '.config');
      if (!target) throw new Error('fixture');
      target.is_symlink = true;
      expect(await f.read()).toBeUndefined();
      expect(f.readFile.mock.calls.some((call) => call[1] === settingsPath)).toBe(false);
      await f.db.destroy();
    }
    const f = fixture();
    f.entries.set('.config/Epic/FactoryGame/Saved/SaveGames', []);
    expect(await f.read()).toBeUndefined();
    await f.db.destroy();
    const large = fixture();
    const entry = large.entries.get('.config/Epic/FactoryGame/Saved/SaveGames')?.[0];
    if (!entry) throw new Error('fixture');
    entry.size = 256 * 1024 + 1;
    expect(await large.read()).toBeUndefined();
    await large.db.destroy();
  });

  it('rejects file bytes or metadata changing between reads and unsupported build/decoder results', async () => {
    const f = fixture();
    let reads = 0;
    f.readFile.mockImplementation(async (_id, path) => {
      if (path === settingsPath && ++reads === 2) return Buffer.from('changed-native-settings!');
      return Buffer.from(f.contents.get(path) as Buffer);
    });
    expect(await f.read()).toBeUndefined();
    await f.db.destroy();
    const meta = fixture();
    meta.readFile.mockImplementation(async (_id, path) => {
      if (path === settingsPath) {
        const entry = meta.entries.get('.config/Epic/FactoryGame/Saved/SaveGames')?.[0];
        if (entry) entry.modified_at = 'changed';
      }
      return Buffer.from(meta.contents.get(path) as Buffer);
    });
    expect(await meta.read()).toBeUndefined();
    await meta.db.destroy();
    const version = fixture();
    version.contents.set(buildPath, Buffer.from('{"Changelist":513886}'));
    expect(await version.read()).toBeUndefined();
    await version.db.destroy();
    const invalid = fixture();
    vi.mocked(decodeSatisfactoryNativeCredentials).mockReturnValueOnce(undefined);
    expect(await invalid.read()).toBeUndefined();
    await invalid.db.destroy();
  });

  it('rechecks fresh stop, durable jobs/generation and provider identity after reading; never reuses settled authority', async () => {
    const f = fixture();
    f.confirmStopped.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await f.read()).toBeUndefined();
    await f.db.destroy();
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.control.activeJob = true;
      },
      (f: ReturnType<typeof fixture>) => {
        f.server.generation = '6';
      },
    ]) {
      const current = fixture();
      current.readFile.mockImplementation(async (_id, path) => {
        if (path === settingsPath) mutate(current);
        return Buffer.from(current.contents.get(path) as Buffer);
      });
      expect(await current.read()).toBeUndefined();
      await current.db.destroy();
    }
    const revoked = fixture();
    vi.mocked(verifyManagedIdentity)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('revoked'));
    expect(await revoked.read()).toBeUndefined();
    await revoked.db.destroy();
    const fresh = fixture();
    expect(await fresh.read()).toBeDefined();
    fresh.confirmStopped.mockResolvedValue(false);
    expect(await fresh.read()).toBeUndefined();
    expect(fresh.confirmStopped).toHaveBeenCalledTimes(3);
    await fresh.db.destroy();
  });
});
