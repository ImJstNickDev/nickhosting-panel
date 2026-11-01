import type { DatagridCell, DatagridCellDetail } from '@nickhosting/game-sdk/ui';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../../api/client.js';
import { useFormat, useT } from '../../../app/i18n.js';
import { ErrorNotice } from '../../../components/ui.js';

export function datagridCellText(cell: DatagridCell): string {
  if (cell.type === 'null') return 'NULL';
  if (cell.type === 'blob') return '';
  return String(cell.value);
}

export function DatagridDetail({
  endpoint,
  params,
  column,
  row,
  revision,
  onClose,
  onChanged,
  onAccessDenied,
}: {
  endpoint: string;
  params: string;
  column: string;
  row: number;
  revision: string;
  onClose: () => void;
  onChanged: () => void;
  onAccessDenied: (error: unknown) => void;
}) {
  const t = useT();
  const format = useFormat();
  const [start, setStart] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    start: number;
    data?: DatagridCellDetail;
    error?: unknown;
  }>();
  const [copy, setCopy] = useState<'done' | 'failed'>();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly restarts this request.
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams(params);
    query.delete('offset');
    query.set('rowOffset', String(row));
    query.set('column', column);
    query.set('revision', revision);
    query.set('start', String(start));
    setResult(undefined);
    setCopy(undefined);
    void api<DatagridCellDetail>(`${endpoint}/cell?${query}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data.revision !== revision) {
          onChanged();
          return;
        }
        setResult({ start, data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          onAccessDenied(error);
          return;
        }
        if (
          error instanceof ApiError &&
          (error.messageKey === 'viewer.sqliteChanged' || error.code === 'viewer_sqlite_changed')
        ) {
          onChanged();
          return;
        }
        setResult({ start, error });
      });
    return () => controller.abort();
  }, [endpoint, params, row, column, revision, start, attempt, onChanged, onAccessDenied]);
  const data = result?.start === start ? result.data : undefined;
  const error = result?.start === start ? result.error : undefined;
  const cell = data?.cell;
  return (
    <section
      className="dg-detail"
      aria-label={t('datagrid.cellDetails')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="dg-detail-heading">
        <div>
          <strong>{column}</strong>
          <span>{t('datagrid.row', { row: format.number(row + 1) })}</span>
        </div>
        <button
          type="button"
          className="secondary"
          ref={close}
          aria-label={t('datagrid.closeDetails')}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {error ? (
        <div className="dg-feedback">
          <ErrorNotice error={error} />
          <button type="button" className="secondary" onClick={() => setAttempt(attempt + 1)}>
            {t('datagrid.retry')}
          </button>
        </div>
      ) : !cell ? (
        <div className="dg-skeleton" role="status" aria-label={t('viewer.loading')}>
          <div />
          <div />
          <div />
          <div />
          <div />
        </div>
      ) : (
        <>
          <div className="dg-detail-meta">
            <span>{t(`datagrid.type.${cell.type}`)}</span>
            {cell.type !== 'blob' && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  void Promise.resolve()
                    .then(() => navigator.clipboard.writeText(datagridCellText(cell)))
                    .then(() => setCopy('done'))
                    .catch(() => setCopy('failed'));
                }}
              >
                {t(
                  cell.type === 'text' && (data.totalCharacters ?? 0) > 65536
                    ? 'datagrid.copyChunk'
                    : 'datagrid.copyCell',
                )}
              </button>
            )}
          </div>
          <section
            className="dg-detail-value"
            aria-label={t('datagrid.cellValue')}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable text needs keyboard access.
            tabIndex={0}
          >
            {cell.type === 'blob'
              ? t('viewer.blob', { size: format.bytes(cell.bytes) })
              : datagridCellText(cell)}
          </section>
          {copy && (
            <p role="status" className="dg-copy-feedback">
              {t(copy === 'done' ? 'datagrid.copied' : 'datagrid.copyFailed')}
            </p>
          )}
          {cell.type === 'text' && data.totalCharacters !== null && (
            <div className="dg-detail-pager">
              <span>
                {t('datagrid.characters', {
                  start: format.number(data.totalCharacters ? start + 1 : 0),
                  end: format.number(data.nextStart ?? data.totalCharacters),
                  total: format.number(data.totalCharacters),
                })}
              </span>
              <div>
                <button
                  type="button"
                  className="secondary"
                  disabled={start === 0}
                  onClick={() => setStart(Math.max(0, start - 65536))}
                >
                  {t('datagrid.previousChunk')}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={data.nextStart === null}
                  onClick={() => {
                    if (data.nextStart !== null) setStart(data.nextStart);
                  }}
                >
                  {t('datagrid.nextChunk')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
