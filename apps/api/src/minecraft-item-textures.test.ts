import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import {
  MinecraftItemTextureCache,
  type MinecraftTextureArchive,
  type MinecraftTextureJar,
  minecraftTextureIds,
  minecraftTextureJars,
} from './minecraft-item-textures.js';

const jar: MinecraftTextureJar = {
  path: 'mods/fixture.jar',
  size: 100,
  modifiedAt: '2026-11-18T12:00:00Z',
};
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
function image() {
  const png = new PNG({ width: 2, height: 4 });
  png.data.fill(255, 0, 2 * 2 * 4);
  png.data.fill(0, 2 * 2 * 4);
  return PNG.sync.write(png);
}
function fixture(extra: Record<string, Buffer> = {}) {
  const assets: Record<string, Buffer> = {
    'assets/solcarrot/models/item/food_book.json': json({
      parent: 'item/generated',
      textures: { layer0: 'solcarrot:items/food_book' },
    }),
    'assets/solcarrot/textures/items/food_book.png': image(),
    ...extra,
  };
  const close = vi.fn(async () => {});
  const read = vi.fn(async (path: string) => assets[path]);
  const open = vi.fn(
    async (_jar: MinecraftTextureJar, signal: AbortSignal): Promise<MinecraftTextureArchive> => {
      signal.throwIfAborted();
      return { assets: () => Object.keys(assets), read, close };
    },
  );
  return { open, read, close };
}
const signal = () => new AbortController().signal;

describe('bounded installed-mod inventory textures', () => {
  it('resolves the legacy food_book and modern cross-namespace ancestry, caches warm requests and invalidates changed installs', async () => {
    const f = fixture({
      'assets/example/items/guide.json': json({
        model: { type: 'minecraft:model', model: 'example:item/guide' },
      }),
      'assets/example/models/item/guide.json': json({ parent: 'solcarrot:item/food_book' }),
    });
    const cache = new MinecraftItemTextureCache();
    const result = await cache.resolve(
      'server-a',
      [jar],
      ['solcarrot:food_book', 'example:guide'],
      f.open,
      signal(),
    );
    expect(Object.keys(result).sort()).toEqual(['example:guide', 'solcarrot:food_book']);
    expect(f.open).toHaveBeenCalledTimes(2); // one catalogue scan, one shared render handle
    expect(result['example:guide']).toBe(result['solcarrot:food_book']);
    const png = PNG.sync.read(
      Buffer.from(result['solcarrot:food_book']?.split(',')[1] ?? '', 'base64'),
    );
    expect([png.width, png.height]).toEqual([2, 2]);
    expect([...png.data]).toEqual(Array(16).fill(255));
    const reads = f.read.mock.calls.length,
      opens = f.open.mock.calls.length;
    expect(
      await cache.resolve('server-a', [jar], ['solcarrot:food_book'], f.open, signal()),
    ).toEqual({ 'solcarrot:food_book': result['solcarrot:food_book'] });
    expect(f.read).toHaveBeenCalledTimes(reads);
    expect(f.open).toHaveBeenCalledTimes(opens);
    await cache.resolve(
      'server-a',
      [{ ...jar, modifiedAt: '2026-11-18T12:01:00Z' }],
      ['solcarrot:food_book'],
      f.open,
      signal(),
    );
    expect(f.open.mock.calls.length).toBeGreaterThan(opens);
    expect(f.close.mock.calls.length).toBe(f.open.mock.calls.length);
    expect(await cache.resolve('server-a', [], ['solcarrot:food_book'], f.open, signal())).toEqual(
      {},
    );
  });

  it('prepares once, reuses PNGs after restart and scans only a replaced jar', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nh-textures-'));
    const original = new MinecraftItemTextureCache(directory);
    const restarted = new MinecraftItemTextureCache(directory);
    const f = fixture();
    const empty = { ...jar, path: 'mods/empty.jar' };
    const open = vi.fn(async (file: MinecraftTextureJar, s: AbortSignal) =>
      file.path === jar.path
        ? f.open(file, s)
        : { assets: () => [], read: async () => undefined, close: async () => {} },
    );
    try {
      await original.resolve('server', [jar, empty], [], open, signal());
      expect(open).toHaveBeenCalledTimes(2);
      const result = await original.resolve(
        'server',
        [jar, empty],
        ['solcarrot:food_book'],
        open,
        signal(),
      );
      expect(result['solcarrot:food_book']).toMatch(/^data:image\/png/);
      expect(open).toHaveBeenCalledTimes(3);
      await original.close();
      open.mockClear();
      expect(
        await restarted.resolve('server', [jar, empty], ['solcarrot:food_book'], open, signal()),
      ).toEqual(result);
      await restarted.resolve('server', [jar, empty], [], open, signal());
      expect(open).not.toHaveBeenCalled();
      const changed = { ...empty, size: empty.size + 1 };
      await restarted.resolve('server', [jar, changed], [], open, signal());
      expect(open.mock.calls.map(([file]) => file)).toEqual([changed]);
    } finally {
      await original.close();
      await restarted.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('loads prepared PNGs while a cold archive scan is blocked and resumes background baking after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nh-textures-'));
    const first = new MinecraftItemTextureCache(directory);
    const next = new MinecraftItemTextureCache(directory);
    const f = fixture({
      'assets/solcarrot/models/item/guide.json': json({ parent: 'solcarrot:item/food_book' }),
    });
    const gate = Promise.withResolvers<void>();
    try {
      expect(
        await first.resolvePrepared('server', [jar], ['solcarrot:guide'], f.open, signal()),
      ).toBeUndefined();
      expect(f.open).not.toHaveBeenCalled();
      await first.resolve('server', [jar], [], f.open, signal());
      expect(await first.prepareNext('server', [jar], f.open, signal(), undefined, 1)).toBe(true);
      await first.close();
      const db = new DatabaseSync(join(directory, 'minecraft-inventory', 'cache-v1.sqlite'));
      db.exec("DELETE FROM entries WHERE value LIKE '[%'");
      db.close();
      const entered = Promise.withResolvers<void>();
      const blocked = next.resolve(
        'server',
        [jar],
        [],
        async (jar, s) => {
          entered.resolve();
          await gate.promise;
          return f.open(jar, s);
        },
        signal(),
      );
      await entered.promise;
      f.open.mockClear();
      const cached = await next.resolvePrepared(
        'server',
        [jar],
        ['solcarrot:food_book'],
        f.open,
        signal(),
      );
      expect(cached?.['solcarrot:food_book']).toMatch(/^data:image\/png/);
      const partial = vi.fn();
      expect(
        await next.resolvePrepared(
          'server',
          [jar],
          ['solcarrot:guide', 'solcarrot:food_book'],
          f.open,
          signal(),
          undefined,
          partial,
        ),
      ).toBeUndefined();
      expect(partial).toHaveBeenCalledExactlyOnceWith(cached);
      expect(f.open).not.toHaveBeenCalled();
      gate.resolve();
      await blocked;
      f.open.mockClear();
      expect(await next.prepareNext('server', [jar], f.open, signal(), undefined, 1)).toBe(false);
      expect(f.open).toHaveBeenCalledTimes(1);
      expect(
        await next.resolvePrepared('server', [jar], ['solcarrot:guide'], f.open, signal()),
      ).toHaveProperty('solcarrot:guide');
      expect(f.open).toHaveBeenCalledTimes(1);
      expect(await next.prepareNext('server', [jar], f.open, signal())).toBe(false);
    } finally {
      gate.resolve();
      await first.close();
      await next.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses versioned vanilla resources behind mod overrides and preserves ambiguous paths', async () => {
    const f = fixture({
      'assets/example/models/item/soil.json': json({
        parent: 'item/generated',
        textures: { layer0: 'minecraft:block/terracotta' },
      }),
    });
    const baseAssets: Record<string, Buffer> = {
      'assets/minecraft/models/item/terracotta.json': json({
        parent: 'item/generated',
        textures: { layer0: 'minecraft:block/terracotta' },
      }),
      'assets/minecraft/textures/block/terracotta.png': image(),
    };
    const vanilla = {
      revision: '1.16.5:first',
      has: (name: string) => Object.hasOwn(baseAssets, name),
      read: vi.fn(async (name: string) => baseAssets[name]),
    };
    const cache = new MinecraftItemTextureCache();
    const ids = ['example:soil'];
    expect(
      await cache.resolvePrepared(
        'vanilla',
        [],
        ['minecraft:terracotta'],
        f.open,
        signal(),
        vanilla,
      ),
    ).toHaveProperty('minecraft:terracotta');
    expect(f.open).not.toHaveBeenCalled();
    expect(await cache.resolve('server', [jar], ids, f.open, signal())).toEqual({});
    expect(await cache.resolve('server', [jar], ids, f.open, signal(), vanilla)).toHaveProperty(
      'example:soil',
    );
    expect(vanilla.read).toHaveBeenCalledWith(
      'assets/minecraft/textures/block/terracotta.png',
      512 * 1024,
    );
    const override = { ...jar, path: 'mods/override.jar' };
    const open = async (file: MinecraftTextureJar, s: AbortSignal) =>
      file.path === jar.path
        ? f.open(file, s)
        : {
            assets: () => ['assets/minecraft/textures/block/terracotta.png'],
            read: async () => Buffer.from('broken'),
            close: async () => {},
          };
    vanilla.read.mockClear();
    expect(await cache.resolve('server', [jar, override], ids, open, signal(), vanilla)).toEqual(
      {},
    );
    expect(
      await cache.resolve(
        'server',
        [jar, override, { ...override, path: 'mods/other.jar' }],
        ids,
        open,
        signal(),
        vanilla,
      ),
    ).toEqual({});
    expect(vanilla.read).not.toHaveBeenCalledWith(
      'assets/minecraft/textures/block/terracotta.png',
      512 * 1024,
    );
  });

  it('rejects path inputs and preserves fallback for ambiguous, cyclic, custom and invalid resources', async () => {
    for (const id of ['../x', 'solcarrot:../x', 'solcarrot:/x', 'solcarrot:x//y', 'no_namespace'])
      expect(() => minecraftTextureIds(id)).toThrow();
    expect(() => minecraftTextureIds(Array(65).fill('a:x').join(','))).toThrow();
    expect(minecraftTextureIds('a:x,a:x')).toEqual(['a:x']);
    expect(
      minecraftTextureJars([
        { name: 'disabled.jar.disabled', kind: 'file', size: 1 },
        { name: 'unsafe.jar', kind: 'symlink', size: 1 },
      ]),
    ).toEqual([]);
    const f = fixture({
      'assets/example/models/item/cycle.json': json({ parent: 'example:item/cycle' }),
      'assets/example/models/item/custom.json': json({
        parent: 'item/generated',
        loader: 'example:special',
        textures: { layer0: 'solcarrot:items/food_book' },
      }),
      'assets/example/models/item/broken.json': json({
        parent: 'item/generated',
        textures: { layer0: 'example:item/broken' },
      }),
      'assets/example/textures/item/broken.png': image().subarray(0, 33),
    });
    const cache = new MinecraftItemTextureCache();
    expect(
      await cache.resolve(
        'server',
        [jar],
        ['example:cycle', 'example:custom', 'example:broken'],
        f.open,
        signal(),
      ),
    ).toEqual({});
    expect(
      await cache.resolve(
        'other',
        [jar, { ...jar, path: 'mods/duplicate.jar' }],
        ['solcarrot:food_book'],
        f.open,
        signal(),
      ),
    ).toEqual({});
  });

  it('applies the response budget to warm and mixed cached textures as well as cold batches', async () => {
    const png = new PNG({ width: 256, height: 256 });
    png.data = randomBytes(png.data.length);
    const assets: Record<string, Buffer> = {
      'assets/example/textures/item/large.png': PNG.sync.write(png),
    };
    const ids = Array.from({ length: 16 }, (_, index) => `example:item_${index}`);
    for (const id of ids)
      assets[`assets/example/models/item/${id.split(':')[1]}.json`] = json({
        parent: 'item/generated',
        textures: { layer0: 'example:item/large' },
      });
    const f = fixture(assets),
      cache = new MinecraftItemTextureCache();
    await cache.resolve('large', [jar], ids.slice(0, 8), f.open, signal());
    await expect(cache.resolve('large', [jar], ids, f.open, signal())).rejects.toMatchObject({
      code: 'resources_unavailable',
    });
    const opens = f.open.mock.calls.length;
    await expect(cache.resolve('large', [jar], ids, f.open, signal())).rejects.toMatchObject({
      code: 'resources_unavailable',
    });
    expect(f.open).toHaveBeenCalledTimes(opens);
  });

  it('coalesces cold work while cancelling only the last consumer and never caches cancelled work', async () => {
    const f = fixture();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let sourceSignal: AbortSignal | undefined;
    const open = vi.fn(async (current: MinecraftTextureJar, currentSignal: AbortSignal) => {
      sourceSignal = currentSignal;
      entered.resolve();
      await gate.promise;
      return f.open(current, currentSignal);
    });
    const cache = new MinecraftItemTextureCache();
    const first = new AbortController(),
      second = new AbortController();
    const one = cache.resolve('server', [jar], ['solcarrot:food_book'], open, first.signal);
    const rejected = expect(one).rejects.toThrow();
    await entered.promise;
    const two = cache.resolve('server', [jar], ['solcarrot:food_book'], open, second.signal);
    first.abort(new Error('caller_left'));
    await rejected;
    expect(sourceSignal?.aborted).toBe(false);
    gate.resolve();
    expect(await two).toHaveProperty('solcarrot:food_book');
    expect(open).toHaveBeenCalledTimes(2); // one index, one selected resource render
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      cache.resolve('server', [jar], ['solcarrot:food_book'], open, cancelled.signal),
    ).rejects.toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
    const abandoned = new AbortController();
    const abandonedGate = Promise.withResolvers<void>();
    const abandonedEntered = Promise.withResolvers<void>();
    let abandonedSignal: AbortSignal | undefined;
    const blockedOpen = async (value: MinecraftTextureJar, pendingSignal: AbortSignal) => {
      abandonedSignal = pendingSignal;
      abandonedEntered.resolve();
      await abandonedGate.promise;
      return f.open(value, pendingSignal);
    };
    const pending = cache.resolve(
      'abandoned',
      [jar],
      ['solcarrot:food_book'],
      blockedOpen,
      abandoned.signal,
    );
    const discarded = expect(pending).rejects.toThrow('left');
    await abandonedEntered.promise;
    abandoned.abort(new Error('left'));
    await discarded;
    expect(abandonedSignal?.aborted).toBe(true);
    abandonedGate.resolve();
    expect(
      await cache.resolve('abandoned', [jar], ['solcarrot:food_book'], f.open, signal()),
    ).toHaveProperty('solcarrot:food_book');
  });
});
