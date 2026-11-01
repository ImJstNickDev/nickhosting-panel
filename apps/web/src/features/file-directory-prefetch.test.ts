import { describe, expect, it } from 'vitest';
import type { DirectoryBatchResult } from '../../../../packages/pterodactyl-adapter/src/directory-batch.js';
import { DirectoryPrefetch } from './file-directory-prefetch.js';
import type { ServerFile } from './service-contracts.js';

function folder(name: string): ServerFile {
  return {
    name,
    is_file: false,
    is_symlink: false,
    size: 0,
    mode: 'drwxr-xr-x',
    mimetype: 'inode/directory',
    created_at: '',
    modified_at: '',
  };
}
async function settle() {
  for (let index = 0; index < 20; index++)
    await new Promise<void>((resolve) => queueMicrotask(resolve));
}
function fixture(children = 10) {
  const cache = new Map<string, ServerFile[]>();
  const calls: string[][] = [];
  const runner = new DirectoryPrefetch({
    read: (path) => cache.get(path),
    fetch: async (paths) => {
      calls.push(paths);
      return paths.map((directory) => ({
        directory,
        files: Array.from({ length: children }, (_, index) => folder(`child-${index}`)),
      }));
    },
    store: (path, files) => {
      cache.set(path, files);
      return true;
    },
  });
  return { runner, calls, cache };
}

describe('silent directory metadata prefetch', () => {
  it('only expands visible roots, at most three levels and 96 paths with bounded batches', async () => {
    const { runner, calls, cache } = fixture(500);
    runner.setVisible(['root/visible-1', 'root/visible-2']);
    await settle();
    const paths = calls.flat();
    expect(paths.length).toBeLessThanOrEqual(96);
    expect(calls.every((batch) => batch.length <= 48)).toBe(true);
    expect(paths.every((path) => path.startsWith('root/visible-'))).toBe(true);
    expect(paths.every((path) => path.split('/').length <= 4)).toBe(true);
    expect(cache.size).toBe(34); // 2 visible roots + 16 children + 16 grandchildren.
    runner.stop();
  });

  it('gives newly scrolled visible folders their reserved budget instead of enumerating offscreen siblings', async () => {
    const { runner, calls } = fixture();
    runner.setVisible(['first']);
    await settle();
    expect(calls.flat().some((path) => path.startsWith('second'))).toBe(false);
    runner.setVisible(['second']);
    await settle();
    expect(calls.flat()).toContain('second');
    runner.setVisible(Array.from({ length: 500 }, (_, index) => `visible-${index}`));
    await settle();
    expect(calls.flat().length).toBeLessThanOrEqual(96);
    expect(new Set(calls.flat()).size).toBe(calls.flat().length);
    runner.stop();
  });

  it('reuses old cached descendants and never refreshes them merely by reentering a folder', async () => {
    const { runner, calls, cache } = fixture();
    cache.set('world', [folder('region')]);
    cache.set('world/region', [folder('nested')]);
    cache.set('world/region/nested', []);
    runner.setVisible(['world']);
    await settle();
    runner.setVisible([]);
    runner.setVisible(['world']);
    await settle();
    expect(calls).toEqual([]);
    runner.stop();
  });

  it('keeps only one batch in flight, cancels on departure and ignores even an uncancellable late response', async () => {
    const pending = Promise.withResolvers<DirectoryBatchResult[]>();
    const calls: string[][] = [];
    const stored: string[] = [];
    let signal: AbortSignal | undefined;
    const runner = new DirectoryPrefetch({
      read: () => undefined,
      fetch: (paths, requestSignal) => {
        calls.push(paths);
        signal = requestSignal;
        return pending.promise;
      },
      store: (path) => {
        stored.push(path);
        return true;
      },
    });
    runner.setVisible(['one']);
    await settle();
    runner.setVisible(['one', 'two']);
    await settle();
    expect(calls).toEqual([['one']]);
    runner.stop();
    expect(signal?.aborted).toBe(true);
    pending.resolve([{ directory: 'one', files: [folder('child')] }]);
    await settle();
    expect(calls).toEqual([['one']]);
    expect(stored).toEqual([]);
  });

  it('stops silently without retrying an unavailable optional batch endpoint', async () => {
    let requests = 0;
    const runner = new DirectoryPrefetch({
      read: () => undefined,
      fetch: async () => {
        requests++;
        throw new Error('unavailable');
      },
      store: () => true,
    });
    runner.setVisible(['one']);
    await settle();
    runner.setVisible(['two']);
    await settle();
    expect(requests).toBe(1);
  });

  it('does not traverse symlinks or unsafe names and ignores per-path errors', async () => {
    const calls: string[][] = [];
    const runner = new DirectoryPrefetch({
      read: () => undefined,
      fetch: async (paths) => {
        calls.push(paths);
        return paths.map((directory) =>
          directory === 'missing'
            ? { directory, error: 'not_found' as const }
            : { directory, files: [folder('../outside'), { ...folder('link'), is_symlink: true }] },
        );
      },
      store: () => true,
    });
    runner.setVisible(['safe', 'missing']);
    await settle();
    expect(calls).toEqual([['safe', 'missing']]);
    runner.stop();
  });
});
