import type { FabricCatalogResponse } from '@nickhosting/minecraft/ui';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api, queryClient } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { ErrorNotice, Loading, Select, Time } from '../components/ui.js';
import { MinecraftAdminIcon } from './minecraft-admin-presentation.js';
import { VersionCatalogFrame } from './version-catalog-frame.js';

const endpoint = '/v1/owner/minecraft/fabric/catalog';
const queryKey = ['owner-fabric-catalog'];
const pageSize = 25;

/** Independent version catalogs, read locally; creation freezes a selection on submit. */
export function FabricVersionCatalog({
  navigation,
  kind,
}: {
  navigation: ReactNode;
  kind: 'games' | 'loaders' | 'installers';
}) {
  const t = useT();
  const catalog = useQuery({
    queryKey,
    queryFn: ({ signal }) => api<FabricCatalogResponse>(endpoint, { signal }),
    staleTime: 60_000,
    refetchInterval: (query) => {
      const state = query.state.data?.status.syncState;
      return state === 'queued' || state === 'refreshing' ? 2_000 : false;
    },
  });
  const [search, setSearch] = useState('');
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const lock = useRef(false);
  const table = useRef<HTMLElement>(null);
  const previousKind = useRef(kind);
  const reset = () => {
    setPage(1);
    table.current?.scrollTo({ top: 0 });
  };
  useEffect(() => {
    if (previousKind.current === kind) return;
    previousKind.current = kind;
    setSearch('');
    setPage(1);
    table.current?.scrollTo({ top: 0 });
  }, [kind]);
  async function sync() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await queryClient.cancelQueries({ queryKey, exact: true });
      const data = await api<FabricCatalogResponse>(endpoint, { method: 'POST', body: {} });
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
  const items = (data?.[kind] ?? []).filter(
    (item) =>
      (kind !== 'games' || all || item.stable) &&
      item.version.toLowerCase().includes(search.toLowerCase().trim()),
  );
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages);
  return (
    <section className="fabric-version-catalog" aria-label={t('fabricCatalog.discovery')}>
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
                  : 'fabricCatalog.sync',
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
                onChange={(e) => {
                  setSearch(e.target.value);
                  reset();
                }}
              />
            </label>
            {kind === 'games' && (
              <Select
                label={t('catalog.releaseType')}
                value={all ? 'all' : 'release'}
                onChange={(event) => {
                  setAll(event.target.value === 'all');
                  reset();
                }}
              >
                <option value="release">{t('versions.releasesOnly')}</option>
                <option value="all">{t('versions.allVersions')}</option>
              </Select>
            )}
          </>
        }
        footer={
          <div className="minecraft-versions-footer fabric-catalog-footer">
            <span className="muted">{t('fabricCatalog.count', { count: items.length })}</span>
            <div className="minecraft-variant-pagination">
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
            </div>
          </div>
        }
        status={
          <div className="fabric-catalog-status muted">
            <span>
              {t('fabricCatalog.installerPolicy', {
                version: data?.latestInstallerVersion ?? '—',
              })}
            </span>
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
          className="minecraft-versions-table fabric-catalog-table"
          aria-busy={catalog.isPending}
          aria-label={t(`fabricCatalog.${kind}`)}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the catalog.
          tabIndex={0}
        >
          {catalog.isPending ? (
            <Loading />
          ) : (
            <table>
              <caption className="visually-hidden">{t(`fabricCatalog.${kind}`)}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('fabricCatalog.version')}</th>
                  <th scope="col">{t('fabricCatalog.channel')}</th>
                </tr>
              </thead>
              <tbody>
                {items.slice((current - 1) * pageSize, current * pageSize).map((item) => (
                  <tr key={item.version}>
                    <td>
                      {item.version}
                      {kind === 'installers' && item.version === data?.latestInstallerVersion && (
                        <span className="version-catalog-badge fabric-latest">
                          {t('fabricCatalog.latest')}
                        </span>
                      )}
                    </td>
                    <td className="muted">
                      <span className="version-catalog-badge">
                        {t(item.stable ? 'fabricCatalog.stable' : 'fabricCatalog.preview')}
                      </span>
                    </td>
                  </tr>
                ))}
                {!items.length && (
                  <tr>
                    <td colSpan={2} className="fabric-catalog-empty">
                      {t(data?.synced ? 'fabricCatalog.noMatches' : 'fabricCatalog.notSynced')}
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
