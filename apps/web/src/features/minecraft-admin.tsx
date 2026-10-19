import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigationType, useSearchParams } from 'react-router';
import type { GameManifest } from '../../../../packages/game-sdk/src/index.js';
import { ApiError, api, queryClient } from '../api/client.js';
import { useLocale, useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
import { Dialog, Empty, ErrorNotice, Loading, Notice, Select, Time } from '../components/ui.js';
import { FabricVersionCatalog } from './fabric-version-catalog.js';
import { MinecraftProtocolSettings } from './integration-game-settings.js';
import { CombinationDetail } from './minecraft-admin-detail.js';
import {
  type Combination,
  mappingsQuery,
  type ReleaseGroup,
  useMappingLabel,
} from './minecraft-admin-model.js';
import { PendingCatalogSearch } from './minecraft-admin-navigation.js';
import { CreationState, MinecraftAdminIcon } from './minecraft-admin-presentation.js';
import { RegisterCombination } from './minecraft-admin-register.js';
import { VersionCatalogFrame } from './version-catalog-frame.js';

export { MinecraftCatalogScan } from './minecraft-admin-scan.js';

import './minecraft-admin.css';

function FeatureIndicators({ choice }: { choice: Combination }) {
  const t = useT();
  return (
    <span className="minecraft-version-features">
      {(['gateway', 'sleepWake'] as const).map((feature) => (
        <Tooltip
          key={feature}
          content={`${t(`gameAdmin.capability.${feature}`)}: ${t(choice.capabilities?.[feature] ? 'gameUi.yes' : 'gameUi.no')}`}
        >
          <span
            role="img"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Feature tooltips also support keyboard focus.
            tabIndex={0}
            className={choice.capabilities?.[feature] ? '' : 'unavailable'}
            aria-label={`${t(`gameAdmin.capability.${feature}`)}: ${t(choice.capabilities?.[feature] ? 'gameUi.yes' : 'gameUi.no')}`}
          >
            <MinecraftAdminIcon kind={feature === 'gateway' ? 'gateway' : 'sleep'} />
          </span>
        </Tooltip>
      ))}
    </span>
  );
}
function ReleaseDate({ value }: { value: string | null | undefined }) {
  const { locale } = useLocale(),
    t = useT();
  return value ? (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(new Date(value))}
    </time>
  ) : (
    <span className="muted">{t('web.unknown')}</span>
  );
}
/** One scoped catalog. All remote eligibility is aggregated by the Owner endpoint. */
export function OwnerMinecraftPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const location = useLocation(),
    navigationKind = useNavigationType();
  const detailFocus = useRef<HTMLElement | null>(null);
  const mappingLabel = useMappingLabel();
  const mappings = useQuery(mappingsQuery);
  const modules = useQuery({
    queryKey: ['owner-game-modules'],
    queryFn: ({ signal }) =>
      api<Array<{ id: string; manifest: GameManifest }>>('/v1/owner/game-modules', { signal }),
    staleTime: 60_000,
  });
  const runtimes = modules.data?.find((m) => m.id === 'minecraft')?.manifest.runtimes ?? [];
  const runtime =
    runtimes.find((r) => r.id === params.get('runtime'))?.id ?? runtimes[0]?.id ?? 'vanilla';
  const fabricDiscovery = runtime === 'fabric';
  const fabricKind =
    params.get('fabricKind') === 'loaders'
      ? 'loaders'
      : params.get('fabricKind') === 'installers'
        ? 'installers'
        : 'games';
  const eligible =
    mappings.data?.filter((m) => m.game_id === 'minecraft' && m.runtime_id === runtime) ?? [];
  const mapping = eligible.find((m) => m.id === params.get('mapping')) ?? eligible[0];
  const scope = `${runtime}:${mapping?.id ?? ''}`;
  const page = Math.max(1, Number(params.get('catalogPage')) || 1),
    search = params.get('catalogSearch') ?? '',
    order = params.get('catalogOrder') ?? 'newest';
  const releaseType = params.get('catalog-releaseType') ?? '',
    availability = params.get('catalog-availability') ?? '';
  const pendingSearch = useRef(new PendingCatalogSearch(location.key, params.toString()));
  pendingSearch.current.reconcile(location.key, params.toString(), navigationKind);
  const update = (patch: Record<string, string>, reset = false) => {
    if (bulkBusy) return;
    if (patch.combination) detailFocus.current = document.activeElement as HTMLElement | null;
    setParams(pendingSearch.current.patch(patch, reset), { replace: true });
  };
  const query = {
    runtime,
    mappingId: mapping?.id ?? '',
    page: String(page),
    pageSize: '25',
    search,
    order,
    releaseType,
    availability,
  };
  type WorkspaceResponse = {
    items: ReleaseGroup[];
    total: number;
    page: number;
    pageSize: number;
    metadataStatus: { lastSuccessAt: string | null; stale: boolean };
  };
  const catalog = useQuery<WorkspaceResponse>({
    queryKey: ['owner-minecraft-compatibility', 'workspace', scope, query],
    enabled: Boolean(mapping) && !fabricDiscovery,
    staleTime: 60_000,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === scope ? keepPreviousData(previous) : undefined,
    queryFn: ({ signal }) =>
      api<{
        items: ReleaseGroup[];
        total: number;
        page: number;
        pageSize: number;
        metadataStatus: { lastSuccessAt: string | null; stale: boolean };
      }>(
        `/v1/owner/minecraft/compatibility?${new URLSearchParams(Object.entries({ view: 'workspace', ...query }).filter(([, value]) => value !== ''))}`,
        { signal },
      ),
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [visibleVariants, setVisibleVariants] = useState<Record<string, string[]>>({});
  const [bulkBusy, setBulkBusy] = useState(false),
    [bulkError, setBulkError] = useState<unknown>();
  const [advanced, setAdvanced] = useState<'menu' | 'register' | 'protocol' | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection and scroll belong to the exact visible catalog scope.
  useEffect(() => {
    setSelected(new Set());
    setExpanded(new Set());
    setVisibleVariants({});
    setBulkError(undefined);
    tableRef.current?.scrollTo({ top: 0 });
  }, [scope, page, search, order, releaseType, availability]);
  useEffect(() => {
    if (advanced !== 'menu') return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setAdvanced(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [advanced]);
  const selectedId = params.get('combination') ?? '';
  useEffect(() => {
    if (selectedId || !detailFocus.current) return;
    const target = detailFocus.current;
    detailFocus.current = null;
    const frame = requestAnimationFrame(() => {
      const fallback = document.querySelector<HTMLElement>('.minecraft-versions-search input');
      (target.isConnected ? target : fallback)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId]);
  const detail = useQuery({
    queryKey: ['owner-minecraft-detail', selectedId],
    enabled: Boolean(selectedId),
    queryFn: ({ signal }) =>
      api<Combination>(`/v1/owner/minecraft/compatibility/${selectedId}`, { signal }),
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['owner-minecraft-compatibility'] }),
      queryClient.invalidateQueries({ queryKey: ['owner-minecraft-detail'] }),
      queryClient.invalidateQueries({ queryKey: ['creation'] }),
    ]);
  };
  const choose = (ids: string[], checked: boolean) => {
    const next = new Set(selected);
    for (const id of ids) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    if (next.size > 500) {
      setBulkError(new ApiError('validation_failed', 'versions.selectionLimit'));
      return;
    }
    setSelected(next);
    setBulkError(undefined);
  };
  async function bulk(enabled: boolean) {
    if (!mapping || !selected.size || bulkBusy) return;
    setBulkBusy(true);
    setBulkError(undefined);
    try {
      await api('/v1/owner/minecraft/compatibility/availability', {
        method: 'PUT',
        body: { mappingId: mapping.id, ids: [...selected], enabled },
      });
      setSelected(new Set());
      await refresh();
    } catch (error) {
      setBulkError(error);
    } finally {
      setBulkBusy(false);
    }
  }
  const items = catalog.data?.items ?? [];
  const ids = items.flatMap((group) =>
    group.choice
      ? [group.choice.id]
      : expanded.has(group.release)
        ? (visibleVariants[group.release] ?? [])
        : [],
  );
  const busy = bulkBusy || catalog.isPlaceholderData;
  const sort = (kind: 'name' | 'date') => {
    const latest = pendingSearch.current.current().get('catalogOrder') ?? 'newest';
    update(
      {
        catalogOrder:
          kind === 'date'
            ? latest === 'newest'
              ? 'oldest'
              : 'newest'
            : latest === 'name-asc'
              ? 'name-desc'
              : 'name-asc',
      },
      true,
    );
  };
  const pages = Math.max(1, Math.ceil((catalog.data?.total ?? 0) / 25));
  const catalogNavigation =
    runtime === 'fabric' ? (
      <fieldset className="version-catalog-datasets" aria-label={t('fabricCatalog.view')}>
        {(['games', 'loaders', 'installers'] as const).map((view) => (
          <button
            type="button"
            key={view}
            aria-pressed={fabricKind === view}
            onClick={() => update({ fabricKind: view, fabricView: '', combination: '' })}
          >
            {t(`fabricCatalog.${view}`)}
          </button>
        ))}
      </fieldset>
    ) : (
      <h2>{t('versions.minecraftVersions')}</h2>
    );
  const mappingContext = (
    <div className="minecraft-versions-context">
      <div className="minecraft-versions-mapping">
        {eligible.length > 1 ? (
          <Select
            label={t('gameAdmin.mapping')}
            disabled={bulkBusy}
            value={mapping?.id ?? ''}
            onChange={(e) => update({ mapping: e.target.value }, true)}
          >
            {eligible.map((m) => (
              <option key={m.id} value={m.id}>
                {mappingLabel(m, false)}
              </option>
            ))}
          </Select>
        ) : mapping ? (
          <span>
            <span className="muted">{t('gameAdmin.mapping')}</span>
            <strong>{mappingLabel(mapping, false)}</strong>
          </span>
        ) : (
          <span className="muted">{t('gameAdmin.noMapping')}</span>
        )}
      </div>
      {mapping?.enabled === false && (
        <span id="minecraft-mapping-disabled" className="muted">
          {t('versions.mappingDisabled')}
        </span>
      )}
      <Tooltip content={t('versions.configureMapping')}>
        <Link
          className="minecraft-icon-button"
          aria-label={t('versions.configureMapping')}
          to={{
            pathname: '/owner/integrations/minecraft/runtime',
            search: `?runtime=${encodeURIComponent(runtime)}`,
          }}
        >
          <MinecraftAdminIcon kind="settings" />
        </Link>
      </Tooltip>
    </div>
  );
  const advancedMenu = (
    <div className="minecraft-versions-advanced" ref={menuRef}>
      <Tooltip content={t('versions.advanced')}>
        <button
          type="button"
          className="minecraft-icon-button"
          aria-label={t('versions.advanced')}
          aria-expanded={advanced === 'menu'}
          onClick={() => setAdvanced(advanced === 'menu' ? null : 'menu')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setAdvanced(null);
              e.stopPropagation();
            }
          }}
        >
          <MinecraftAdminIcon kind="more" />
        </button>
      </Tooltip>
      {advanced === 'menu' && (
        <fieldset
          className="minecraft-versions-menu"
          aria-label={t('versions.advanced')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setAdvanced(null);
              menuRef.current?.querySelector('button')?.focus();
            }
          }}
        >
          <button type="button" onClick={() => setAdvanced('register')}>
            {t('gameAdmin.advancedRegistration')}
          </button>
          <button type="button" onClick={() => setAdvanced('protocol')}>
            {t('integrationConfig.protocolSource')}
          </button>
        </fieldset>
      )}
    </div>
  );
  const filters = (
    <>
      {eligible.length > 1 && mappingContext}
      <div className="minecraft-versions-toolbar">
        <label className="minecraft-versions-search">
          <span className="visually-hidden">{t('versions.search')}</span>
          <input
            disabled={bulkBusy}
            type="search"
            maxLength={200}
            value={search}
            placeholder={t('versions.search')}
            onChange={(e) => update({ catalogSearch: e.target.value }, true)}
          />
        </label>
        <Select
          label={t('catalog.releaseType')}
          disabled={bulkBusy}
          value={releaseType}
          onChange={(e) => update({ 'catalog-releaseType': e.target.value }, true)}
        >
          <option value="">{t('versions.allTypes')}</option>
          {['release', 'snapshot', 'old_beta', 'old_alpha', 'unknown'].map((type) => (
            <option key={type} value={type}>
              {t(`catalog.type.${type}`)}
            </option>
          ))}
        </Select>
        <Select
          label={t('gameAdmin.availability')}
          disabled={bulkBusy}
          value={availability}
          onChange={(e) => update({ 'catalog-availability': e.target.value }, true)}
        >
          <option value="">{t('versions.allAvailability')}</option>
          <option value="enabled">{t('web.enabled')}</option>
          <option value="disabled">{t('web.disabled')}</option>
        </Select>
        <div className="version-catalog-mobile-order">
          <Select
            label={t('catalog.order')}
            value={order}
            disabled={bulkBusy}
            onChange={(event) => update({ catalogOrder: event.target.value }, true)}
          >
            {['newest', 'oldest', 'name-asc', 'name-desc'].map((value) => (
              <option key={value} value={value}>
                {t(`catalog.order.${value}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </>
  );
  const metadataStatus = catalog.data?.metadataStatus && (
    <div className="minecraft-metadata-status">
      {!catalog.data.metadataStatus.lastSuccessAt ? (
        <Notice>{t('catalog.metadataMissing')}</Notice>
      ) : catalog.data.metadataStatus.stale ? (
        <Notice>{t('catalog.metadataStale')}</Notice>
      ) : (
        <span className="muted">
          {t('catalog.metadataUpdated')}: <Time value={catalog.data.metadataStatus.lastSuccessAt} />
        </span>
      )}
    </div>
  );
  return (
    <div className="minecraft-versions-workspace">
      <fieldset className="integration-runtime-selector" aria-label={t('ownerIntegration.runtime')}>
        {runtimes.map((r) => (
          <button
            type="button"
            className="secondary"
            key={r.id}
            disabled={bulkBusy}
            aria-pressed={runtime === r.id}
            onClick={() => update({ runtime: r.id, mapping: '' }, true)}
          >
            {t(r.nameKey)}
          </button>
        ))}
      </fieldset>
      {fabricDiscovery ? (
        <FabricVersionCatalog kind={fabricKind} navigation={catalogNavigation} />
      ) : (
        <>
          <VersionCatalogFrame
            navigation={catalogNavigation}
            actions={
              <>
                <span id="minecraft-catalog-scan-trigger" className="minecraft-scan-trigger" />
                {advancedMenu}
              </>
            }
            filters={filters}
            status={
              <>
                {eligible.length <= 1 && mappingContext}
                {metadataStatus}
              </>
            }
          >
            {mappings.error && (
              <ErrorNotice error={mappings.error} retry={() => void mappings.refetch()} />
            )}
            {modules.error && (
              <ErrorNotice error={modules.error} retry={() => void modules.refetch()} />
            )}
            <div id="minecraft-catalog-scan-progress" />
            {bulkError !== undefined && <ErrorNotice error={bulkError} />}
            {selected.size > 0 && (
              <section
                className="minecraft-versions-selection"
                aria-label={t('versions.selectionActions')}
              >
                <strong>{t('versions.selected', { count: selected.size })}</strong>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void bulk(true)}
                >
                  {t('versions.enable')}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void bulk(false)}
                >
                  {t('versions.disable')}
                </button>
                <Tooltip content={t('versions.clearSelection')}>
                  <button
                    type="button"
                    className="minecraft-icon-button"
                    disabled={bulkBusy}
                    aria-label={t('versions.clearSelection')}
                    onClick={() => setSelected(new Set())}
                  >
                    <MinecraftAdminIcon kind="close" />
                  </button>
                </Tooltip>
                {bulkBusy && <span role="status">{t('web.loading')}</span>}
              </section>
            )}
            {!mapping && !mappings.isPending ? (
              <Empty text={t('gameAdmin.noMapping')} />
            ) : catalog.isPending || mappings.isPending ? (
              <div className="version-catalog-loading">
                <Loading />
              </div>
            ) : catalog.error ? (
              <ErrorNotice error={catalog.error} retry={() => void catalog.refetch()} />
            ) : (
              <>
                <section
                  ref={tableRef}
                  className="minecraft-versions-table"
                  aria-label={t('gameAdmin.combinations')}
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the bounded catalog.
                  tabIndex={0}
                  aria-busy={catalog.isFetching}
                >
                  <table>
                    <thead>
                      <tr>
                        <th className="minecraft-selection-cell">
                          <input
                            type="checkbox"
                            aria-label={t('versions.selectPage')}
                            checked={ids.length > 0 && ids.every((id) => selected.has(id))}
                            disabled={busy || !ids.length}
                            ref={(element) => {
                              if (element)
                                element.indeterminate =
                                  ids.some((id) => selected.has(id)) &&
                                  !ids.every((id) => selected.has(id));
                            }}
                            onChange={(e) => choose(ids, e.target.checked)}
                          />
                        </th>
                        <th
                          aria-sort={
                            order === 'name-asc'
                              ? 'ascending'
                              : order === 'name-desc'
                                ? 'descending'
                                : 'none'
                          }
                        >
                          <button type="button" disabled={bulkBusy} onClick={() => sort('name')}>
                            {t('gameAdmin.version')}
                            {order.startsWith('name-') && (
                              <span aria-hidden="true">{order === 'name-asc' ? '↑' : '↓'}</span>
                            )}
                          </button>
                        </th>
                        <th
                          aria-sort={
                            order === 'newest'
                              ? 'descending'
                              : order === 'oldest'
                                ? 'ascending'
                                : 'none'
                          }
                        >
                          <button type="button" disabled={bulkBusy} onClick={() => sort('date')}>
                            {t('versions.published')}
                            {(order === 'newest' || order === 'oldest') && (
                              <span aria-hidden="true">{order === 'newest' ? '↓' : '↑'}</span>
                            )}
                          </button>
                        </th>
                        <th>{t('versions.java')}</th>
                        <th>{t('versions.features')}</th>
                        <th>{t('versions.creation')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.length ? (
                        items.map((group) => (
                          <Fragment key={group.release}>
                            <tr
                              data-release={group.release}
                              data-expanded={expanded.has(group.release) || undefined}
                            >
                              <td className="minecraft-selection-cell">
                                {group.choice && (
                                  <input
                                    type="checkbox"
                                    aria-label={t('versions.selectVersion', {
                                      version: group.release,
                                    })}
                                    disabled={busy}
                                    checked={selected.has(group.choice.id)}
                                    onChange={(e) => {
                                      if (group.choice) choose([group.choice.id], e.target.checked);
                                    }}
                                  />
                                )}
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="minecraft-version-name"
                                  aria-expanded={
                                    group.variantCount > 1 ? expanded.has(group.release) : undefined
                                  }
                                  onClick={() => {
                                    if (group.choice) update({ combination: group.choice.id });
                                    else
                                      setExpanded((old) => {
                                        const next = new Set(old);
                                        if (next.has(group.release)) next.delete(group.release);
                                        else next.add(group.release);
                                        return next;
                                      });
                                  }}
                                >
                                  <span>
                                    {group.variantCount > 1 && (
                                      <MinecraftAdminIcon kind="chevron" />
                                    )}
                                    {group.release}
                                  </span>
                                  <small>{t(`catalog.type.${group.releaseType}`)}</small>
                                  <small className="version-catalog-mobile-date">
                                    <ReleaseDate value={group.releaseTime} />
                                  </small>
                                </button>
                              </td>
                              <td>
                                <ReleaseDate value={group.releaseTime} />
                              </td>
                              {group.choice ? (
                                <>
                                  <td>{group.choice.combination.javaMajor}</td>
                                  <td>
                                    <FeatureIndicators choice={group.choice} />
                                  </td>
                                  <td>
                                    <CreationState choice={group.choice} />
                                  </td>
                                </>
                              ) : (
                                <td colSpan={3} className="muted">
                                  {t('versions.variants', { count: group.variantCount })}
                                </td>
                              )}
                            </tr>
                            {expanded.has(group.release) && mapping && (
                              <VariantRows
                                release={group.release}
                                mappingId={mapping.id}
                                runtime={runtime}
                                availability={availability}
                                releaseType={releaseType}
                                onVisible={(ids) =>
                                  setVisibleVariants((old) => ({ ...old, [group.release]: ids }))
                                }
                                selected={selected}
                                busy={busy}
                                choose={choose}
                                open={(id) => update({ combination: id })}
                              />
                            )}
                          </Fragment>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={6} className="minecraft-empty">
                            {t('web.empty')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </section>
                <footer className="minecraft-versions-footer">
                  <span>{t('versions.count', { count: catalog.data?.total ?? 0 })}</span>
                  <nav aria-label={t('versions.pagination')}>
                    <button
                      type="button"
                      className="secondary"
                      disabled={bulkBusy || page <= 1 || catalog.isFetching}
                      onClick={() => update({ catalogPage: String(page - 1) })}
                    >
                      {t('web.previous')}
                    </button>
                    <span>{t('versions.page', { page, pages })}</span>
                    <button
                      type="button"
                      className="secondary"
                      disabled={bulkBusy || page >= pages || catalog.isFetching}
                      onClick={() => update({ catalogPage: String(page + 1) })}
                    >
                      {t('web.next')}
                    </button>
                  </nav>
                </footer>
              </>
            )}
          </VersionCatalogFrame>
          {selectedId && (
            <Dialog
              open
              title={detail.data?.combination.release ?? t('web.details')}
              closeIcon
              className="minecraft-version-drawer"
              onClose={() => update({ combination: '' })}
            >
              {detail.isPending ? (
                <Loading />
              ) : detail.error ? (
                <ErrorNotice error={detail.error} retry={() => void detail.refetch()} />
              ) : (
                detail.data && (
                  <CombinationDetail
                    key={detail.data.id}
                    choice={detail.data}
                    mappingLabel={mappingLabel(
                      mappings.data?.find((m) => m.id === detail.data.mappingId),
                      false,
                    )}
                    refresh={refresh}
                  />
                )
              )}
            </Dialog>
          )}
          {(advanced === 'register' || advanced === 'protocol') && (
            <Dialog
              open
              title={t(
                advanced === 'register'
                  ? 'gameAdmin.advancedRegistration'
                  : 'integrationConfig.protocolSource',
              )}
              closeIcon
              className="minecraft-advanced-dialog"
              onClose={() => setAdvanced(null)}
            >
              {advanced === 'register' ? (
                <RegisterCombination refresh={() => void refresh()} />
              ) : (
                <MinecraftProtocolSettings embedded />
              )}
            </Dialog>
          )}
        </>
      )}
    </div>
  );
}
function VariantRows({
  release,
  mappingId,
  runtime,
  availability,
  releaseType,
  onVisible,
  selected,
  busy,
  choose,
  open,
}: {
  release: string;
  mappingId: string;
  runtime: string;
  availability: string;
  releaseType: string;
  onVisible: (ids: string[]) => void;
  selected: Set<string>;
  busy: boolean;
  choose: (ids: string[], checked: boolean) => void;
  open: (id: string) => void;
}) {
  const t = useT();
  const [page, setPage] = useState(1);
  const variants = useQuery({
    queryKey: [
      'owner-minecraft-compatibility',
      'variants',
      mappingId,
      release,
      availability,
      releaseType,
      page,
    ],
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      api<{ items: Combination[]; total: number }>(
        `/v1/owner/minecraft/compatibility?${new URLSearchParams(Object.entries({ view: 'summary', mappingId, runtime, release, availability, releaseType, page: String(page), pageSize: '25' }).filter(([, value]) => value !== ''))}`,
        { signal },
      ),
  });
  const publishVisible = useRef(onVisible);
  publishVisible.current = onVisible;
  useEffect(() => {
    publishVisible.current(variants.data?.items.map((choice) => choice.id) ?? []);
  }, [variants.data]);
  if (variants.isPending)
    return (
      <tr>
        <td colSpan={6}>
          <Loading />
        </td>
      </tr>
    );
  if (variants.error)
    return (
      <tr>
        <td colSpan={6}>
          <ErrorNotice error={variants.error} retry={() => void variants.refetch()} />
        </td>
      </tr>
    );
  return (
    <>
      {variants.data.items.map((choice) => (
        <tr className="minecraft-variant-row" key={choice.id}>
          <td>
            <input
              type="checkbox"
              aria-label={t('versions.selectVariant', {
                version: release,
                variant:
                  choice.combination.buildId ??
                  choice.combination.loaderVersion ??
                  choice.id.slice(0, 8),
              })}
              checked={selected.has(choice.id)}
              disabled={busy}
              onChange={(e) => choose([choice.id], e.target.checked)}
            />
          </td>
          <td>
            <button
              type="button"
              className="minecraft-version-name"
              onClick={() => open(choice.id)}
            >
              <span>
                {[choice.combination.buildId, choice.combination.loaderVersion]
                  .filter(Boolean)
                  .join(' · ') || choice.id.slice(0, 8)}
              </span>
            </button>
          </td>
          <td>
            <ReleaseDate value={choice.releaseTime} />
          </td>
          <td>{choice.combination.javaMajor}</td>
          <td>
            <FeatureIndicators choice={choice} />
          </td>
          <td>
            <CreationState choice={choice} />
          </td>
        </tr>
      ))}
      {variants.data.total > 25 && (
        <tr>
          <td colSpan={6}>
            <div className="minecraft-variant-pagination">
              <button
                type="button"
                className="secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                {t('web.previous')}
              </button>
              <span>
                {t('versions.page', { page, pages: Math.ceil(variants.data.total / 25) })}
              </span>
              <button
                type="button"
                className="secondary"
                disabled={page * 25 >= variants.data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('web.next')}
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
