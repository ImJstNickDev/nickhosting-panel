import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useFormat, useT } from '../../../app/i18n.js';
import { Tooltip } from '../../../components/tooltip.js';
import { ErrorNotice } from '../../../components/ui.js';
import { serverPath } from '../../service-contracts.js';
import type { ViewerProps } from '../core/types.js';
import { ViewerLoading } from '../loading.js';

interface DatabasePage {
  tables: string[];
  columns?: string[];
  rows?: DatabaseCell[][];
  offset?: number;
  hasMore?: boolean;
  consistency?: 'unverified';
}
type DatabaseCell =
  | { type: 'null'; value: null }
  | { type: 'integer'; value: string }
  | { type: 'real'; value: number }
  | { type: 'text'; value: string; truncated: boolean }
  | { type: 'blob'; bytes: number };
export default function SqliteViewer({ serverId, source, identity }: ViewerProps) {
  const t = useT();
  const format = useFormat();
  const [table, setTable] = useState('');
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({ path: source.path, offset: String(offset) });
  if (table) query.set('table', table);
  const page = useQuery({
    queryKey: ['viewer-sqlite', identity, serverId, source.path, table, offset],
    queryFn: ({ signal }) =>
      api<DatabasePage>(`${serverPath(serverId)}/files/viewer/sqlite?${query}`, { signal }),
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  return (
    <div className="ve-database">
      <div className="ve-controls">
        <label>
          {t('viewer.tables')}
          <select
            aria-label={t('viewer.tables')}
            value={table}
            onChange={(event) => {
              setTable(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">—</option>
            {page.data?.tables.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">{t('viewer.readOnly')}</span>
        {page.data?.consistency === 'unverified' && (
          <Tooltip content={t('viewer.snapshotHelp')}>
            <button type="button" className="text-button ve-snapshot">
              {t('viewer.snapshot')}
            </button>
          </Tooltip>
        )}
      </div>
      {page.error ? (
        <ErrorNotice error={page.error} />
      ) : page.isPending || page.isPlaceholderData ? (
        <ViewerLoading />
      ) : (
        table && (
          <>
            <div className="ve-table-scroll">
              <table>
                <thead>
                  <tr>
                    {page.data.columns?.map((column) => (
                      <th key={column} scope="col">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.data.rows?.map((row, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: A snapshot page is immutable; its absolute row offset is its identity.
                    <tr key={`${offset}:${index}`}>
                      {row.map((value, col) => (
                        <td key={page.data.columns?.[col]}>
                          <span>
                            {value.type === 'null'
                              ? 'NULL'
                              : value.type === 'blob'
                                ? t('viewer.blob', { size: format.bytes(value.bytes) })
                                : String(value.value)}
                            {value.type === 'text' && value.truncated && (
                              <small> … {t('viewer.truncated')}</small>
                            )}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!page.data.rows?.length && <p className="ve-empty">{t('viewer.empty')}</p>}
            <div className="ve-pagination">
              <button
                type="button"
                className="secondary"
                disabled={offset === 0}
                onClick={() => setOffset((value) => Math.max(0, value - 100))}
              >
                {t('viewer.previous')}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!page.data.hasMore}
                onClick={() => setOffset((value) => value + (page.data?.rows?.length ?? 100))}
              >
                {t('viewer.next')}
              </button>
            </div>
          </>
        )
      )}
    </div>
  );
}
