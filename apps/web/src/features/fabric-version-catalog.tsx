import type { FabricCatalogResponse } from '@nickhosting/minecraft/ui';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, queryClient } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { ErrorNotice, Loading, Time } from '../components/ui.js';
import { MinecraftAdminIcon } from './minecraft-admin-presentation.js';

const endpoint = '/v1/owner/minecraft/fabric/catalog';
const queryKey = ['owner-fabric-catalog'];
const pageSize = 25;

/** Discovery is independent of egg mappings and registered creation choices. */
export function FabricVersionCatalog() {
  const t = useT();
  const catalog = useQuery({
    queryKey,
    queryFn: ({ signal }) => api<FabricCatalogResponse>(endpoint, { signal }),
    staleTime: 60_000,
  });
  const [kind, setKind] = useState<'games' | 'loaders' | 'installers'>('games');
  const [search, setSearch] = useState('');
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const lock = useRef(false);
  const table = useRef<HTMLElement>(null);
  const reset = () => {
    setPage(1);
    table.current?.scrollTo({ top: 0 });
  };
  async function sync() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try {
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
  const items = (data?.[kind] ?? []).filter(
    (item) =>
      (kind !== 'games' || all || item.stable) &&
      item.version.toLowerCase().includes(search.toLowerCase().trim()),
  );
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages);
  return (
    <section className="fabric-version-catalog" aria-label={t('fabricCatalog.discovery')}>
      <div className="fabric-catalog-heading">
        <fieldset className="fabric-catalog-tabs" aria-label={t('fabricCatalog.kind')}>
          {(['games', 'loaders', 'installers'] as const).map((value) => (
            <button
              type="button"
              className="secondary"
              key={value}
              aria-pressed={kind === value}
              onClick={() => {
                setKind(value);
                reset();
              }}
            >
              {t(`fabricCatalog.${value}`)}
            </button>
          ))}
        </fieldset>
        <button type="button" className="secondary" disabled={busy} onClick={() => void sync()}>
          <MinecraftAdminIcon kind="scan" />
          {t(busy ? 'fabricCatalog.syncing' : 'fabricCatalog.sync')}
        </button>
      </div>
      <div className="minecraft-versions-toolbar">
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
          <button
            type="button"
            className="secondary"
            aria-pressed={all}
            onClick={() => {
              setAll(!all);
              reset();
            }}
          >
            {t('fabricCatalog.showAll')}
          </button>
        )}
      </div>
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
        className="fabric-catalog-table"
        aria-busy={busy || catalog.isPending}
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
                      <span className="fabric-latest">{t('fabricCatalog.latest')}</span>
                    )}
                  </td>
                  <td className="muted">
                    {kind === 'games'
                      ? t(item.stable ? 'fabricCatalog.stable' : 'fabricCatalog.preview')
                      : item.stable
                        ? t('fabricCatalog.recommended')
                        : '—'}
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
      <div className="fabric-catalog-footer">
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
      <div className="fabric-catalog-status muted">
        <span>
          {t('fabricCatalog.installerPolicy', { version: data?.latestInstallerVersion ?? '—' })}
        </span>
        {data?.status.lastSuccessAt && (
          <span>
            {t('fabricCatalog.lastSync')} <Time value={data.status.lastSuccessAt} />
            {data.status.stale && ` · ${t('fabricCatalog.stale')}`}
          </span>
        )}
      </div>
    </section>
  );
}
