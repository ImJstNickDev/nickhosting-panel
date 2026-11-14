import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { GameLifecycleContext } from './lifecycle.js';
import {
  captureSatisfactorySafetySave,
  rotateSatisfactorySafetySaves,
} from './satisfactory-save-retention.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture missing');
  return value;
}
const root = '.config/Epic/FactoryGame/Saved/SaveGames/server';
function fixture() {
  const serverId = randomUUID();
  const files = new Map<string, { data: Buffer; modified: string; symlink?: boolean }>();
  const receipts = Array.from({ length: 7 }, (_, index) => {
    const save_name = `nh-stop-${randomUUID()}`,
      data = Buffer.from(`save ${index}`);
    files.set(`${save_name}.sav`, { data, modified: String(index) });
    return {
      server_id: serverId,
      save_name,
      session_name: 'World',
      job_id: save_name.slice(8),
      path: `${root}/${save_name}.sav`,
      sha256: createHash('sha256').update(data).digest('hex'),
      size: String(data.length),
      modified_at: String(index),
      created_at: new Date(1000 - index),
      deleted_at: null,
    };
  });
  files.set('World_autosave_0.sav', { data: Buffer.from('autosave'), modified: '0' });
  files.set('nh-stop-manual.sav', { data: Buffer.from('manual'), modified: '0' });
  const query = (data: unknown[]) => {
    const q: Record<string, unknown> = { execute: vi.fn(async () => data) };
    for (const key of ['select', 'selectAll', 'where', 'orderBy', 'set', 'values', 'onConflict'])
      q[key] = vi.fn(() => q);
    return q;
  };
  const updates = vi.fn(() => query([])),
    inserts = vi.fn(() => query([]));
  const db = {
    selectFrom: vi.fn((table: string) =>
      query(table === 'satisfactory_safety_saves' ? receipts : []),
    ),
    updateTable: updates,
    insertInto: inserts,
  };
  const adapter = {
    listFiles: vi.fn(async (_identifier: string, directory: string) => {
      if (directory === root)
        return [...files].map(([name, entry]) => ({
          name,
          is_file: true,
          is_symlink: entry.symlink ?? false,
          size: entry.data.length,
          modified_at: entry.modified,
        }));
      const part = root.slice(directory.length ? directory.length + 1 : 0).split('/')[0];
      return [{ name: part, is_file: false, is_symlink: false, size: 0, modified_at: '0' }];
    }),
    downloadFile: vi.fn(async (_identifier: string, path: string) => {
      const data = files.get(path.slice(root.length + 1))?.data;
      if (!data) throw new Error('missing');
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(data);
            controller.close();
          },
        }),
      };
    }),
    deleteFiles: vi.fn(async (_identifier: string, _root: string, names: string[]) => {
      for (const name of names) files.delete(name);
    }),
  };
  const context = {
    db,
    adapter,
    server: { id: serverId, pterodactyl_identifier: 'server' },
    authorize: vi.fn(async () => {}),
    assertStopped: vi.fn(async () => {}),
    event: vi.fn(async () => {}),
    operation: () => ({ job_id: required(receipts[0]).job_id }),
  } as unknown as GameLifecycleContext;
  return { context, files, receipts, adapter, updates, inserts };
}
describe('Satisfactory receipt-guarded save rotation', () => {
  it('deletes only older receipt-matched files, preserving manual, autosave and newest five', async () => {
    const f = fixture();
    await rotateSatisfactorySafetySaves(f.context);
    expect(f.adapter.deleteFiles).toHaveBeenCalledTimes(2);
    for (const receipt of f.receipts.slice(0, 5))
      expect(f.files.has(`${receipt.save_name}.sav`)).toBe(true);
    expect(f.files.has('World_autosave_0.sav')).toBe(true);
    expect(f.files.has('nh-stop-manual.sav')).toBe(true);
    expect(f.context.assertStopped).toHaveBeenCalledTimes(3);
  });
  it('leaves all prior saves untouched when this stop has no fresh captured receipt', async () => {
    const f = fixture();
    f.context.operation = () =>
      ({ job_id: randomUUID() }) as ReturnType<GameLifecycleContext['operation']>;
    await rotateSatisfactorySafetySaves(f.context);
    expect(f.adapter.downloadFile).not.toHaveBeenCalled();
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
  });
  it('preserves user-replaced files even when size and timestamp are identical', async () => {
    const f = fixture();
    for (const receipt of f.receipts.slice(5))
      required(f.files.get(`${receipt.save_name}.sav`)).data = Buffer.from('CHANGED');
    await rotateSatisfactorySafetySaves(f.context);
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
  });
  it('retains all older recovery points when the latest receipt is missing', async () => {
    const f = fixture();
    f.files.delete(`${required(f.receipts[0]).save_name}.sav`);
    await rotateSatisfactorySafetySaves(f.context);
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
  });
  it('does not follow symlinks or delete after stopped proof is lost', async () => {
    const f = fixture();
    required(f.files.get(`${required(f.receipts[5]).save_name}.sav`)).symlink = true;
    vi.mocked(f.context.assertStopped)
      .mockResolvedValueOnce()
      .mockRejectedValue(new Error('running'));
    await rotateSatisfactorySafetySaves(f.context);
    expect(f.adapter.deleteFiles).not.toHaveBeenCalled();
  });
  it('applies environment retention override while bounding each stop to two removals', async () => {
    const f = fixture();
    await rotateSatisfactorySafetySaves(f.context, { SATISFACTORY_SAFETY_SAVE_RETENTION: '1' });
    expect(f.adapter.deleteFiles).toHaveBeenCalledTimes(2);
    expect(f.files.has(`${required(f.receipts[0]).save_name}.sav`)).toBe(true);
  });
  it('continues past missing and changed receipts without counting them as removals', async () => {
    const f = fixture();
    f.files.delete(`${required(f.receipts[1]).save_name}.sav`);
    required(f.files.get(`${required(f.receipts[2]).save_name}.sav`)).data = Buffer.from('CHANGED');
    await rotateSatisfactorySafetySaves(f.context, { SATISFACTORY_SAFETY_SAVE_RETENTION: '1' });
    expect(f.adapter.deleteFiles).toHaveBeenCalledTimes(2);
    expect(f.files.has(`${required(f.receipts[2]).save_name}.sav`)).toBe(true);
    expect(f.files.has(`${required(f.receipts[3]).save_name}.sav`)).toBe(false);
    expect(f.files.has(`${required(f.receipts[4]).save_name}.sav`)).toBe(false);
  });
  it('captures immutable streamed proof only for this operation save', async () => {
    const f = fixture();
    await captureSatisfactorySafetySave(f.context, 'World', required(f.receipts[0]).save_name);
    expect(f.inserts).toHaveBeenCalledWith('satisfactory_safety_saves');
    f.inserts.mockClear();
    await captureSatisfactorySafetySave(f.context, 'World', required(f.receipts[1]).save_name);
    expect(f.inserts).not.toHaveBeenCalled();
    expect(f.context.event).toHaveBeenCalledWith('satisfactory.worlds.retention.capture_skipped');
  });
});
