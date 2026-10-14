import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormat, useT } from '../../../app/i18n.js';
import { Tooltip } from '../../../components/tooltip.js';
import { Dialog } from '../../../components/ui.js';
import { FilemanToolbarIcon } from '../../fileman/presentation.js';
import type { DocumentViewProps } from '../core/document-view.js';
import { useViewerFind } from '../core/use-find.js';
import { type DatagridSelection, DatagridTable } from './datagrid-table.js';
import { DelimitedClient } from './delimited-client.js';
import {
  type DelimitedEdit,
  DelimitedError,
  type DelimitedOptions,
  type DelimitedPage,
  type DelimitedView as DelimitedViewState,
} from './delimited-protocol.js';
import { DatagridChoice, DatagridSearch } from './sqlite-controls.js';
import './datagrid.css';
import './delimited.css';

type Edit = { selection: DatagridSelection; rowId: number; original: string; value: string };
type Action =
  | { type: 'remove-row'; rowId: number }
  | { type: 'remove-column'; column: number }
  | { type: 'rename-header'; column: number; value: string };
const skeletonRows = Array.from({ length: 12 }, (_, index) => `loading-${index}`);
const initialOptions: DelimitedOptions = { delimiter: 'auto', header: 'auto' };

/** Keep display-only column references attached to the surviving source columns. */
function reconcileView(
  view: DelimitedViewState,
  width: number,
  op?: DelimitedEdit,
): DelimitedViewState {
  const mapColumn = (column: number | undefined) => {
    if (column === undefined) return undefined;
    let next = column;
    if (op?.type === 'remove-column') {
      if (column === op.column) return undefined;
      if (column > op.column) next--;
    }
    if (op?.type === 'insert-column' && column >= op.column) next++;
    return next >= 0 && next < width ? next : undefined;
  };
  const column = mapColumn(view.column);
  const sortColumn = mapColumn(view.sort?.column);
  const sort =
    sortColumn === undefined
      ? undefined
      : view.sort?.column === sortColumn
        ? view.sort
        : { column: sortColumn, direction: view.sort?.direction ?? 'asc' };
  if (column === view.column && sort === view.sort) return view;
  return { ...view, column, sort, offset: 0 };
}

export default function DelimitedView(props: DocumentViewProps) {
  const t = useT();
  const format = useFormat();
  const [page, setPage] = useState<DelimitedPage>();
  const [options, setOptions] = useState(initialOptions);
  const [view, setView] = useState<DelimitedViewState>({ offset: 0, limit: 100 });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<DatagridSelection>();
  const [edit, setEditState] = useState<Edit>();
  const [action, setAction] = useState<Action>();
  const [detail, setDetail] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [copy, setCopy] = useState<'done' | 'failed'>();
  const [widths, setWidths] = useState<Map<string, number>>(() => new Map());
  const [retry, setRetry] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const editorInput = useRef<HTMLTextAreaElement>(null);
  useViewerFind(props.active, () => {
    searchInput.current?.focus();
    searchInput.current?.select();
  });
  const client = useRef<DelimitedClient | undefined>(undefined);
  const current = useRef(props);
  current.current = props;
  const pageRef = useRef(page);
  pageRef.current = page;
  const resolvedView = useRef<DelimitedViewState | undefined>(undefined);
  const viewRef = useRef(view);
  viewRef.current = view;
  const editRef = useRef<Edit | undefined>(undefined);
  const pending = useRef<Promise<boolean> | undefined>(undefined);
  const loaded = useRef<{ value: string; options: DelimitedOptions } | undefined>(undefined);
  const generation = useRef(0);
  const setEdit = useCallback((next: Edit | undefined) => {
    editRef.current = next;
    setEditState(next);
  }, []);
  const report = useCallback((error: unknown) => {
    setFailure(
      error instanceof DelimitedError ? `delimited.error.${error.code}` : 'delimited.error.invalid',
    );
  }, []);
  const focusCell = useCallback((selection?: DatagridSelection) => {
    const target = selection
      ? `[data-row="${selection.row}"][data-column="${selection.column}"]`
      : '[role="gridcell"][tabindex="0"]';
    const cell =
      grid.current?.querySelector<HTMLElement>(target) ??
      grid.current?.querySelector<HTMLElement>('[role="gridcell"]');
    if (cell) cell.focus();
    else searchInput.current?.focus();
  }, []);

  useEffect(() => {
    const worker = new DelimitedClient();
    client.current = worker;
    return () => {
      generation.current++;
      worker.dispose();
      client.current = undefined;
    };
  }, []);

  // Parses the shared draft even while Scribe is visible; switching needs no file read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads the shared draft.
  useEffect(() => {
    if (loaded.current?.value === props.value && loaded.current.options === options) return;
    const worker = client.current;
    if (!worker) return;
    const token = ++generation.current;
    setLoading(true);
    setFailure(undefined);
    setEdit(undefined);
    setDetail(undefined);
    setSelected(undefined);
    loaded.current = undefined;
    const timer = window.setTimeout(
      () => {
        void worker
          .load(props.value, props.path.split('.').pop() ?? '', options)
          .then(async (result) => {
            if (token !== generation.current) return;
            loaded.current = { value: props.value, options };
            const control = reconcileView(viewRef.current, result.columns.length);
            const nextPage =
              control.query || control.sort || control.offset || control.column !== undefined
                ? await worker.view(control)
                : result;
            if (token !== generation.current) return;
            resolvedView.current = control;
            viewRef.current = control;
            setView(control);
            return nextPage;
          })
          .then((result) => {
            if (token === generation.current && result) {
              setPage(result);
              setLoading(false);
            }
          })
          .catch((error: unknown) => {
            if (token === generation.current) {
              report(error);
              setLoading(false);
            }
          });
      },
      props.active ? 0 : 100,
    );
    return () => window.clearTimeout(timer);
  }, [props.value, props.path, props.active, options, report, retry, setEdit]);

  const mutate = useCallback(
    (op: DelimitedEdit): Promise<boolean> => {
      if (pending.current) return pending.current;
      const worker = client.current;
      const snapshot = pageRef.current;
      const expected = current.current.value;
      if (!worker || !snapshot || current.current.readOnly || loaded.current?.value !== expected)
        return Promise.resolve(false);
      const width =
        snapshot.columns.length +
        (op.type === 'insert-column' ? 1 : op.type === 'remove-column' ? -1 : 0);
      const nextView = reconcileView(viewRef.current, width, op);
      const token = ++generation.current;
      setMutating(true);
      setFailure(undefined);
      const promise = worker
        .edit(op, snapshot.revision, nextView)
        .then(async (result) => {
          if (token !== generation.current) return false;
          const actualView = reconcileView(nextView, result.page.columns.length);
          if (!current.current.onChange(result.text, expected)) {
            loaded.current = undefined;
            setRetry((value) => value + 1);
            throw new DelimitedError('stale');
          }
          if (loaded.current) loaded.current.value = result.text;
          current.current = { ...current.current, value: result.text };
          resolvedView.current = actualView;
          viewRef.current = actualView;
          setView(actualView);
          setPage(result.page);
          pageRef.current = result.page;
          setEdit(undefined);
          setCopy(undefined);
          if (actualView !== nextView) {
            const refreshed = await worker.view(actualView);
            if (token !== generation.current) return false;
            setPage(refreshed);
            pageRef.current = refreshed;
          }
          return true;
        })
        .catch((error: unknown) => {
          if (token === generation.current) report(error);
          return false;
        })
        .finally(() => {
          if (pending.current === promise) {
            pending.current = undefined;
            setMutating(false);
          }
        });
      pending.current = promise;
      return promise;
    },
    [report, setEdit],
  );

  const flush = useCallback(async () => {
    if (pending.current) return pending.current;
    const draft = editRef.current;
    if (!draft) return true;
    if (draft.value === draft.original) {
      setEdit(undefined);
      return true;
    }
    return mutate({
      type: 'set-cell',
      rowId: draft.rowId,
      column: draft.selection.column,
      value: draft.value,
    });
  }, [mutate, setEdit]);

  const pendingChanges = (!!edit && edit.value !== edit.original) || mutating;
  useEffect(() => {
    props.onControls({
      focus: () => {
        if (editRef.current) editorInput.current?.focus();
        else focusCell();
      },
      find: () => {
        searchInput.current?.focus();
        searchInput.current?.select();
      },
      flush,
      pendingChanges,
    });
    return () => props.onControls(undefined);
  }, [props.onControls, focusCell, flush, pendingChanges]);

  useEffect(() => {
    if (search === (view.query ?? '')) return;
    const timer = window.setTimeout(() => {
      void flush().then((ok) => {
        if (ok) setView((previous) => ({ ...previous, query: search, offset: 0 }));
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search, view.query, flush]);

  useEffect(() => {
    if (
      !loaded.current ||
      loaded.current.value !== current.current.value ||
      resolvedView.current === view
    )
      return;
    const worker = client.current;
    if (!worker) return;
    const token = ++generation.current;
    setLoading(true);
    setFailure(undefined);
    void worker
      .view(view)
      .then((result) => {
        if (token !== generation.current) return;
        resolvedView.current = view;
        setPage(result);
        setSelected((previous) => (previous?.row === -1 ? previous : undefined));
        setCopy(undefined);
        setLoading(false);
        grid.current?.scrollTo({ top: 0 });
      })
      .catch((error: unknown) => {
        if (token === generation.current) {
          report(error);
          setLoading(false);
        }
      });
  }, [view, report]);

  useEffect(() => {
    if (edit?.rowId !== undefined && edit.selection.column !== undefined)
      editorInput.current?.focus();
  }, [edit?.rowId, edit?.selection.column]);

  const changeView = (patch: Partial<DelimitedViewState>) => {
    void flush().then((ok) => {
      if (ok) setView((previous) => ({ ...previous, offset: 0, ...patch }));
    });
  };
  async function openCell(selection: DatagridSelection) {
    if (!(await flush())) return;
    const snapshot = pageRef.current;
    const row = snapshot?.rows[selection.row];
    if (!snapshot || !row || !client.current) return;
    const token = generation.current;
    try {
      const value = await client.current.detail(row.id, selection.column, snapshot.revision);
      if (token !== generation.current) return;
      if (current.current.readOnly) setDetail(value);
      else setEdit({ selection, rowId: row.id, original: value, value });
    } catch (error) {
      report(error);
    }
  }
  async function copyCell() {
    if (busy) return;
    const snapshot = pageRef.current;
    const row = selected && snapshot?.rows[selected.row];
    if (!snapshot || !row || !selected || !client.current) return;
    try {
      const value = await client.current.detail(row.id, selected.column, snapshot.revision);
      await navigator.clipboard.writeText(value);
      setCopy('done');
    } catch {
      setCopy('failed');
    }
  }
  async function renameHeader(column = selected?.column) {
    if (column === undefined || !page || !client.current || !(await flush())) return;
    try {
      const value = await client.current.detail(-1, column, page.revision);
      setAction({ type: 'rename-header', column, value });
    } catch (error) {
      report(error);
    }
  }
  const busy = loading || mutating;
  const columns = page?.columns ?? [];
  const rows = page?.rows ?? [];
  const selectedRow = selected && rows[selected.row];
  const columnChoices = columns.map((label, index) => ({
    value: String(index),
    label: label || t('delimited.columnNumber', { number: index + 1 }),
  }));
  const delimiterChoices = [
    { value: 'auto', label: t('delimited.auto') },
    { value: ',', label: t('delimited.comma') },
    { value: ';', label: t('delimited.semicolon') },
    { value: '\t', label: t('delimited.tab') },
    { value: '|', label: t('delimited.pipe') },
  ];
  const icon = (
    name: string,
    glyph: 'row-add' | 'row-remove' | 'column-add' | 'column-remove' | 'rename',
    disabled: boolean,
    onClick: () => void,
  ) => (
    <Tooltip content={t(name)}>
      <button
        type="button"
        className="secondary dg-icon"
        aria-label={t(name)}
        disabled={disabled}
        onClick={onClick}
      >
        <GridIcon kind={glyph} />
      </button>
    </Tooltip>
  );
  return (
    <div className="dg-workspace dg-delimited">
      <div className="dg-main">
        <div className="dg-searchbar">
          <DatagridSearch inputRef={searchInput} value={search} onChange={setSearch} />
          <DatagridChoice
            label={t('datagrid.filterColumn')}
            choices={[{ value: '', label: t('datagrid.allColumns') }, ...columnChoices]}
            value={view.column === undefined ? '' : String(view.column)}
            disabled={busy || !columns.length}
            onChange={(value) => changeView({ column: value === '' ? undefined : Number(value) })}
          />
          {props.readOnly && <span className="dg-readonly">{t('viewer.readOnly')}</span>}
          <div className="dg-delimited-tools">
            {!props.readOnly && (
              <div className="dg-delimited-actions">
                {icon('delimited.addRow', 'row-add', busy || !page, () => {
                  void flush().then((ok) => {
                    if (ok) void mutate({ type: 'insert-row' });
                  });
                })}
                {icon('delimited.removeRow', 'row-remove', busy || !selectedRow, () => {
                  if (selectedRow) setAction({ type: 'remove-row', rowId: selectedRow.id });
                })}
                {icon(
                  'delimited.addColumn',
                  'column-add',
                  busy || !page || columns.length >= 128,
                  () => {
                    void flush().then((ok) => {
                      if (ok) void mutate({ type: 'insert-column', column: columns.length });
                    });
                  },
                )}
                {icon(
                  'delimited.removeColumn',
                  'column-remove',
                  busy || !selected || columns.length < 2,
                  () => {
                    if (selected) setAction({ type: 'remove-column', column: selected.column });
                  },
                )}
                {icon(
                  'delimited.renameHeader',
                  'rename',
                  busy || !selected || !page?.header,
                  () => {
                    void renameHeader();
                  },
                )}
              </div>
            )}
            <Tooltip content={t('delimited.header')}>
              <button
                type="button"
                className="secondary dg-icon dg-header-toggle"
                aria-label={t('delimited.header')}
                aria-pressed={page?.header ?? false}
                disabled={busy || !page}
                onClick={() => {
                  void flush().then((ok) => {
                    if (ok) {
                      setView({ offset: 0, limit: 100 });
                      setSearch('');
                      setOptions((previous) => ({ ...previous, header: !page?.header }));
                    }
                  });
                }}
              >
                <GridIcon kind="header" />
              </button>
            </Tooltip>
            <div className="dg-delimited-settings">
              <span>{t('delimited.delimiter')}</span>
              <DatagridChoice
                label={t('delimited.delimiter')}
                choices={delimiterChoices}
                value={options.delimiter}
                disabled={busy}
                onChange={(delimiter) => {
                  void flush().then((ok) => {
                    if (ok) {
                      setView({ offset: 0, limit: 100 });
                      setSearch('');
                      setOptions((previous) => ({
                        ...previous,
                        delimiter: delimiter as DelimitedOptions['delimiter'],
                      }));
                    }
                  });
                }}
              />
            </div>
          </div>
        </div>
        {failure && (
          <div className="dg-delimited-error" role="alert">
            <span>{t(failure)}</span>
            <button
              type="button"
              className="secondary"
              disabled={busy || !!edit}
              onClick={() => {
                loaded.current = undefined;
                setRetry((value) => value + 1);
              }}
            >
              {t('datagrid.retry')}
            </button>
          </div>
        )}
        <div className="dg-content" aria-busy={busy}>
          {!page || (failure && !loaded.current) ? (
            loading ? (
              <div className="dg-skeleton" role="status" aria-label={t('viewer.loading')}>
                {skeletonRows.map((id) => (
                  <div key={id} />
                ))}
              </div>
            ) : null
          ) : (
            <DatagridTable
              label={props.path}
              columns={columns.map(
                (column, index) => column || t('delimited.columnNumber', { number: index + 1 }),
              )}
              rows={rows}
              gridRef={grid}
              columnKey={(index) => String(index)}
              onHeaderFocus={(column) => setSelected({ row: -1, column })}
              onHeaderOpen={
                props.readOnly || !page.header
                  ? undefined
                  : (column) => {
                      void renameHeader(column);
                    }
              }
              rowKey={(row) => row.id}
              rowNumber={(row) => row.id + 1}
              selected={selected}
              onSelect={(selection) => {
                setSelected(selection);
                setCopy(undefined);
              }}
              onOpen={(selection) => {
                void openCell(selection);
              }}
              onCopy={() => {
                void copyCell();
              }}
              busy={busy}
              readOnly={props.readOnly}
              sort={view.sort}
              onSort={(column) =>
                changeView({
                  sort:
                    view.sort?.column !== column
                      ? { column, direction: 'asc' }
                      : view.sort.direction === 'asc'
                        ? { column, direction: 'desc' }
                        : undefined,
                })
              }
              widths={widths}
              onResize={(column, width) =>
                setWidths((previous) => new Map(previous).set(column, width))
              }
              empty={t(view.query ? 'datagrid.noMatches' : 'datagrid.emptyTable')}
              editing={edit?.selection}
              renderCell={(row, column) =>
                edit?.rowId === row.id && edit.selection.column === column ? (
                  <textarea
                    ref={editorInput}
                    className="dg-cell-editor"
                    aria-label={t('delimited.editCell')}
                    value={edit.value}
                    disabled={mutating}
                    onChange={(event) => {
                      const draft = editRef.current;
                      if (draft) setEdit({ ...draft, value: event.target.value });
                    }}
                    onBlur={() => {
                      void flush();
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        const selection = edit.selection;
                        setEdit(undefined);
                        requestAnimationFrame(() => focusCell(selection));
                      }
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        event.stopPropagation();
                        const selection = edit.selection;
                        void flush().then((ok) => {
                          if (ok) focusCell(selection);
                        });
                      }
                    }}
                  />
                ) : (
                  <span>{row.cells[column] ?? ''}</span>
                )
              }
            />
          )}
        </div>
        <div className="dg-footer">
          <div className="dg-cell-actions">
            <Tooltip content={t(props.readOnly ? 'datagrid.inspectCell' : 'delimited.editCell')}>
              <button
                type="button"
                className="secondary dg-icon"
                aria-label={t(props.readOnly ? 'datagrid.inspectCell' : 'delimited.editCell')}
                disabled={busy || !selectedRow}
                onClick={() => {
                  if (selected) void openCell(selected);
                }}
              >
                <FilemanToolbarIcon kind="find" />
              </button>
            </Tooltip>
            <Tooltip content={t('datagrid.copyCell')}>
              <button
                type="button"
                className="secondary dg-icon"
                aria-label={t('datagrid.copyCell')}
                disabled={busy || !selectedRow}
                onClick={() => {
                  void copyCell();
                }}
              >
                <FilemanToolbarIcon kind="copy" />
              </button>
            </Tooltip>
            {copy && (
              <span role="status">
                {t(copy === 'done' ? 'datagrid.copied' : 'datagrid.copyFailed')}
              </span>
            )}
            {page?.truncatedCells && !copy && (
              <span title={t('datagrid.inspectToCopy')}>{t('delimited.shortened')}</span>
            )}
          </div>
          <div className="dg-pagination">
            <span aria-live="polite">
              {busy || search !== (view.query ?? '')
                ? t('datagrid.loading')
                : page
                  ? t('delimited.rows', {
                      start: format.number(rows.length ? page.offset + 1 : 0),
                      end: format.number(page.offset + rows.length),
                      total: format.number(page.total),
                    })
                  : ''}
            </span>
            <button
              type="button"
              className="secondary"
              aria-label={t('datagrid.previousPage')}
              disabled={busy || !page?.offset}
              onClick={() => changeView({ offset: Math.max(0, (page?.offset ?? 0) - 100) })}
            >
              ‹
            </button>
            <button
              type="button"
              className="secondary"
              aria-label={t('datagrid.nextPage')}
              disabled={busy || !page || page.offset + rows.length >= page.total}
              onClick={() => changeView({ offset: (page?.offset ?? 0) + 100 })}
            >
              ›
            </button>
          </div>
        </div>
      </div>
      <Dialog
        open={!!action}
        title={t(
          action?.type === 'rename-header'
            ? 'delimited.renameHeader'
            : action?.type === 'remove-row'
              ? 'delimited.removeRow'
              : 'delimited.removeColumn',
        )}
        onClose={() => {
          if (!mutating) setAction(undefined);
        }}
        closeDisabled={mutating}
      >
        {action?.type === 'rename-header' ? (
          <label>
            {t('delimited.headerName')}
            <input
              value={action.value}
              onChange={(event) => setAction({ ...action, value: event.target.value })}
            />
          </label>
        ) : (
          <p>
            {t(
              action?.type === 'remove-row'
                ? 'delimited.removeRowConfirm'
                : 'delimited.removeColumnConfirm',
            )}
          </p>
        )}
        <button
          type="button"
          disabled={mutating}
          onClick={() => {
            if (action)
              void mutate(action).then((ok) => {
                if (ok) {
                  setAction(undefined);
                  setSelected(undefined);
                }
              });
          }}
        >
          {t(action?.type === 'rename-header' ? 'delimited.apply' : 'delimited.delete')}
        </button>
      </Dialog>
      <Dialog
        open={detail !== undefined}
        title={t('datagrid.cellDetails')}
        onClose={() => {
          setDetail(undefined);
          requestAnimationFrame(() => focusCell(selected));
        }}
      >
        <pre className="dg-delimited-detail">{detail}</pre>
      </Dialog>
    </div>
  );
}

function GridIcon({
  kind,
}: {
  kind: 'row-add' | 'row-remove' | 'column-add' | 'column-remove' | 'rename' | 'header';
}) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      {kind === 'header' ? (
        <>
          <rect x="3" y="4" width="18" height="16" rx="1" />
          <path d="M3 10h18M9 10v10M15 10v10M3 15h18" />
          <path d="M4 5h16v4H4Z" fill="currentColor" stroke="none" />
        </>
      ) : kind === 'rename' ? (
        <>
          <path d="m5 15 10-10 4 4L9 19H5Z" />
          <path d="m13 7 4 4" />
        </>
      ) : (
        <>
          <rect x="3" y="3" width="13" height="17" rx="1" />
          <path d={kind.startsWith('row') ? 'M3 8h13M3 14h13' : 'M9 3v17'} />
          <path d="M16 16h7" />
          {kind.endsWith('add') && <path d="M19.5 12.5v7" />}
        </>
      )}
    </svg>
  );
}
