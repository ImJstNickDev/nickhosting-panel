import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DomainError } from '@nickhosting/core';
import type {
  PterodactylAdapter,
  ServerFile,
  UploadProxyOptions,
} from '@nickhosting/pterodactyl-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishExtractedFiles } from './file-extraction-publication.js';

const stages: string[] = [];
afterEach(async () => {
  await Promise.all(stages.splice(0).map((stage) => rm(stage, { recursive: true, force: true })));
});
async function fixture(n: number) {
  const stage = await mkdtemp(join(tmpdir(), 'nh-extraction-test-'));
  stages.push(stage);
  const local = join(stage, 'data');
  await writeFile(local, 'abc');
  const files = Array.from({ length: n }, (_, i) => ({ path: `${i}.txt`, size: 3, local }));
  const entries: ServerFile[] = [];
  const directory = { name: 'out', is_file: false, is_symlink: false } as ServerFile;
  const listFiles = vi.fn(async (_id: string, path: string) =>
    path === '' ? [directory] : entries.slice(),
  );
  const sent: string[] = [];
  const uploads = (paths: string[]) =>
    paths.map((path) => async (input: UploadProxyOptions) => {
      await input.authorize?.();
      expect(await new Response(input.body).text()).toBe('abc');
      sent.push(path);
      entries.push({ ...directory, name: basename(path), is_file: true });
    });
  const prepareUploadBatch = vi.fn<PterodactylAdapter['prepareUploadBatch']>(
    async (_id, paths, opts) => {
      await opts?.readDirectory?.('out');
      return { expiresAt: Date.now() + 10_000, uploads: uploads(paths) };
    },
  );
  const prepareUpload = vi.fn<PterodactylAdapter['prepareUpload']>(async (_id, path, opts) => {
    await opts?.readDirectory?.('out');
    const send = uploads([path])[0];
    if (!send) throw Error('fixture');
    return send;
  });
  const adapter = { listFiles, prepareUploadBatch, prepareUpload } as unknown as PterodactylAdapter;
  const claim = {
    complete: vi.fn(async () => {}),
    rejectBeforeDispatch: vi.fn(async () => {}),
    unlock: vi.fn(async () => {}),
  };
  const reserve = vi.fn(async (_bytes: number, _largest: number, _count: number) => claim);
  const signal = new AbortController(),
    authorize = vi.fn(async () => {}),
    completed = vi.fn(),
    guard = vi.fn(async (_paths: string[]) => {});
  const options = {
    adapter,
    id: 'fixture',
    destination: 'out',
    files,
    concurrency: 4,
    batchBytes: 4096,
    signal: signal.signal,
    authorize,
    guard,
    reserve,
    completed,
  };
  return {
    options,
    claim,
    prepareUploadBatch,
    prepareUpload,
    entries,
    sent,
    listFiles,
    signal,
    run: () => publishExtractedFiles(options),
  };
}
describe('validated extraction publication', () => {
  it.each([100, 1000])(
    'reserves and guards sibling groups and publishes every byte for %i files',
    async (n) => {
      const f = await fixture(n);
      await f.run();
      expect(f.sent).toHaveLength(n);
      expect(f.prepareUploadBatch).toHaveBeenCalledTimes(n / 4);
      expect(f.listFiles).toHaveBeenCalledTimes(n);
      expect(
        f.options.reserve.mock.calls.every(
          ([bytes, largest, count]) => bytes === 12 && largest === 3 && count === 4,
        ),
      ).toBe(true);
      expect(f.claim.complete).toHaveBeenCalledTimes(n / 4);
      expect(f.claim.unlock).toHaveBeenCalledTimes(n / 4);
      expect(f.claim.rejectBeforeDispatch).not.toHaveBeenCalled();
    },
  );
  it('uses native grants sharing a fresh sibling listing when the batch endpoint is unavailable', async () => {
    const f = await fixture(8);
    f.prepareUploadBatch.mockResolvedValue(null);
    await f.run();
    expect(f.sent).toHaveLength(8);
    expect(f.prepareUpload).toHaveBeenCalledTimes(8);
    expect(f.listFiles).toHaveBeenCalledTimes(8);
  });
  it('splits an unreserved group when admission only admits one transfer', async () => {
    const f = await fixture(4);
    f.options.reserve.mockImplementation(async (_bytes, _largest, count) => {
      if (count > 1) throw new DomainError('resources_unavailable');
      return f.claim;
    });
    await f.run();
    expect(f.claim.complete).toHaveBeenCalledTimes(4);
    expect(f.sent).toHaveLength(4);
  });
  it('detects a new conflicting name between preparation and dispatch', async () => {
    const f = await fixture(4);
    const prepare = f.prepareUploadBatch.getMockImplementation();
    if (!prepare) throw Error('fixture');
    f.prepareUploadBatch.mockImplementation(async (...args) => {
      const result = await prepare(...args);
      f.entries.push({ name: '2.TXT', is_file: true, is_symlink: false } as ServerFile);
      return result;
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'conflict' });
    expect(f.sent).toHaveLength(0);
    expect(f.claim.rejectBeforeDispatch).toHaveBeenCalledOnce();
    expect(f.claim.unlock).toHaveBeenCalledOnce();
  });
  it('rechecks authorization after grants and treats cancellation as not dispatched', async () => {
    const f = await fixture(4);
    f.prepareUploadBatch.mockImplementation(async () => {
      f.signal.abort();
      return { expiresAt: Date.now(), uploads: Array(4).fill(vi.fn()) };
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.claim.rejectBeforeDispatch).toHaveBeenCalledOnce();
    expect(f.sent).toHaveLength(0);
  });
  it('preserves uncertain claims and confirmed counts on a partial publication', async () => {
    const f = await fixture(4);
    const prepare = f.prepareUploadBatch.getMockImplementation();
    if (!prepare) throw Error('fixture');
    f.prepareUploadBatch.mockImplementation(async (...args) => {
      const batch = await prepare(...args);
      if (!batch) throw Error('fixture');
      batch.uploads[2] = async () => {
        throw new DomainError('operation_uncertain');
      };
      return batch;
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'operation_uncertain' });
    expect(f.options.completed).toHaveBeenCalledTimes(3);
    expect(f.claim.complete).not.toHaveBeenCalled();
    expect(f.claim.rejectBeforeDispatch).not.toHaveBeenCalled();
    expect(f.claim.unlock).toHaveBeenCalledOnce();
  });
});
