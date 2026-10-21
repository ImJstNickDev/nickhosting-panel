import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useSearchParams } from 'react-router';
import { api, queryClient } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { ScanProgress } from '../components/scan-progress.js';
import { Dialog, ErrorNotice } from '../components/ui.js';
import { type CatalogBatch, type CatalogMeasurement, syncCatalogPages } from './catalog-sync.js';
import { mappingsQuery, useMappingLabel } from './minecraft-admin-model.js';
import { MinecraftAdminIcon } from './minecraft-admin-presentation.js';

/** The integration workspace keeps this small coordinator alive between tabs.
 * Only its controls are portalled into the active catalog; the catalog itself unmounts. */
export function MinecraftCatalogScan() {
  const t = useT(),
    format = useFormat(),
    location = useLocation();
  const [params] = useSearchParams();
  const mappings = useQuery(mappingsQuery),
    mappingLabel = useMappingLabel();
  const [targets, setTargets] = useState<{ trigger: HTMLElement; progress: HTMLElement } | null>(
    null,
  );
  const [runLabel, setRunLabel] = useState('');
  const [open, setOpen] = useState(false),
    [all, setAll] = useState(false),
    [log, setLog] = useState(false);
  const [batch, setBatch] = useState<CatalogBatch>(),
    [measurement, setMeasurement] = useState<CatalogMeasurement>();
  const [busy, setBusy] = useState(false),
    [cancelled, setCancelled] = useState(false),
    [failure, setFailure] = useState<unknown>();
  const controller = useRef<AbortController | null>(null),
    mounted = useRef(true);
  const runtime = params.get('runtime') ?? 'vanilla';
  const eligible =
    mappings.data?.filter((m) => m.game_id === 'minecraft' && m.runtime_id === runtime) ?? [];
  const mapping = eligible.find((m) => m.id === params.get('mapping')) ?? eligible[0];
  const lastScope = useRef('');
  const scope = `${runtime}:${mapping?.id ?? ''}:${all}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const runScope = useRef('');
  const independentDiscovery = runtime === 'fabric' || runtime === 'paper';
  useLayoutEffect(() => {
    if (independentDiscovery) {
      setTargets(null);
      return;
    }
    // Component and coordinator are independent lazy contributions: on a cold
    // navigation the slots may commit after this component's first effect.
    let observer: MutationObserver | undefined;
    const connect = () => {
      const trigger = document.getElementById('minecraft-catalog-scan-trigger');
      const progress = document.getElementById('minecraft-catalog-scan-progress');
      if (trigger && progress) {
        setTargets({ trigger, progress });
        observer?.disconnect();
        return true;
      }
      return false;
    };
    if (!connect()) {
      setTargets(null);
      if (location.pathname.endsWith('/versions')) {
        observer = new MutationObserver(connect);
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }
    return () => observer?.disconnect();
  }, [location.pathname, independentDiscovery]);
  useEffect(() => {
    if (lastScope.current !== scope) {
      controller.current?.abort();
      lastScope.current = scope;
      setBatch(undefined);
      setMeasurement(undefined);
      setCancelled(false);
      setFailure(undefined);
      setRunLabel('');
    }
  }, [scope]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['owner-minecraft-compatibility'] });
    void queryClient.invalidateQueries({ queryKey: ['creation'] });
  };
  async function sync() {
    if (!mapping || mapping.enabled === false || runtime !== 'vanilla' || controller.current)
      return;
    const active = new AbortController();
    controller.current = active;
    const activeScope = scope;
    runScope.current = scope;
    setRunLabel(mappingLabel(mapping));
    setBusy(true);
    setCancelled(false);
    setFailure(undefined);
    setMeasurement(undefined);
    setOpen(false);
    if (batch?.nextCursor === null) setBatch(undefined);
    try {
      await syncCatalogPages({
        previous: batch,
        signal: active.signal,
        request: (cursor, signal) =>
          api<CatalogBatch>('/v1/owner/minecraft/catalog/sync', {
            signal,
            body: { mappingId: mapping.id, all, enableSupported: false, cursor, limit: 20 },
          }),
        progress: (result, measured) => {
          if (!mounted.current || currentScope.current !== activeScope) return;
          setBatch(result);
          setMeasurement(measured);
        },
      });
    } catch (error) {
      if (mounted.current && currentScope.current === activeScope) {
        if (!active.signal.aborted) setFailure(error);
        else setCancelled(true);
      }
    } finally {
      controller.current = null;
      if (mounted.current) {
        setBusy(false);
        refresh();
      }
    }
  }
  if (!targets) return null;
  const status = cancelled
    ? t('gameAdmin.syncCancelled')
    : batch
      ? t(
          busy
            ? 'gameAdmin.syncProgress'
            : batch.nextCursor === null
              ? 'gameAdmin.syncComplete'
              : 'gameAdmin.syncPartial',
          { count: batch.nextCursor ?? batch.total, total: batch.total },
        )
      : t('gameAdmin.scanPreparing');
  return (
    <>
      {createPortal(
        <>
          {runtime === 'vanilla' && (
            <button
              type="button"
              className="secondary minecraft-detect"
              disabled={!mapping || mapping.enabled === false || busy}
              aria-describedby={
                mapping?.enabled === false ? 'minecraft-mapping-disabled' : undefined
              }
              onClick={() => setOpen(true)}
            >
              <MinecraftAdminIcon kind="scan" />
              {t('versions.detect')}
            </button>
          )}
          {open && (
            <Dialog
              open
              closeIcon
              title={t('versions.detect')}
              className="minecraft-scan-dialog"
              onClose={() => setOpen(false)}
            >
              <div className="minecraft-scan-config">
                <strong>{mappingLabel(mapping)}</strong>
                <fieldset className="minecraft-scan-scope" aria-label={t('versions.scanScope')}>
                  <button
                    type="button"
                    className="secondary"
                    aria-pressed={!all}
                    onClick={() => setAll(false)}
                  >
                    {t('versions.releasesOnly')}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-pressed={all}
                    onClick={() => setAll(true)}
                  >
                    {t('versions.allVersions')}
                  </button>
                </fieldset>
                <p className="muted">{t('versions.scanDescription')}</p>
                <button
                  type="button"
                  disabled={!mapping || mapping.enabled === false || busy}
                  onClick={() => void sync()}
                >
                  {t(
                    batch?.nextCursor || cancelled || failure !== undefined
                      ? 'gameAdmin.syncResume'
                      : 'versions.detect',
                  )}
                </button>
              </div>
            </Dialog>
          )}
        </>,
        targets.trigger,
      )}
      {createPortal(
        <>
          {failure !== undefined && <ErrorNotice error={failure} />}
          {((busy && runScope.current === scope) ||
            batch ||
            cancelled ||
            failure !== undefined) && (
            <div className="minecraft-scan-summary">
              <span className="minecraft-scan-run">{runLabel}</span>
              <div className="minecraft-scan-line">
                <ScanProgress
                  label={t('gameAdmin.scanProgress')}
                  completed={batch ? (batch.nextCursor ?? batch.total) : undefined}
                  total={batch?.total}
                  status={status}
                  estimate={
                    busy
                      ? measurement?.remainingSeconds != null
                        ? t('gameAdmin.scanEstimate', {
                            minutes: format.number(
                              Math.max(1, Math.ceil(measurement.remainingSeconds / 60)),
                              0,
                            ),
                          })
                        : t('gameAdmin.scanEstimating')
                      : undefined
                  }
                  logLabel={t('gameAdmin.scanLog')}
                />
                <div className="minecraft-scan-actions">
                  <button
                    type="button"
                    className="secondary"
                    aria-expanded={log}
                    onClick={() => setLog((value) => !value)}
                  >
                    {t(log ? 'versions.hideLog' : 'versions.showLog')}
                  </button>
                  {busy ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => controller.current?.abort()}
                    >
                      {t('versions.stopScan')}
                    </button>
                  ) : (
                    (cancelled || failure !== undefined) && (
                      <button type="button" className="secondary" onClick={() => setOpen(true)}>
                        {t('gameAdmin.syncResume')}
                      </button>
                    )
                  )}
                </div>
              </div>
              {log && (
                <div
                  role="log"
                  aria-label={t('gameAdmin.scanLog')}
                  aria-live="off"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the bounded scan log.
                  tabIndex={0}
                  className="catalog-log minecraft-scan-log"
                >
                  {batch?.items.map((item) => (
                    <div key={item.version}>
                      <span>{item.version}</span>
                      <span>
                        {t(
                          item.status === 'registered' ? 'gameAdmin.registered' : 'web.unavailable',
                        )}
                        {item.reason && <> · {t(`gameAdmin.catalogReason.${item.reason}`)}</>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>,
        targets.progress,
      )}
    </>
  );
}
