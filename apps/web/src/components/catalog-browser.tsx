import { type ReactNode, useState } from 'react';
import { useFormat, useT } from '../app/i18n.js';
import { Empty, Input, Select } from './ui.js';

export interface CatalogItem {
  id: string;
  label: string;
  releaseTime?: string | null;
}
export type CatalogOrder = 'newest' | 'oldest' | 'name-asc' | 'name-desc';
export interface CatalogRequest {
  page: number;
  search: string;
  order: CatalogOrder;
  filters: Record<string, string>;
}
export const initialCatalogRequest: CatalogRequest = {
  page: 1,
  search: '',
  order: 'newest',
  filters: {},
};
export function compareCatalogItems(a: CatalogItem, b: CatalogItem, order: CatalogOrder) {
  const names = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  if (order === 'newest' || order === 'oldest') {
    const first = Date.parse(a.releaseTime ?? ''),
      second = Date.parse(b.releaseTime ?? '');
    if (Number.isFinite(first) !== Number.isFinite(second)) return Number.isFinite(first) ? -1 : 1;
    if (Number.isFinite(first) && first !== second)
      return (first - second) * (order === 'newest' ? -1 : 1);
  }
  return (
    names.compare(a.label, b.label) * (order === 'name-asc' || order === 'oldest' ? 1 : -1) ||
    a.id.localeCompare(b.id)
  );
}
/** Shared integration catalog shell: bounded DOM, keyboard scrolling and filters.
 * Release dates come from the integration; missing dates are never insertion dates. */
export function CatalogBrowser<T extends CatalogItem>({
  items,
  label,
  filters,
  children,
  server,
}: {
  server?: {
    request: CatalogRequest;
    total: number;
    pending: boolean;
    onChange(request: CatalogRequest): void;
  };
  items: T[];
  label: string;
  filters: {
    id: string;
    label: string;
    options: { value: string; label: string }[];
    value: (item: T) => string;
  }[];
  children: (items: T[]) => ReactNode;
}) {
  const t = useT(),
    format = useFormat();
  const [localSearch, setSearch] = useState(''),
    [localOrder, setOrder] = useState<CatalogOrder>('newest');
  const [localSelected, setSelected] = useState<Record<string, string>>({}),
    [page, setPage] = useState(0);
  // The request survives a query-error unmount. It is authoritative in server mode.
  const search = server?.request.search ?? localSearch;
  const order = server?.request.order ?? localOrder;
  const selected = server?.request.filters ?? localSelected;
  const query = search.trim().toLocaleLowerCase();
  const matching = server
    ? items
    : items
        .filter(
          (item) =>
            item.label.toLocaleLowerCase().includes(query) &&
            filters.every(
              (filter) => !selected[filter.id] || filter.value(item) === selected[filter.id],
            ),
        )
        .sort((a, b) => compareCatalogItems(a, b, order));
  const pageSize = 25,
    pages = Math.max(1, Math.ceil((server?.total ?? matching.length) / pageSize)),
    current = server ? server.request.page - 1 : Math.min(page, pages - 1);
  function change(patch: Partial<CatalogRequest>) {
    server?.onChange({ ...server.request, page: 1, ...patch });
  }
  return (
    <div className="catalog-browser">
      <div className="catalog-filters">
        <Input
          label={t('catalog.search')}
          type="search"
          value={search}
          onChange={(event) => {
            if (server) change({ search: event.target.value });
            else {
              setSearch(event.target.value);
              setPage(0);
            }
          }}
        />
        {filters.map((filter) => (
          <Select
            key={filter.id}
            label={filter.label}
            value={selected[filter.id] ?? ''}
            onChange={(event) => {
              if (server) change({ filters: { ...selected, [filter.id]: event.target.value } });
              else {
                setSelected((previous) => ({ ...previous, [filter.id]: event.target.value }));
                setPage(0);
              }
            }}
          >
            <option value="">{t('catalog.all')}</option>
            {filter.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        ))}
        <Select
          label={t('catalog.order')}
          value={order}
          onChange={(event) => {
            if (server) change({ order: event.target.value as CatalogOrder });
            else {
              setOrder(event.target.value as CatalogOrder);
              setPage(0);
            }
          }}
        >
          {(['newest', 'oldest', 'name-asc', 'name-desc'] as const).map((value) => (
            <option key={value} value={value}>
              {t(`catalog.order.${value}`)}
            </option>
          ))}
        </Select>
      </div>
      <section
        key={`${current}/${search}/${order}/${JSON.stringify(selected)}`}
        className="catalog-viewport table-scroll"
        aria-label={label}
        aria-busy={server?.pending}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard access to the bounded scroll region.
        tabIndex={0}
      >
        {matching.length ? (
          children(server ? matching : matching.slice(current * pageSize, (current + 1) * pageSize))
        ) : (
          <Empty text={t('catalog.noMatches')} />
        )}
      </section>
      <div className="catalog-pagination">
        <p role="status">
          {t('catalog.count', {
            count: format.number(server?.total ?? matching.length, 0),
            total: format.number(server?.total ?? items.length, 0),
          })}
        </p>
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={current === 0}
            onClick={() => {
              if (server) change({ page: current });
              else setPage(current - 1);
            }}
          >
            {t('catalog.previous')}
          </button>
          <span>
            {t('catalog.page', {
              page: format.number(current + 1, 0),
              total: format.number(pages, 0),
            })}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={current >= pages - 1}
            onClick={() => {
              if (server) change({ page: current + 2 });
              else setPage(current + 1);
            }}
          >
            {t('web.next')}
          </button>
        </div>
      </div>
    </div>
  );
}
