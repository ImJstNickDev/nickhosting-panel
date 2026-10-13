import { afterEach, describe, expect, it, vi } from 'vitest';
import { readViewerBytes, viewerPath } from './access.js';

afterEach(() => vi.unstubAllGlobals());
describe('shared viewer byte access', () => {
  it('keeps archive members separate from the real path and never builds provider URLs', () => {
    const path = viewerPath('server-id', {
      path: 'world/a b.zip',
      name: 'x.json',
      entry: 'nested/x.json',
      size: 3,
    });
    expect(path).toBe(
      '/v1/servers/server-id/files/viewer/archive/content?path=world%2Fa+b.zip&entry=nested%2Fx.json',
    );
  });
  it('encodes nested containers independently from their member path', () => {
    const url = new URL(
      viewerPath('server-id', {
        path: 'root.zip',
        name: 'text.txt',
        size: 3,
        archives: ['a/inner.zip', 'deep.jar'],
        entry: 'text.txt',
      }),
      'https://panel.invalid',
    );
    expect(url.pathname).toBe('/v1/servers/server-id/files/viewer/archive/content');
    expect(JSON.parse(url.searchParams.get('archives') ?? 'null')).toEqual([
      'a/inner.zip',
      'deep.jar',
    ]);
    expect(url.searchParams.get('path')).toBe('root.zip');
    expect(url.searchParams.get('entry')).toBe('text.txt');
  });
  it('enforces the byte bound even when Content-Length is absent', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(5));
              },
              cancel,
            }),
          ),
      ),
    );
    await expect(
      readViewerBytes('/v1/test', 4, new AbortController().signal),
    ).rejects.toMatchObject({ messageKey: 'viewer.tooLarge' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('passes cancellation and rejects redirects and privileged/external paths', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetch);
    expect(await readViewerBytes('/v1/test', 3, controller.signal)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/v1/test',
      expect.objectContaining({
        credentials: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
      }),
    );
    await expect(
      readViewerBytes('https://provider.invalid/file', 3, controller.signal),
    ).rejects.toThrow('invalid_api_path');
  });
});
