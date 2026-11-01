import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../api/client.js';
import { archiveQuery } from './core/archive-query.js';
import type { ViewerSource } from './core/registry.js';
import {
  createGameViewerHost,
  gameViewerArchiveSource,
  gameViewerReadLimit,
} from './game-viewer-host.js';

const source: ViewerSource = { path: 'mods/example.jar', name: 'example.jar', size: 1200 };
const scopes: ReturnType<typeof createGameViewerHost>[] = [];
const signal = () => new AbortController().signal;
function scope(overrides: Partial<Parameters<typeof createGameViewerHost>[0]> = {}) {
  const value = createGameViewerHost({
    source,
    serverId: 'test-server',
    identity: 'test-identity',
    t: (key) => key,
    onViewerChange: vi.fn(),
    ...overrides,
  });
  scopes.push(value);
  return value;
}
afterEach(() => {
  for (const value of scopes.splice(0)) value.dispose();
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('shared integration viewer host', () => {
  it('reuses Atlas metadata without fetching or recursing and keeps partial pages explicit', async () => {
    const query = archiveQuery('test-server', 'test-identity', source);
    const entries = [
      { name: 'fabric.mod.json', path: 'fabric.mod.json', directory: false, size: 42 },
    ];
    queryClient.setQueryData(query.queryKey, { total: 250, entries });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await scope().host.archive.list('', signal())).toEqual({ total: 250, entries });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('narrows a listing through the existing index without a new transport or cache namespace', async () => {
    const fetcher = vi.fn(
      async (_url: string, _options?: RequestInit) =>
        new Response(JSON.stringify({ entries: [], total: 0 })),
    );
    vi.stubGlobal('fetch', fetcher);
    const host = scope().host;
    await host.archive.list('META-INF', signal(), 'mods.toml');
    await host.archive.list('META-INF', signal(), 'mods.toml');
    expect(fetcher).toHaveBeenCalledOnce();
    const url = new URL(fetcher.mock.calls[0]?.[0] as string, 'https://panel.invalid');
    expect(url.pathname).toBe('/v1/servers/test-server/files/viewer/archive');
    expect(url.searchParams.get('path')).toBe(source.path);
    expect(url.searchParams.get('directory')).toBe('META-INF');
    expect(url.searchParams.get('query')).toBe('mods.toml');
    expect(url.searchParams.get('limit')).toBe('200');
  });

  it('reads only a selected member, preserving physical and nested archive namespaces', async () => {
    const nested = {
      ...source,
      path: 'pack.zip',
      archives: ['inner.zip'],
      entry: 'mods/example.jar',
    };
    const expected = { ...nested, archives: ['inner.zip', 'mods/example.jar'], entry: undefined };
    expect(gameViewerArchiveSource(nested)).toEqual(expected);
    expect(nested.archives).toEqual(['inner.zip']);
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => new Response('metadata'));
    vi.stubGlobal('fetch', fetcher);
    const bytes = await scope({ source: nested }).host.archive.read(
      'fabric.mod.json',
      100,
      signal(),
    );
    expect(new TextDecoder().decode(bytes)).toBe('metadata');
    const url = new URL(fetcher.mock.calls[0]?.[0] as string, 'https://panel.invalid');
    expect(url.pathname).toBe('/v1/servers/test-server/files/viewer/archive/content');
    expect(url.searchParams.get('path')).toBe('pack.zip');
    expect(JSON.parse(url.searchParams.get('archives') ?? 'null')).toEqual([
      'inner.zip',
      'mods/example.jar',
    ]);
    expect(url.searchParams.get('entry')).toBe('fabric.mod.json');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'same-origin',
      redirect: 'error',
    });
  });

  it('enforces bounds and relative archive paths before I/O, including streamed oversized content', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array(5)));
    vi.stubGlobal('fetch', fetcher);
    const host = scope().host;
    for (const maxBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, gameViewerReadLimit + 1])
      await expect(host.archive.read('icon.png', maxBytes, signal())).rejects.toThrow();
    for (const path of ['../x', '/x', 'https://host/x', 'a\\b', 'a//b', 'a/./b', 'a\0b'])
      await expect(host.archive.read(path, 100, signal())).rejects.toThrow();
    await expect(host.archive.list('..', signal())).rejects.toThrow();
    await expect(host.archive.list('', signal(), 'x'.repeat(257))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(host.archive.read('icon.png', 4, signal())).rejects.toMatchObject({
      messageKey: 'viewer.tooLarge',
    });
  });

  it('cancels one listing subscriber without cancelling another shared reader', async () => {
    let respond!: (response: Response) => void;
    const fetcher = vi.fn(
      (_url: string, _options?: RequestInit) =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const first = scope().host.archive.list('', controller.signal);
    const second = scope().host.archive.list('', signal());
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    respond(new Response(JSON.stringify({ total: 0, entries: [] })));
    expect(await second).toEqual({ total: 0, entries: [] });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('aborts in-flight bytes and blocks reads and navigation after the mounted scope exits', async () => {
    const fetcher = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const value = scope();
    const read = value.host.archive.read('icon.png', 100, signal());
    value.dispose();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    await expect(value.host.archive.read('icon.png', 100, signal())).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(value.host.archive.list('', signal())).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(() => value.host.openViewer('archive')).toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('permits known Open With fallback while refusing arbitrary or foreign viewer identifiers', () => {
    const onViewerChange = vi.fn();
    const host = scope({ onViewerChange }).host;
    host.openViewer('archive');
    expect(onViewerChange).toHaveBeenCalledWith('archive');
    expect(() => host.openViewer('other-game:unknown')).toThrow('unavailable_viewer');
    expect(() => host.openViewer('https://example.invalid/module.js')).toThrow(
      'unavailable_viewer',
    );
    expect(onViewerChange).toHaveBeenCalledOnce();
  });
});
