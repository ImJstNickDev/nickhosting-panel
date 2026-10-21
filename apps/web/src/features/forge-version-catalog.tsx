import type { ForgeCatalogResponse } from '@nickhosting/minecraft/ui';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useRef, useState } from 'react';
import { api, queryClient } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { ErrorNotice, Loading, Select, Time } from '../components/ui.js';
import { MinecraftAdminIcon } from './minecraft-admin-presentation.js';
import { VersionCatalogFrame } from './version-catalog-frame.js';

const endpoint = '/v1/owner/minecraft/forge/catalog';
const queryKey = ['owner-forge-catalog'];
const pageSize = 25;

/** Discovery reads a local snapshot and never creates an egg mapping. */
export function ForgeVersionCatalog({ navigation }: { navigation: ReactNode }) {
  const t = useT();
  const catalog = useQuery({
    queryKey,
    queryFn: ({ signal }) => api<ForgeCatalogResponse>(endpoint, { signal }),
    staleTime: 60_000,
    refetchInterval: (query) => {
      const state = query.state.data?.status.syncState;
      return state === 'queued' || state === 'refreshing' ? 2_000 : false;
    },
  });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [minecraftVersion, setMinecraftVersion] = useState('');
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
      const data = await api<ForgeCatalogResponse>(endpoint, { method: 'POST', body: {} });
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
  const selected =
    data?.versions.find((entry) => entry.minecraftVersion === minecraftVersion) ??
    data?.versions[0];
  const items = (selected?.loaders ?? []).filter((item) =>
    item.version.toLowerCase().includes(search.toLowerCase().trim()),
  );
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages);
  return (
    <section
      className="forge-version-catalog paper-version-catalog"
      aria-label={t('forgeCatalog.title')}
    >
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
          <>
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
            <Select
              label={t('fabricCatalog.games')}
              value={selected?.minecraftVersion ?? ''}
              disabled={!data?.versions.length}
              onChange={(event) => {
                setMinecraftVersion(event.target.value);
                setSearch('');
                setPage(1);
                table.current?.scrollTo({ top: 0 });
              }}
            >
              {(data?.versions ?? []).map((entry) => (
                <option key={entry.minecraftVersion} value={entry.minecraftVersion}>
                  {entry.minecraftVersion}
                </option>
              ))}
            </Select>
          </>
        }
        footer={
          <div className="minecraft-versions-footer">
            <span className="muted">{t('fabricCatalog.count', { count: items.length })}</span>
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
            <span>{t('forgeCatalog.buildPolicy')}</span>
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
          className="minecraft-versions-table paper-catalog-table forge-catalog-table"
          aria-busy={catalog.isPending}
          aria-label={t('forgeCatalog.title')}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the catalog.
          tabIndex={0}
        >
          {catalog.isPending ? (
            <Loading />
          ) : (
            <table>
              <caption className="visually-hidden">{t('forgeCatalog.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('forgeCatalog.build')}</th>
                  <th scope="col">{t('fabricCatalog.channel')}</th>
                  <th scope="col">{t('versions.java')}</th>
                </tr>
              </thead>
              <tbody>
                {items.slice((current - 1) * pageSize, current * pageSize).map((item) => (
                  <tr key={item.version}>
                    <td>{item.version}</td>
                    <td>
                      {item.recommended && (
                        <span className="version-catalog-badge">
                          {t('forgeCatalog.recommended')}
                        </span>
                      )}
                      {item.latest && (
                        <span className="paper-build-channel muted">
                          {t('fabricCatalog.latest')}
                        </span>
                      )}
                      {!item.recommended && !item.latest && <span className="muted">—</span>}
                    </td>
                    <td>{selected?.javaMajor}</td>
                  </tr>
                ))}
                {!items.length && (
                  <tr>
                    <td colSpan={3} className="paper-catalog-empty">
                      {t(
                        data
                          ? data.synced
                            ? 'fabricCatalog.noMatches'
                            : 'forgeCatalog.notSynced'
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
