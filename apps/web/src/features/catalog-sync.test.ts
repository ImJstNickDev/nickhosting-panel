import { describe, expect, it, vi } from 'vitest';
import { type CatalogBatch, syncCatalogPages } from './catalog-sync.js';

function batch(version: string, nextCursor: number | null, total = 3): CatalogBatch {
  return { items: [{ version, releaseType: 'release', status: 'registered' }], nextCursor, total };
}
describe('Owner Vanilla catalog discovery', () => {
  it('visits every page sequentially and retains unavailable results as well as registrations', async () => {
    const unavailable = batch('1.0', null);
    unavailable.items = unavailable.items.map((item) => ({ ...item, status: 'unavailable' }));
    const pages = [batch('26.1', 1), batch('1.21.11', 2), unavailable];
    const request = vi.fn(async (cursor: number) => pages[cursor]);
    const progress = vi.fn();
    const result = await syncCatalogPages({
      signal: new AbortController().signal,
      request,
      progress,
    });
    expect(request.mock.calls.map(([cursor]) => cursor)).toEqual([0, 1, 2]);
    expect(progress.mock.calls.map(([value]) => value.items.length)).toEqual([1, 2, 3]);
    expect(result.nextCursor).toBeNull();
    expect(result.items[2]?.status).toBe('unavailable');
  });

  it('resumes the failed page without losing already confirmed results', async () => {
    let saved: CatalogBatch | undefined;
    await expect(
      syncCatalogPages({
        signal: new AbortController().signal,
        request: async (cursor) => {
          if (cursor === 1) throw new Error('offline');
          return batch('26.1', 1, 2);
        },
        progress: (value) => {
          saved = value;
        },
      }),
    ).rejects.toThrow('offline');
    const request = vi.fn(async (_cursor: number) => batch('1.21.11', null, 2));
    const result = await syncCatalogPages({
      signal: new AbortController().signal,
      previous: saved,
      request,
      progress: () => {},
    });
    expect(request.mock.calls[0]?.[0]).toBe(1);
    expect(result.items.map((item) => item.version)).toEqual(['26.1', '1.21.11']);
  });

  it('does not claim a first page completed after cancellation', async () => {
    const controller = new AbortController();
    const progress = vi.fn();
    const request = vi.fn(async () => {
      controller.abort();
      return batch('26.1', 1);
    });
    await expect(
      syncCatalogPages({ signal: controller.signal, request, progress }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it('stops before requesting another page when cancelled after progress', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => batch('26.1', 1));
    let saved: CatalogBatch | undefined;
    await expect(
      syncCatalogPages({
        signal: controller.signal,
        request,
        progress: (value) => {
          saved = value;
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).toHaveBeenCalledOnce();
    expect(saved?.nextCursor).toBe(1);
  });

  it.each([0, 4])(
    'rejects non-progressing or out-of-range cursor %s without looping',
    async (nextCursor) => {
      const request = vi.fn(async () => batch('26.1', nextCursor));
      await expect(
        syncCatalogPages({ signal: new AbortController().signal, request, progress: () => {} }),
      ).rejects.toThrow('invalid_catalog_cursor');
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it('starts a completed discovery from the beginning on an explicit new run', async () => {
    const request = vi.fn(async (_cursor: number) => batch('26.2', null, 1));
    const result = await syncCatalogPages({
      signal: new AbortController().signal,
      previous: batch('26.1', null, 1),
      request,
      progress: () => {},
    });
    expect(request.mock.calls[0]?.[0]).toBe(0);
    expect(result.items.map((item) => item.version)).toEqual(['26.2']);
  });
});
