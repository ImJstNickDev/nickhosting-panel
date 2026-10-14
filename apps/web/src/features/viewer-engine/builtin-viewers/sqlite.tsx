import type { DatagridPage } from '@nickhosting/game-sdk/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../../api/client.js';
import { useFormat, useT } from '../../../app/i18n.js';
import { Tooltip } from '../../../components/tooltip.js';
import { ErrorNotice } from '../../../components/ui.js';
import { FilemanToolbarIcon } from '../../fileman/presentation.js';
import { serverPath } from '../../service-contracts.js';
import type { ViewerProps } from '../core/types.js';
import { DatagridTable } from './datagrid-table.js';
import { DatagridColumnFilter } from './sqlite-controls.js';
import { DatagridDetail, datagridCellText } from './sqlite-detail.js';
import { DatagridPageCache } from './sqlite-model.js';
import './datagrid.css';

type Controls = {
  table: string;
  offset: number;
  query: string;
  filterColumn: string;
  sort: string;
  direction: 'asc' | 'desc';
};
const skeletonRows = Array.from({ length: 12 }, (_, index) => `skeleton-${index}`);
const initialControls: Controls = {
  table: '',
  offset: 0,
  query: '',
  filterColumn: '',
  sort: '',
  direction: 'asc',
};
type Selection = { row: number; column: number };

export default function SqliteViewer(props: ViewerProps) {
  return (
    <Datagrid key={JSON.stringify([props.identity, props.serverId, props.source])} {...props} />
  );
}

function Datagrid({ serverId, source }: ViewerProps) {
  const t = useT();
  const format = useFormat();
  const [controls, setControls] = useState<Controls>(initialControls);
  const [search, setSearch] = useState('');
  const [tableSearch, setTableSearch] = useState('');
  const [view, setView] = useState<'data' | 'schema'>('data');
  const [refresh, setRefresh] = useState(0);
  const [changed, setChanged] = useState(false);
  const [denied, setDenied] = useState<unknown>();
  const [metadata, setMetadata] = useState<DatagridPage>();
  const [result, setResult] = useState<{ key: string; page?: DatagridPage; error?: unknown }>();
  const [selected, setSelected] = useState<Selection>();
  const [detail, setDetail] = useState<Selection>();
  const [copy, setCopy] = useState<'done' | 'failed'>();
  const [widths, setWidths] = useState<Map<string, number>>(() => new Map());
  const cache = useRef(new DatagridPageCache());
  const grid = useRef<HTMLDivElement>(null);
  const endpoint = `${serverPath(serverId)}/files/viewer/sqlite`;
  const params = new URLSearchParams({ path: source.path, offset: String(controls.offset) });
  if (source.entry) params.set('entry', source.entry);
  if (source.archives?.length) params.set('archives', JSON.stringify(source.archives));
  if (controls.table) params.set('table', controls.table);
  if (controls.query) params.set('query', controls.query);
  if (controls.filterColumn) params.set('filterColumn', controls.filterColumn);
  if (controls.sort) {
    params.set('sort', controls.sort);
    params.set('direction', controls.direction);
  }
  params.sort();
  const query = params.toString();
  const key = `${refresh}:${query}`;
  const invalidated = useCallback(() => {
    cache.current.clear();
    setResult(undefined);
    setMetadata(undefined);
    setDetail(undefined);
    setSelected(undefined);
    setChanged(true);
  }, []);
  const accessDenied = useCallback((failure: unknown) => {
    cache.current.clear();
    setResult(undefined);
    setMetadata(undefined);
    setDetail(undefined);
    setSelected(undefined);
    setDenied(failure);
  }, []);
  const page =
    changed || denied ? undefined : result?.key === key ? result.page : cache.current.get(query);
  const error = denied ?? (result?.key === key ? result.error : undefined);
  const loading = !changed && !page && !error;
  const waiting = search !== controls.query;
  const busy = loading || waiting;
  const columns = page?.columns ?? [];
  const rows = page?.rows ?? [];
  const tables = metadata?.tables ?? [];
  const table = controls.table || page?.table || metadata?.table || '';
  const actualOffset = page?.offset ?? controls.offset;
  const focusCell = (selection: Selection) => {
    grid.current
      ?.querySelector<HTMLElement>(
        `[data-row="${selection.row}"][data-column="${selection.column}"]`,
      )
      ?.focus();
  };
  const changeControls = (patch: Partial<Controls>) => {
    setControls((current) => ({ ...current, table, query: search, offset: 0, ...patch }));
    setSelected(undefined);
    setDetail(undefined);
    setCopy(undefined);
    grid.current?.scrollTo({ top: 0 });
  };
  useEffect(() => {
    if (search === controls.query) return;
    const timer = window.setTimeout(() => {
      setControls((current) => ({ ...current, query: search, offset: 0 }));
      setSelected(undefined);
      setDetail(undefined);
      setCopy(undefined);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search, controls.query]);
  useEffect(() => {
    if (changed || denied) return;
    const cached = cache.current.get(query);
    if (cached) {
      setResult({ key, page: cached });
      setMetadata(cached);
      return;
    }
    const controller = new AbortController();
    void api<DatagridPage>(`${endpoint}?${query}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        const canonical = new URLSearchParams(query);
        if (data.table) canonical.set('table', data.table);
        canonical.sort();
        if (!cache.current.put(canonical.toString(), data)) {
          invalidated();
          return;
        }
        setResult({ key, page: data });
        setMetadata(data);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (
          failure instanceof ApiError &&
          (failure.messageKey === 'viewer.sqliteChanged' ||
            failure.code === 'viewer_sqlite_changed')
        ) {
          invalidated();
          return;
        }
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
          accessDenied(failure);
          return;
        }
        setResult({ key, error: failure });
      });
    return () => controller.abort();
  }, [endpoint, query, key, changed, denied, invalidated, accessDenied]);
  useEffect(() => {
    const current = cache.current;
    return () => current.clear();
  }, []);
  function reload() {
    cache.current.clear();
    setResult(undefined);
    setMetadata(undefined);
    setChanged(false);
    setDenied(undefined);
    setDetail(undefined);
    setSelected(undefined);
    setCopy(undefined);
    setControls((current) => ({ ...current, offset: 0, query: search }));
    setRefresh((current) => current + 1);
  }
  function copyCell() {
    const cell = selected && rows[selected.row]?.[selected.column];
    if (!cell || cell.type === 'blob' || (cell.type === 'text' && cell.truncated)) return;
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(datagridCellText(cell)))
      .then(() => setCopy('done'))
      .catch(() => setCopy('failed'));
  }
  const selectedCell = selected && rows[selected.row]?.[selected.column];
  const canCopy =
    !!selectedCell &&
    selectedCell.type !== 'blob' &&
    !(selectedCell.type === 'text' && selectedCell.truncated);
  const detailQuery = new URLSearchParams(query);
  if (table) detailQuery.set('table', table);
  return (
    <div className="dg-workspace">
      <aside className="dg-sidebar" aria-label={t('viewer.tables')}>
        <div className="dg-sidebar-heading">
          <strong>{t('viewer.tables')}</strong>
          {metadata && <span>{format.number(tables.length)}</span>}
        </div>
        <input
          type="search"
          value={tableSearch}
          aria-label={t('datagrid.searchTables')}
          placeholder={t('datagrid.searchTables')}
          onChange={(event) => setTableSearch(event.target.value)}
        />
        <div className="dg-table-list">
          {tables
            .filter((name) => name.toLocaleLowerCase().includes(tableSearch.toLocaleLowerCase()))
            .map((name) => (
              <button
                type="button"
                key={name}
                aria-pressed={table === name}
                onClick={() => {
                  if (table === name) return;
                  setSearch('');
                  setWidths(new Map());
                  changeControls({
                    table: name,
                    query: '',
                    filterColumn: '',
                    sort: '',
                    direction: 'asc',
                  });
                }}
              >
                <span className="dg-table-glyph" aria-hidden="true">
                  ▦
                </span>
                <span>{name}</span>
              </button>
            ))}
          {metadata &&
            !tables.filter((name) =>
              name.toLocaleLowerCase().includes(tableSearch.toLocaleLowerCase()),
            ).length && (
              <p className="dg-sidebar-empty">
                {t(tables.length ? 'datagrid.noMatchingTables' : 'datagrid.noTables')}
              </p>
            )}
        </div>
      </aside>
      <div className="dg-main">
        <div className="dg-toolbar">
          <fieldset className="dg-view-toggle" aria-label={t('datagrid.view')}>
            <button
              type="button"
              aria-pressed={view === 'data'}
              onClick={() => {
                setView('data');
                setDetail(undefined);
              }}
            >
              {t('datagrid.data')}
            </button>
            <button
              type="button"
              aria-pressed={view === 'schema'}
              onClick={() => {
                setView('schema');
                setDetail(undefined);
              }}
            >
              {t('datagrid.schema')}
            </button>
          </fieldset>
          <span className="dg-readonly">{t('viewer.readOnly')}</span>
          <Tooltip
            content={t(
              page?.consistency === 'provider-snapshot'
                ? 'datagrid.providerSnapshotHelp'
                : 'viewer.snapshotHelp',
            )}
          >
            <button type="button" className="dg-snapshot">
              {t('viewer.snapshot')}
            </button>
          </Tooltip>
          <Tooltip content={t('datagrid.refresh')}>
            <button
              type="button"
              className="secondary dg-refresh"
              aria-label={t('datagrid.refresh')}
              disabled={loading}
              onClick={reload}
            >
              <FilemanToolbarIcon kind="refresh" />
            </button>
          </Tooltip>
        </div>
        {view === 'data' && (
          <div className="dg-searchbar">
            <input
              type="search"
              aria-label={t('datagrid.searchData')}
              placeholder={t('datagrid.searchData')}
              maxLength={200}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setDetail(undefined);
              }}
            />
            <DatagridColumnFilter
              columns={columns}
              value={controls.filterColumn}
              disabled={!columns.length || loading}
              onChange={(filterColumn) => changeControls({ filterColumn })}
            />
          </div>
        )}
        <div className="dg-content" aria-busy={busy}>
          {changed ? (
            <div className="dg-feedback dg-refresh-needed" role="status">
              <p>{t('datagrid.changed')}</p>
              <button type="button" className="secondary" onClick={reload}>
                {t('datagrid.refresh')}
              </button>
            </div>
          ) : error ? (
            <div className="dg-feedback">
              <ErrorNotice error={error} />
              <button type="button" className="secondary" onClick={reload}>
                {t('datagrid.retry')}
              </button>
            </div>
          ) : loading ? (
            <div className="dg-skeleton" role="status" aria-label={t('viewer.loading')}>
              {skeletonRows.map((id) => (
                <div key={id} />
              ))}
            </div>
          ) : !page?.table ? (
            <div className="dg-empty">{t('datagrid.noTables')}</div>
          ) : view === 'schema' ? (
            <div className="dg-grid-scroll">
              <table className="dg-schema">
                <caption className="sr-only">{t('datagrid.schema')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('datagrid.column')}</th>
                    <th scope="col">{t('datagrid.type')}</th>
                    <th scope="col">{t('datagrid.nullable')}</th>
                    <th scope="col">{t('datagrid.primaryKey')}</th>
                  </tr>
                </thead>
                <tbody>
                  {page.schema?.map((column) => (
                    <tr key={column.name}>
                      <th scope="row">{column.name}</th>
                      <td>
                        <code>{column.type || t('datagrid.untyped')}</code>
                      </td>
                      <td>{t(column.nullable ? 'datagrid.yes' : 'datagrid.no')}</td>
                      <td>{t(column.primaryKey ? 'datagrid.yes' : 'datagrid.no')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <DatagridTable
                label={table}
                columns={columns}
                rows={rows}
                gridRef={grid}
                rowKey={(_, index) => `${key}:${actualOffset + index}`}
                rowNumber={(_, index) => actualOffset + index + 1}
                selected={selected}
                onSelect={(selection) => {
                  setSelected(selection);
                  setCopy(undefined);
                }}
                onOpen={setDetail}
                onCopy={copyCell}
                busy={busy}
                readOnly
                inert={!!detail}
                sort={
                  controls.sort
                    ? { column: columns.indexOf(controls.sort), direction: controls.direction }
                    : undefined
                }
                onSort={(index) => {
                  const column = columns[index] ?? '';
                  changeControls(
                    controls.sort !== column
                      ? { sort: column, direction: 'asc' }
                      : controls.direction === 'asc'
                        ? { direction: 'desc' }
                        : { sort: '', direction: 'asc' },
                  );
                }}
                widths={widths}
                onResize={(column, width) =>
                  setWidths((current) => new Map(current).set(column, width))
                }
                empty={t(controls.query ? 'datagrid.noMatches' : 'datagrid.emptyTable')}
                cellType={(row, column) => row[column]?.type}
                renderCell={(row, column) => {
                  const cell = row[column];
                  if (!cell) return null;
                  return (
                    <span>
                      {cell.type === 'blob'
                        ? t('viewer.blob', { size: format.bytes(cell.bytes) })
                        : datagridCellText(cell)}
                      {cell.type === 'text' && cell.truncated && (
                        <span
                          className="dg-truncated"
                          role="img"
                          aria-label={t('viewer.truncated')}
                        >
                          {' '}
                          …
                        </span>
                      )}
                    </span>
                  );
                }}
              />
              {detail && page && columns[detail.column] !== undefined && (
                <DatagridDetail
                  key={`${key}:${detail.row}:${detail.column}`}
                  endpoint={endpoint}
                  params={detailQuery.toString()}
                  column={columns[detail.column] ?? ''}
                  row={actualOffset + detail.row}
                  revision={page.revision}
                  onChanged={invalidated}
                  onAccessDenied={accessDenied}
                  onClose={() => {
                    setDetail(undefined);
                    requestAnimationFrame(() => focusCell(detail));
                  }}
                />
              )}
            </>
          )}
        </div>
        <div className="dg-footer">
          <div className="dg-cell-actions">
            <Tooltip content={t('datagrid.inspectCell')}>
              <button
                type="button"
                className="secondary dg-icon"
                aria-label={t('datagrid.inspectCell')}
                disabled={!selectedCell || busy || changed || view !== 'data'}
                onClick={() => setDetail(selected)}
              >
                <FilemanToolbarIcon kind="find" />
              </button>
            </Tooltip>
            <Tooltip
              content={
                selectedCell?.type === 'text' && selectedCell.truncated
                  ? t('datagrid.inspectToCopy')
                  : t('datagrid.copyCell')
              }
            >
              <button
                type="button"
                className="secondary dg-icon"
                aria-label={t('datagrid.copyCell')}
                disabled={!canCopy || busy || changed || view !== 'data'}
                onClick={copyCell}
              >
                <FilemanToolbarIcon kind="copy" />
              </button>
            </Tooltip>
            {copy && (
              <span role="status">
                {t(copy === 'done' ? 'datagrid.copied' : 'datagrid.copyFailed')}
              </span>
            )}
          </div>
          <div className="dg-pagination">
            <span aria-live="polite">
              {busy
                ? t('datagrid.loading')
                : page && view === 'data'
                  ? t('datagrid.rows', {
                      start: format.number(rows.length ? actualOffset + 1 : 0),
                      end: format.number(actualOffset + rows.length),
                    })
                  : ''}
            </span>
            <button
              type="button"
              className="secondary"
              aria-label={t('datagrid.previousPage')}
              disabled={busy || !page || actualOffset === 0 || view !== 'data'}
              onClick={() => changeControls({ offset: Math.max(0, actualOffset - 100) })}
            >
              ‹
            </button>
            <button
              type="button"
              className="secondary"
              aria-label={t('datagrid.nextPage')}
              disabled={busy || !page?.hasMore || view !== 'data'}
              onClick={() => changeControls({ offset: actualOffset + rows.length })}
            >
              ›
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
