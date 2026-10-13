import {
  type DirectoryBatchResult,
  PterodactylError,
  type ServerFile,
} from '@nickhosting/pterodactyl-adapter';
import { createUploadTiming } from '@nickhosting/server-management';
import { describe, expect, it, vi } from 'vitest';
import { createFileDirectoryPlan, fileDirectoryAncestors } from './file-directory-plan.js';

const file = (name = 'server.properties'): ServerFile => ({
  name,
  mode: '-rw-r--r--',
  size: 100,
  is_file: true,
  is_symlink: false,
  mimetype: 'text/plain',
  created_at: '2026-10-13T00:00:00Z',
  modified_at: '2026-10-13T00:00:00Z',
});
const results = (paths: string[]): DirectoryBatchResult[] =>
  paths.map((directory) => ({ directory, files: [file()] }));
const setup = () => {
  const batch = vi.fn(async (paths: string[]) => results(paths));
  const single = vi.fn(async (_path: string) => [file()]);
  const timing = createUploadTiming();
  return { batch, single, timing, plan: createFileDirectoryPlan({ batch, single, timing }) };
};

describe('operation-local directory metadata', () => {
  it('shares pending and completed reads and batches synchronous consumers once', async () => {
    const { plan, batch, single, timing } = setup();
    const root = plan.list('');
    expect(plan.list('')).toBe(root);
    const world = plan.list('world');
    await Promise.all([root, world]);
    await plan.prime(['world', '', 'world']);
    expect(plan.list('world')).toBe(world);
    expect(batch).toHaveBeenCalledExactlyOnceWith(['', 'world']);
    expect(single).not.toHaveBeenCalled();
    expect(timing.snapshot()['directory.batch']?.count).toBe(1);
    expect(timing.snapshot()['directory.native']).toBeUndefined();
  });

  it('keeps metadata scoped to the current operation', async () => {
    const { batch, single, plan } = setup();
    await plan.list('world');
    await createFileDirectoryPlan({ batch, single }).list('world');
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it('chunks 48 paths and never runs concurrent batch requests', async () => {
    const gate = Promise.withResolvers<void>();
    const { batch, plan } = setup();
    batch.mockImplementationOnce(async (paths) => {
      await gate.promise;
      return results(paths);
    });
    const primed = plan.prime(Array.from({ length: 100 }, (_, index) => `dir${index}`));
    await Promise.resolve();
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toHaveLength(48);
    const late = plan.list('late');
    await Promise.resolve();
    expect(batch).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([primed, late]);
    expect(batch.mock.calls.map(([paths]) => paths.length)).toEqual([48, 48, 5]);
  });

  it.each([
    ['not_found', 'not_found'],
    ['forbidden', 'forbidden'],
    ['unavailable', 'integration_unavailable'],
    ['too_large', 'integration_unavailable'],
    ['deadline_exceeded', 'integration_unavailable'],
  ] as const)('retains a path %s without falling back or repeating it', async (error, code) => {
    const { batch, single, plan } = setup();
    batch.mockResolvedValueOnce([
      { directory: '', files: [file()] },
      { directory: 'world', error },
    ]);
    const root = plan.list('');
    const world = plan.list('world');
    await expect(root).resolves.toEqual([file()]);
    await expect(world).rejects.toMatchObject({ code });
    expect(plan.list('world')).toBe(world);
    await expect(plan.list('world')).rejects.toMatchObject({ code });
    expect(single).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it.each([404, 405])(
    'uses two native workers only when the optional batch endpoint returns %s',
    async (status) => {
      const { batch, single, plan, timing } = setup();
      batch.mockRejectedValueOnce(new PterodactylError('not_found', 'client', 'rejected', status));
      let active = 0;
      let maximum = 0;
      const gate = Promise.withResolvers<void>();
      single.mockImplementation(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await gate.promise;
        active--;
        return [file()];
      });
      const reads = plan.prime(['', 'a', 'b', 'c']);
      await vi.waitFor(() => expect(single).toHaveBeenCalledTimes(2));
      gate.resolve();
      await reads;
      await plan.list('d');
      expect(maximum).toBe(2);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(single).toHaveBeenCalledTimes(5);
      expect(timing.snapshot()['directory.native']?.count).toBe(5);
    },
  );

  it.each([401, 403, 409, 429, 500])(
    'does not downgrade a batch HTTP %s into native reads',
    async (status) => {
      const { batch, single, plan } = setup();
      const error = new PterodactylError('unavailable', 'client', 'rejected', status);
      batch.mockRejectedValueOnce(error);
      await expect(plan.prime(['', 'world'])).rejects.toBe(error);
      await expect(plan.list('later')).rejects.toBe(error);
      expect(single).not.toHaveBeenCalled();
      expect(batch).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects mismatched result identities without native fallback', async () => {
    const { batch, single, plan } = setup();
    batch.mockResolvedValueOnce([{ directory: 'different', files: [] }]);
    await expect(plan.list('world')).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(single).not.toHaveBeenCalled();
  });

  it('waits for all primed reads before propagating a failure', async () => {
    const { batch, single, plan } = setup();
    batch.mockRejectedValueOnce(new PterodactylError('not_found', 'client', 'rejected', 404));
    const gate = Promise.withResolvers<void>();
    single.mockImplementation(async (path) => {
      if (path === 'missing') throw new PterodactylError('not_found', 'client', 'rejected', 404);
      await gate.promise;
      return [file()];
    });
    let completed = false;
    const primed = plan.prime(['missing', 'held']);
    const observed = primed.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    await vi.waitFor(() => expect(single).toHaveBeenCalledTimes(2));
    expect(completed).toBe(false);
    gate.resolve();
    await expect(primed).rejects.toMatchObject({ code: 'not_found' });
    await observed;
    expect(completed).toBe(true);
  });

  it('maps native path errors and caches the failure', async () => {
    const { batch, single, plan } = setup();
    batch.mockRejectedValueOnce(new PterodactylError('not_found', 'client', 'rejected', 404));
    single.mockRejectedValueOnce(new PterodactylError('not_found', 'client', 'rejected', 404));
    await expect(plan.list('world')).rejects.toMatchObject({ code: 'not_found' });
    await expect(plan.list('world')).rejects.toMatchObject({ code: 'not_found' });
    expect(single).toHaveBeenCalledTimes(1);
  });

  it('validates every seed before dispatching and bounds directory count', async () => {
    const { batch, plan } = setup();
    for (const unsafe of [
      '../world',
      'a/../b',
      '/world',
      'world/',
      'a\\b',
      '%2fetc',
      'a\u0000b',
      'é'.repeat(2049),
    ]) {
      await expect(plan.prime(['world', unsafe])).rejects.toMatchObject({
        code: 'validation_failed',
      });
    }
    await expect(
      plan.prime(Array.from({ length: 20_001 }, (_, index) => `dir${index}`)),
    ).rejects.toMatchObject({ code: 'validation_failed', status: 413 });
    expect(batch).not.toHaveBeenCalled();
  });

  it('rejects oversized individual batches before retaining their metadata', async () => {
    const { batch, plan } = setup();
    const files = Array.from({ length: 2100 }, () => file('x'.repeat(4096)));
    batch.mockResolvedValueOnce([{ directory: '', files }]);
    await expect(plan.list('')).rejects.toMatchObject({ code: 'integration_unavailable' });
    await expect(plan.list('world')).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it('bounds retained metadata across otherwise valid batches', async () => {
    const { batch, plan } = setup();
    const files = Array.from({ length: 1800 }, () => file('x'.repeat(4096)));
    batch.mockImplementation(async (paths) => paths.map((directory) => ({ directory, files })));
    for (let index = 0; index < 4; index++) await plan.list(`dir${index}`);
    await expect(plan.list('dir4')).rejects.toMatchObject({ code: 'integration_unavailable' });
    await expect(plan.list('dir5')).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(batch).toHaveBeenCalledTimes(5);
  });
});

describe('directory ancestor seeds', () => {
  it('includes root and each directory once without discovering child paths', () => {
    expect(fileDirectoryAncestors(['world/playerdata', 'world', 'mods/config'])).toEqual([
      '',
      'world',
      'world/playerdata',
      'mods',
      'mods/config',
    ]);
    expect(fileDirectoryAncestors([''])).toEqual(['']);
  });

  it('rejects traversal and ambiguous paths before a provider request', () => {
    for (const path of ['../world', 'a//b', '/world', 'world/', 'a%2fb'])
      expect(() => fileDirectoryAncestors([path])).toThrow();
  });
});
