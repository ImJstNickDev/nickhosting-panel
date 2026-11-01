import { describe, expect, it, vi } from 'vitest';
import { createPterodactylAdapter } from './adapter.js';

const row = (id: number) => ({ id, ip: '10.20.0.1', port: 10000 + id, assigned: id <= 400 });
const inventory = (rows: ReturnType<typeof row>[], pagination = {}) => ({
  object: 'list',
  data: rows.map((attributes) => ({ attributes })),
  meta: {
    pagination: {
      total: rows.length,
      count: rows.length,
      per_page: 10000,
      current_page: 1,
      total_pages: 1,
      links: { next: 'https://untrusted.example/credentials' },
      ...pagination,
    },
  },
});
const setup = (body: unknown) => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(body));
  return {
    fetcher,
    adapter: createPterodactylAdapter({
      baseURL: 'https://panel.example',
      applicationKey: 'application-fixture',
      clientKey: 'client-fixture',
      fetcher,
    }),
  };
};

describe('complete allocation inventory', () => {
  it('accepts the exact 10000-row bound and rejects an actual 10001-row response', async () => {
    const rows = Array.from({ length: 10000 }, (_, index) => row(index + 1));
    expect(await setup(inventory(rows)).adapter.listAllocations(7)).toHaveLength(10000);
    await expect(
      setup(inventory([...rows, row(10001)])).adapter.listAllocations(7),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('reads 2400 unique allocations including assigned servers in one bounded request', async () => {
    const rows = Array.from({ length: 2400 }, (_, index) => row(index + 1));
    const { adapter, fetcher } = setup(inventory(rows));
    expect(await adapter.listAllocations(7)).toEqual(rows);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0];
    if (!call) throw new Error('Expected inventory request');
    const [url, options] = call;
    expect(String(url)).toBe(
      'https://panel.example/api/application/nodes/7/allocations?per_page=10000&page=1',
    );
    expect(options?.method).toBe('GET');
    expect(options?.redirect).toBe('error');
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer application-fixture');
  });

  it.each([0, 1])(
    'accepts an explicitly complete empty inventory (pages=%i)',
    async (total_pages) => {
      expect(await setup(inventory([], { total_pages })).adapter.listAllocations(7)).toEqual([]);
    },
  );

  it.each([
    ['duplicate IDs despite matching counts', inventory([row(1), row(1)])],
    ['missing row after inventory changes', inventory([row(1)], { total: 2 })],
    ['extra row after inventory changes', inventory([row(1)], { total: 0 })],
    ['incorrect count', inventory([row(1)], { count: 0 })],
    [
      'provider clamps page size',
      inventory([row(1)], { total: 2400, total_pages: 24, per_page: 100 }),
    ],
    ['inventory beyond bounded limit', inventory([row(1)], { total: 10001, total_pages: 2 })],
    ['wrong current page', inventory([row(1)], { current_page: 2 })],
    ['nonempty inventory with zero pages', inventory([row(1)], { total_pages: 0 })],
    ['impossible page size', inventory([row(1), row(2)], { per_page: 1 })],
    ['missing completion metadata', { object: 'list', data: [{ attributes: row(1) }] }],
    ['invalid allocation', inventory([{ ...row(1), port: 70000 }])],
  ])('fails closed: %s', async (_label, body) => {
    const { adapter, fetcher } = setup(body);
    await expect(adapter.listAllocations(7)).rejects.toMatchObject({
      reason: 'invalid_response',
      scope: 'application',
      outcome: 'rejected',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects overlarge responses without returning a partial inventory', async () => {
    const body = inventory([row(1)]);
    const { adapter } = setup({ ...body, untrusted: 'x'.repeat(4 * 1024 * 1024) });
    await expect(adapter.listAllocations(7)).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('validates the node before making a request', async () => {
    const { adapter, fetcher } = setup(inventory([]));
    await expect(adapter.listAllocations(-1)).rejects.toMatchObject({ code: 'validation_failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
