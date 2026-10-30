import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useRef, useState } from 'react';
import { api, queryClient } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { ErrorNotice, Loading, Time } from '../components/ui.js';
import { MinecraftAdminIcon } from './minecraft-admin-presentation.js';
import { VersionCatalogFrame } from './version-catalog-frame.js';

interface PaperCatalog {
  versions: Array<{
    version: string;
    buildId: number;
    javaMajor: number;
    channel: string;
    buildTime: string;
  }>;
  synced: boolean;
  status: {
    syncState: 'idle' | 'queued' | 'refreshing';
    lastCheckedAt: string | null;
    lastSuccessAt: string | null;
    nextCheckAt: string | null;
    lastError: string | null;
    stale: boolean;
  };
}
const endpoint = '/v1/owner/minecraft/paper/catalog';
const queryKey = ['owner-paper-catalog'];
const pageSize = 25;

/** Discovery reads a local snapshot and never creates an egg mapping. */
export function PaperVersionCatalog({ navigation }: { navigation: ReactNode }) {
  const t = useT();
  const catalog = useQuery({
    queryKey,
    queryFn: ({ signal }) => api<PaperCatalog>(endpoint, { signal }),
    staleTime: 60_000,
    refetchInterval: (query) => {
      const state = query.state.data?.status.syncState;
      return state === 'queued' || state === 'refreshing' ? 2_000 : false;
    },
  });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const lock = useRef(false);
  const table = useRef<HTMLElement>(null);
  async function sync() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await queryClient.cancelQueries({ queryKey, exact: true });
      const data = await api<PaperCatalog>(endpoint, { method: 'POST', body: {} });
      queryClient.setQueryData(queryKey, data);
    } catch (failure) {
      setError(failure);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const data = catalog.data;
  const syncState = data?.status.syncState ?? 'idle';
  const syncing = busy || syncState !== 'idle';
  // Fill orders Minecraft releases newest first, including final releases after
  // their prereleases. Build dates and lexical ordering cannot reconstruct that.
  const items = (data?.versions ?? []).filter((item) =>
    item.version.toLowerCase().includes(search.toLowerCase().trim()),
  );
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages);
  return (
    <section className="paper-version-catalog" aria-label={t('paperCatalog.title')}>
      <VersionCatalogFrame
        navigation={navigation}
        actions={
          <button
            type="button"
            className="secondary"
            disabled={syncing}
            onClick={() => void sync()}
          >
            <MinecraftAdminIcon kind="scan" />
            {t(
              syncState === 'queued'
                ? 'fabricCatalog.queued'
                : syncing
                  ? 'fabricCatalog.syncing'
                  : 'versions.detect',
            )}
          </button>
        }
        filters={
          <label className="minecraft-versions-search">
            <span className="visually-hidden">{t('versions.search')}</span>
            <input
              type="search"
              value={search}
              maxLength={128}
              placeholder={t('versions.search')}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
                table.current?.scrollTo({ top: 0 });
              }}
            />
          </label>
        }
        footer={
          <div className="minecraft-versions-footer">
            <span className="muted">{t('versions.count', { count: items.length })}</span>
            <nav className="minecraft-variant-pagination" aria-label={t('versions.pagination')}>
              <button
                type="button"
                className="secondary"
                disabled={current <= 1}
                onClick={() => {
                  setPage(current - 1);
                  table.current?.scrollTo({ top: 0 });
                }}
              >
                {t('web.previous')}
              </button>
              <span>{t('versions.page', { page: current, pages })}</span>
              <button
                type="button"
                className="secondary"
                disabled={current >= pages}
                onClick={() => {
                  setPage(current + 1);
                  table.current?.scrollTo({ top: 0 });
                }}
              >
                {t('web.next')}
              </button>
            </nav>
          </div>
        }
        status={
          <div className="paper-catalog-status muted" role="status">
            <span>{t('paperCatalog.buildPolicy')}</span>
            {data?.status.lastSuccessAt && (
              <span>
                {t('fabricCatalog.lastSync')} <Time value={data.status.lastSuccessAt} />
                {data.status.stale && ` · ${t('fabricCatalog.stale')}`}
              </span>
            )}
          </div>
        }
      >
        {(error || catalog.error) && (
          <ErrorNotice
            error={error || catalog.error}
            retry={() => {
              if (error) void sync();
              else void catalog.refetch();
            }}
          />
        )}
        {data?.status.lastError && (
          <p role="status" className="muted">
            {t('fabricCatalog.syncFailed')}
          </p>
        )}
        <section
          ref={table}
          className="minecraft-versions-table paper-catalog-table"
          aria-busy={catalog.isPending}
          aria-label={t('paperCatalog.title')}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the catalog.
          tabIndex={0}
        >
          {catalog.isPending ? (
            <Loading />
          ) : (
            <table>
              <caption className="visually-hidden">{t('paperCatalog.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('fabricCatalog.games')}</th>
                  <th scope="col">{t('paperCatalog.latestBuild')}</th>
                  <th scope="col">{t('versions.java')}</th>
                </tr>
              </thead>
              <tbody>
                {items.slice((current - 1) * pageSize, current * pageSize).map((item) => (
                  <tr key={item.version}>
                    <td>{item.version}</td>
                    <td>
                      <span>{item.buildId}</span>
                      <span className="paper-build-channel muted">
                        {['STABLE', 'RECOMMENDED', 'EXPERIMENTAL', 'ALPHA', 'BETA'].includes(
                          item.channel,
                        )
                          ? t(`paperCatalog.channel.${item.channel}`)
                          : item.channel}
                      </span>
                    </td>
                    <td>{item.javaMajor}</td>
                  </tr>
                ))}
                {!items.length && (
                  <tr>
                    <td colSpan={3} className="paper-catalog-empty">
                      {t(
                        data
                          ? data.synced
                            ? 'fabricCatalog.noMatches'
                            : 'paperCatalog.notSynced'
                          : 'web.unavailable',
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </section>
      </VersionCatalogFrame>
    </section>
  );
}
