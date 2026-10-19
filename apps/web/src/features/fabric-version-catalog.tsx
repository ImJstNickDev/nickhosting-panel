import type { FabricCatalogResponse } from '@nickhosting/minecraft/ui';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, queryClient } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { ErrorNotice, Loading, Select, Time } from '../components/ui.js';
import type { Mapping } from './minecraft-admin-model.js';
import { MinecraftAdminIcon } from './minecraft-admin-presentation.js';
import { VersionCatalogFrame } from './version-catalog-frame.js';

const endpoint = '/v1/owner/minecraft/fabric/catalog';
const queryKey = ['owner-fabric-catalog'];
const pageSize = 25;

/** Catalog reads stay local; registration binds a chosen pair to an Owner mapping. */
export function FabricVersionCatalog({
  navigation,
  kind,
  mapping,
  mappingContext,
  onRegistered,
}: {
  navigation: ReactNode;
  kind: 'games' | 'loaders' | 'installers';
  mapping?: Mapping;
  mappingContext: ReactNode;
  onRegistered: (id: string, mappingId: string) => void;
}) {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const requestedGame = params.get('fabricGame') ?? '';
  const focusLoaders = useRef(false);
  const filters = useRef<HTMLDivElement>(null);
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
  const [registrationError, setRegistrationError] = useState<unknown>();
  const [registering, setRegistering] = useState<string | null>(null);
  const registrationLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const registrationScope = `${mapping?.id ?? ''}:${requestedGame}:${kind}`;
  const currentRegistrationScope = useRef(registrationScope);
  currentRegistrationScope.current = registrationScope;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A registration error belongs to its mapping and selected game.
  useEffect(() => setRegistrationError(undefined), [registrationScope]);
  const lock = useRef(false);
  const table = useRef<HTMLElement>(null);
  const previousKind = useRef(kind);
  const previousGame = useRef(requestedGame);
  const reset = () => {
    setPage(1);
    table.current?.scrollTo({ top: 0 });
  };
  useEffect(() => {
    if (previousKind.current === kind && previousGame.current === requestedGame) return;
    previousKind.current = kind;
    previousGame.current = requestedGame;
    setSearch('');
    setPage(1);
    table.current?.scrollTo({ top: 0 });
    if (kind === 'loaders' && focusLoaders.current) {
      filters.current?.querySelector('select')?.focus();
      focusLoaders.current = false;
    }
  }, [kind, requestedGame]);
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
  const game =
    data?.relations && data.games.some((item) => item.version === requestedGame)
      ? requestedGame
      : '';
  const loaderSetIndex = data?.relations?.gameLoaderSets[game];
  const compatibleLoaders = new Set(
    loaderSetIndex === undefined ? [] : (data?.relations?.loaderSets[loaderSetIndex] ?? []),
  );
  async function register(loaderVersion: string) {
    if (!game || !mapping || mapping.enabled === false || registrationLock.current) return;
    const scope = registrationScope;
    registrationLock.current = true;
    setRegistering(loaderVersion);
    setRegistrationError(undefined);
    try {
      const result = await api<{ id: string }>('/v1/owner/minecraft/fabric/combinations', {
        method: 'POST',
        body: { mappingId: mapping.id, release: game, loaderVersion },
      });
      void queryClient.invalidateQueries({ queryKey: ['owner-minecraft-compatibility'] });
      void queryClient.invalidateQueries({ queryKey: ['owner-minecraft-detail', result.id] });
      void queryClient.invalidateQueries({ queryKey: ['creation'] });
      if (mounted.current && currentRegistrationScope.current === scope)
        onRegistered(result.id, mapping.id);
    } catch (failure) {
      if (mounted.current && currentRegistrationScope.current === scope)
        setRegistrationError(failure);
    } finally {
      registrationLock.current = false;
      if (mounted.current) setRegistering(null);
    }
  }
  const registrationVisible = kind === 'loaders' && Boolean(game);
  function chooseGame(version: string) {
    focusLoaders.current = kind !== 'loaders';
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('fabricKind', 'loaders');
      next.set('fabricView', 'discovery');
      if (version) next.set('fabricGame', version);
      else next.delete('fabricGame');
      return next;
    });
    reset();
  }
  const items = (data?.[kind] ?? []).filter(
    (item) =>
      (kind !== 'games' || all || item.stable) &&
      (kind !== 'loaders' || !game || compatibleLoaders.has(item.version)) &&
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
            {kind === 'loaders' && (
              <div ref={filters}>
                <Select
                  label={t('fabricCatalog.gameVersion')}
                  value={game}
                  disabled={!data?.relations}
                  onChange={(event) => chooseGame(event.target.value)}
                >
                  <option value="">{t('fabricCatalog.allLoaders')}</option>
                  {data?.games.map((item) => (
                    <option key={item.version} value={item.version}>
                      {item.version}
                    </option>
                  ))}
                </Select>
              </div>
            )}
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
          <>
            {registrationVisible && mappingContext}
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
          </>
        }
      >
        {registrationError !== undefined && <ErrorNotice error={registrationError} />}
        {(error || catalog.error) && (
          <ErrorNotice
            error={error || catalog.error}
            retry={() => {
              if (error) void sync();
              else void catalog.refetch();
            }}
          />
        )}
        {data?.synced && !data.relations && (
          <p role="status" className="muted">
            {t('fabricCatalog.relationsPending')}
          </p>
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
            <table className={registrationVisible ? 'fabric-register-table' : undefined}>
              <caption className="visually-hidden">{t(`fabricCatalog.${kind}`)}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('fabricCatalog.version')}</th>
                  <th scope="col">{t('fabricCatalog.channel')}</th>
                  {registrationVisible && (
                    <th scope="col" className="fabric-register-column">
                      <span className="visually-hidden">{t('web.actions')}</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {items.slice((current - 1) * pageSize, current * pageSize).map((item) => (
                  <tr key={item.version}>
                    <td>
                      {kind === 'games' && data?.relations ? (
                        <button
                          type="button"
                          className="fabric-game-link"
                          aria-label={t('fabricCatalog.loadersFor', { version: item.version })}
                          onClick={() => chooseGame(item.version)}
                        >
                          {item.version}
                          <span aria-hidden="true">›</span>
                        </button>
                      ) : (
                        item.version
                      )}
                      {kind === 'installers' && item.version === data?.latestInstallerVersion && (
                        <span className="version-catalog-badge fabric-latest">
                          {t('fabricCatalog.latest')}
                        </span>
                      )}
                    </td>
                    <td className="muted">
                      {kind === 'games' || item.stable ? (
                        <span className="version-catalog-badge">
                          {kind === 'games'
                            ? t(item.stable ? 'fabricCatalog.stable' : 'fabricCatalog.preview')
                            : t('fabricCatalog.recommended')}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    {registrationVisible && (
                      <td className="fabric-register-column">
                        <button
                          type="button"
                          className="secondary fabric-register"
                          disabled={!mapping || mapping.enabled === false || registering !== null}
                          aria-label={t('fabricCatalog.registerPair', {
                            game,
                            loader: item.version,
                          })}
                          onClick={() => void register(item.version)}
                        >
                          {t(
                            registering === item.version
                              ? 'fabricCatalog.registering'
                              : 'fabricCatalog.register',
                          )}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {!items.length && (
                  <tr>
                    <td colSpan={registrationVisible ? 3 : 2} className="fabric-catalog-empty">
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
