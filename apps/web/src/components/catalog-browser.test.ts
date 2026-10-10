import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CatalogBrowser, type CatalogRequest, compareCatalogItems } from './catalog-browser.js';

const entries = [
  { id: 'r', label: '26.1', releaseTime: '2026-03-01T00:00:00Z' },
  { id: 's', label: '26.2-snapshot-1', releaseTime: '2026-04-01T00:00:00Z' },
  { id: 'o', label: '1.21.11', releaseTime: '2025-12-01T00:00:00Z' },
  { id: 'u', label: '99.0', releaseTime: null },
];
describe('integration catalog ordering', () => {
  it('mixes snapshots and releases by actual date, with unknown dates last in either direction', () => {
    expect(
      [...entries].sort((a, b) => compareCatalogItems(a, b, 'newest')).map((x) => x.id),
    ).toEqual(['s', 'r', 'o', 'u']);
    expect(
      [...entries].sort((a, b) => compareCatalogItems(a, b, 'oldest')).map((x) => x.id),
    ).toEqual(['o', 'r', 's', 'u']);
  });
  it('supports natural version names independently of dates and deterministic ties', () => {
    expect(
      [...entries].sort((a, b) => compareCatalogItems(a, b, 'name-asc')).map((x) => x.id),
    ).toEqual(['o', 'r', 's', 'u']);
    expect(
      compareCatalogItems({ id: 'a', label: '1.9' }, { id: 'b', label: '1.10' }, 'name-asc'),
    ).toBeLessThan(0);
    expect(
      compareCatalogItems({ id: 'a', label: 'same' }, { id: 'b', label: 'same' }, 'newest'),
    ).toBeLessThan(0);
  });
});

vi.mock('../app/i18n.js', () => ({
  useT: () => (key: string, values?: Record<string, unknown>) =>
    `${key}${values ? JSON.stringify(values) : ''}`,
  useFormat: () => ({ number: (value: number) => String(value) }),
}));

it('restores server request controls on a fresh mount after an error/retry', () => {
  const request: CatalogRequest = {
    page: 2,
    search: '26.1',
    order: 'oldest',
    filters: { runtime: 'vanilla', releaseType: 'snapshot' },
  };
  const render = () =>
    renderToStaticMarkup(
      createElement(CatalogBrowser, {
        items: [{ id: 'one', label: '26.1' }],
        label: 'Versions',
        filters: [
          {
            id: 'runtime',
            label: 'Runtime',
            options: [{ value: 'vanilla', label: 'Vanilla' }],
            value: () => 'vanilla',
          },
          {
            id: 'releaseType',
            label: 'Type',
            options: [{ value: 'snapshot', label: 'Snapshot' }],
            value: () => 'snapshot',
          },
        ],
        server: { request, total: 40, pending: false, onChange: () => {} },
        // biome-ignore lint/correctness/noChildrenProp: CatalogBrowser requires a render function, not a ReactNode child.
        children: () => 'Rows',
      }),
    );
  for (const html of [render(), render()]) {
    expect(html).toContain('value="26.1"');
    expect(html).toMatch(/<option value="vanilla" selected="">/);
    expect(html).toMatch(/<option value="snapshot" selected="">/);
    expect(html).toMatch(/<option value="oldest" selected="">/);
    expect(html).toContain('catalog.page{&quot;page&quot;:&quot;2&quot;');
  }
});
