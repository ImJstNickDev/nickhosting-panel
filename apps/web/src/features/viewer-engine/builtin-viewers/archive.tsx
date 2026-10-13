import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useFormat, useT } from '../../../app/i18n.js';
import { ErrorNotice } from '../../../components/ui.js';
import { FileIcon } from '../../file-icon.js';
import { serverPath } from '../../service-contracts.js';
import { trimArchivePages } from '../core/archive-memory.js';
import type { ViewerProps } from '../core/types.js';
import { ViewerLoading } from '../loading.js';

interface ArchiveEntry {
  name: string;
  path: string;
  directory: boolean;
  size: number;
}
interface ArchivePage {
  directory: string;
  offset: number;
  limit: number;
  total: number;
  entries: ArchiveEntry[];
}
export default function ArchiveViewer({
  serverId,
  source,
  identity,
  onOpen,
  archiveDirectory,
}: ViewerProps) {
  const t = useT();
  const format = useFormat();
  const [directory, setDirectory] = useState(archiveDirectory ?? '');
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({
    path: source.path,
    directory,
    offset: String(offset),
    limit: '200',
  });
  const page = useQuery({
    queryKey: ['viewer-archive', identity, serverId, source.path, directory, offset],
    queryFn: ({ signal }) =>
      api<ArchivePage>(`${serverPath(serverId)}/files/viewer/archive?${query}`, { signal }),
    gcTime: 2 * 60_000,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (page.dataUpdatedAt)
      trimArchivePages(['viewer-archive', identity, serverId, source.path, directory, offset]);
  }, [page.dataUpdatedAt, identity, serverId, source.path, directory, offset]);
  function navigate(value: string) {
    setDirectory(value);
    setOffset(0);
  }
  const parts = directory.split('/').filter(Boolean);
  return (
    <div className="ve-archive">
      <nav className="fm-breadcrumb ve-archive-breadcrumb" aria-label={t('viewer.archivePath')}>
        <ol>
          <li>
            <button type="button" className="text-button" onClick={() => navigate('')}>
              {source.name}
            </button>
          </li>
          {parts.map((part, index) => (
            <li key={parts.slice(0, index + 1).join('/')}>
              <button
                type="button"
                className="text-button"
                aria-current={index === parts.length - 1 ? 'page' : undefined}
                onClick={() => navigate(parts.slice(0, index + 1).join('/'))}
              >
                {part}
              </button>
            </li>
          ))}
        </ol>
        <span className="ve-kind">{t('viewer.archive')}</span>
      </nav>
      {page.error ? (
        <ErrorNotice error={page.error} />
      ) : page.isPending || page.isPlaceholderData ? (
        <ViewerLoading />
      ) : (
        <>
          <div className="ve-archive-list">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('web.name')}</th>
                  <th scope="col">{t('web.size')}</th>
                </tr>
              </thead>
              <tbody>
                {directory && (
                  <tr>
                    <td colSpan={2}>
                      <button
                        type="button"
                        className="ve-entry"
                        onClick={() => navigate(parts.slice(0, -1).join('/'))}
                      >
                        ..
                      </button>
                    </td>
                  </tr>
                )}
                {page.data.entries.map((entry) => (
                  <tr key={entry.path}>
                    <td>
                      <button
                        type="button"
                        className="ve-entry"
                        onClick={() =>
                          entry.directory
                            ? navigate(entry.path)
                            : onOpen({
                                path: source.path,
                                name: entry.name,
                                size: entry.size,
                                entry: entry.path,
                              })
                        }
                      >
                        <FileIcon name={entry.name} folder={entry.directory} />
                        {entry.name}
                      </button>
                    </td>
                    <td>{entry.directory ? '—' : format.bytes(entry.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {page.data.total === 0 && <p className="ve-empty">{t('viewer.empty')}</p>}
          </div>
          {page.data.total > 200 && (
            <div className="ve-pagination">
              <button
                type="button"
                className="secondary"
                disabled={offset === 0}
                onClick={() => setOffset((value) => Math.max(0, value - 200))}
              >
                {t('viewer.previous')}
              </button>
              <span>
                {offset + 1}–{Math.min(offset + 200, page.data.total)} / {page.data.total}
              </span>
              <button
                type="button"
                className="secondary"
                disabled={offset + 200 >= page.data.total}
                onClick={() => setOffset((value) => value + 200)}
              >
                {t('viewer.next')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
