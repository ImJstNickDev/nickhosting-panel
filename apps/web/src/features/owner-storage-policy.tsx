import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
import { Dialog, ErrorNotice, Input, Loading, Notice, Select } from '../components/ui.js';
import {
  type StorageAllocation,
  type StorageMode,
  type StoragePolicyStatus,
  type StoragePolicyUser,
  type StorageTransition,
  storagePolicyApi,
} from './owner-storage-policy.api.js';
import './owner-storage-policy.css';

const queryKey = ['owner-storage-policy'];
const maximumMiB = 1073741824;
const bytesPerMiB = 1024 ** 2;
const validMiB = (value: number, zero = false) =>
  Number.isSafeInteger(value) && value >= (zero ? 0 : 1) && value <= maximumMiB;
const finiteProposal = (server: StoragePolicyUser['servers'][number], previous = 0) =>
  server.proposedDiskMiB && server.proposedDiskMiB > 0
    ? server.proposedDiskMiB
    : Math.max(previous, server.minimumDiskMiB ?? 0);

function Info({ label, content }: { label: string; content: string }) {
  return (
    <Tooltip content={content}>
      <button type="button" className="storage-info" aria-label={label}>
        <span aria-hidden="true">i</span>
      </button>
    </Tooltip>
  );
}

export function OwnerStoragePolicy({
  editable,
  lockedKeys,
  onSaved,
}: {
  editable: boolean;
  lockedKeys: string[];
  onSaved: () => Promise<void>;
}) {
  const state = useQuery({
    queryKey,
    queryFn: ({ signal }) => storagePolicyApi.status(signal),
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      query.state.data?.transition?.status === 'applying' ? 2000 : false,
  });
  if (state.isPending) return <Loading />;
  if (!state.data) return <ErrorNotice error={state.error} retry={() => void state.refetch()} />;
  return (
    <>
      {state.error && <ErrorNotice error={state.error} retry={() => void state.refetch()} />}
      <StoragePolicyEditor
        state={state.data}
        editable={editable}
        lockedKeys={lockedKeys}
        onSaved={onSaved}
      />
    </>
  );
}

function StoragePolicyEditor({
  state,
  editable,
  lockedKeys,
  onSaved,
}: {
  state: StoragePolicyStatus;
  editable: boolean;
  lockedKeys: string[];
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const format = useFormat();
  const client = useQueryClient();
  const initial =
    state.transition && ['draft', 'applying', 'blocked'].includes(state.transition.status)
      ? state.transition
      : state;
  const [plan, setPlan] = useState<StorageTransition | null>(state.transition);
  const [mode, setMode] = useState<StorageMode>(initial.policy);
  const [budget, setBudget] = useState(String(initial.defaultUserStorageMiB / 1024));
  const [quotas, setQuotas] = useState<Record<string, string>>({});
  const [disks, setDisks] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);
  const [verified, setVerified] = useState(-1);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<unknown>();
  const [actionError, setActionError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const revision = useRef(0);
  const due = useRef(0);
  const needsCheck = useRef(true);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const finite = useRef<Record<string, number>>({});
  const checker = useRef<() => Promise<void>>(async () => {});
  const checkSoon = useRef<(immediate?: boolean) => void>(() => {});
  const confirmTrigger = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const dialogError = useRef<HTMLDivElement>(null);
  const completed = useRef<string | undefined>(undefined);
  const locked = [...lockedKeys, ...state.lockedKeys].some((key) =>
    ['storagePolicy', 'defaultUserStorageMiB'].includes(key),
  );
  const canEdit = editable && !locked;
  const underway = plan?.status === 'applying';
  const blocked = plan?.status === 'blocked';
  const budgetMiB = budget.trim() ? Number(budget) * 1024 : Number.NaN;
  const budgetValid = validMiB(budgetMiB);
  const limited = mode === 'PER_USER_BUDGET';
  const enabled = canEdit && !busy && !underway;
  const review = plan && plan.status !== 'superseded' ? plan : null;
  const unit = (value: number) =>
    Number.isFinite(value) ? format.bytes(value * bytesPerMiB) : '—';
  const allocations: StorageAllocation[] = (review?.users ?? []).map((user) => {
    const followsDefault =
      user.quotaSource === 'default' ||
      (user.quotaSource === undefined && user.quotaMiB === review?.defaultUserStorageMiB);
    let quotaMiB =
      quotas[user.userId] === undefined
        ? followsDefault
          ? budgetMiB
          : user.quotaMiB
        : quotas[user.userId]?.trim()
          ? Number(quotas[user.userId]) * 1024
          : Number.NaN;
    // Hidden quota drafts cannot prevent switching to shared storage. Keep the
    // draft for a later return to limited mode; submit the saved quota meanwhile.
    if (!limited && !validMiB(quotaMiB, true)) quotaMiB = user.quotaMiB;
    return {
      userId: user.userId,
      quotaMiB,
      servers: user.servers.map((server) => ({
        serverId: server.serverId,
        diskMiB:
          !limited || quotaMiB === 0
            ? 0
            : disks[server.serverId] === undefined
              ? finiteProposal(server, finite.current[server.serverId])
              : disks[server.serverId]?.trim()
                ? Number(disks[server.serverId]) * 1024
                : Number.NaN,
      })),
    };
  });
  const unsafe =
    !budgetValid ||
    Boolean(
      review?.users.some((user, index) => {
        const allocation = allocations[index];
        if (
          !allocation ||
          !validMiB(allocation.quotaMiB, true) ||
          user.servers.some((server) => server.usageBytes === null)
        )
          return true;
        if (!limited || allocation.quotaMiB === 0) return false;
        const required = allocation.servers.reduce(
          (sum, server, serverIndex) =>
            sum + server.diskMiB * (1 + (user.servers[serverIndex]?.backupSlots ?? 0)),
          0,
        );
        return (
          required > allocation.quotaMiB ||
          user.servers.some((server, serverIndex) => {
            const disk = allocation.servers[serverIndex]?.diskMiB ?? 0;
            return (
              server.minimumDiskMiB === null || !validMiB(disk) || disk < server.minimumDiskMiB
            );
          })
        );
      }),
    );
  const matches = review?.policy === mode && review.defaultUserStorageMiB === budgetMiB;
  const ready =
    enabled &&
    Boolean(review) &&
    !unsafe &&
    matches &&
    verified === revision.current &&
    !checking &&
    !checkError &&
    review?.status !== 'completed';
  const servers = review?.users.flatMap((user) => user.servers) ?? [];
  const applied = servers.filter((server) => server.status === 'applied').length;

  const store = (next: StorageTransition) => {
    for (const user of next.users)
      for (const server of user.servers) {
        if (server.proposedDiskMiB && server.proposedDiskMiB > 0)
          finite.current[server.serverId] = server.proposedDiskMiB;
      }
    setPlan(next);
    client.setQueryData<StoragePolicyStatus>(queryKey, (previous) =>
      previous
        ? {
            ...previous,
            ...(next.status === 'completed'
              ? { policy: next.policy, defaultUserStorageMiB: next.defaultUserStorageMiB }
              : {}),
            transition: next,
          }
        : previous,
    );
  };
  checkSoon.current = (immediate = false) => {
    revision.current += 1;
    due.current = immediate ? 0 : Date.now() + 350;
    needsCheck.current = true;
    setVersion((value) => value + 1);
  };
  checker.current = async () => {
    if (
      !mounted.current ||
      !needsCheck.current ||
      inFlight.current ||
      !canEdit ||
      busy ||
      underway ||
      !budgetValid
    )
      return;
    const requestedRevision = revision.current;
    inFlight.current = true;
    setChecking(true);
    setCheckError(undefined);
    try {
      const next =
        blocked && plan
          ? await storagePolicyApi.refresh(plan.id)
          : await storagePolicyApi.preview(mode, budgetMiB);
      if (!mounted.current || requestedRevision !== revision.current) return;
      store(next);
      setVerified(requestedRevision);
    } catch (error) {
      if (mounted.current && requestedRevision === revision.current) {
        setCheckError(error);
        setVerified(-1);
        // Another Owner tab may have started a different durable transition.
        // Discover its authoritative status before offering another preview.
        void client.invalidateQueries({ queryKey });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setChecking(false);
        if (requestedRevision === revision.current) needsCheck.current = false;
        else setVersion((value) => value + 1);
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A revision restarts the debounce without capturing stale input values.
  useEffect(() => {
    if (!needsCheck.current || !canEdit || underway || busy) return;
    const timer = setTimeout(() => void checker.current(), Math.max(0, due.current - Date.now()));
    return () => clearTimeout(timer);
  }, [version, canEdit, underway, busy]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'hidden') checkSoon.current(true);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  useEffect(() => {
    const next = state.transition;
    if (!next || next === plan || !['applying', 'blocked', 'completed'].includes(next.status))
      return;
    if (
      (next.id !== plan?.id || (next.status === 'blocked' && plan?.status !== 'blocked')) &&
      ['applying', 'blocked'].includes(next.status)
    ) {
      setMode(next.policy);
      setBudget(String(next.defaultUserStorageMiB / 1024));
      revision.current += 1;
      needsCheck.current = next.status === 'blocked';
      due.current = 0;
      setVersion((value) => value + 1);
    }
    setPlan(next);
  }, [state.transition, plan]);
  useEffect(() => {
    if (plan?.status === 'completed' && completed.current !== plan.id) {
      completed.current = plan.id;
      void onSaved();
    }
  }, [plan?.id, plan?.status, onSaved]);
  useEffect(() => {
    if (actionError && confirm) dialogError.current?.focus();
  }, [actionError, confirm]);

  function edited() {
    setActionError(undefined);
    checkSoon.current();
  }
  function closeConfirm() {
    if (busy) return;
    setConfirm(false);
    requestAnimationFrame(() => {
      if (confirmTrigger.current?.disabled) reviewHeading.current?.focus();
      else confirmTrigger.current?.focus();
    });
  }
  async function apply() {
    if (!ready || !review || inFlight.current || verified !== revision.current) return;
    setBusy(true);
    setActionError(undefined);
    try {
      const next = await storagePolicyApi.apply(review.id, allocations);
      needsCheck.current = false;
      store(next);
      if (next.status === 'blocked') checkSoon.current(true);
      setConfirm(false);
      setVerified(-1);
      setQuotas({});
      setDisks({});
      requestAnimationFrame(() => reviewHeading.current?.focus());
    } catch (error) {
      setActionError(error);
      checkSoon.current(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="storage-policy" aria-busy={busy || underway}>
      <div className="storage-current">
        <span>{t('storagePolicy.current')}</span>
        <strong>{t(`storagePolicy.mode.${state.policy}`)}</strong>
      </div>
      {!editable ? (
        <Notice>{t('owner.readOnlySettings')}</Notice>
      ) : locked ? (
        <Notice>{t('owner.environmentLocked')}</Notice>
      ) : null}
      {Boolean(checkError) && (
        <ErrorNotice error={checkError} retry={() => checkSoon.current(true)} />
      )}
      {Boolean(actionError) && !confirm && <ErrorNotice error={actionError} />}
      <div className="storage-target">
        <div className="storage-field-help">
          <Select
            label={t('storagePolicy.mode')}
            value={mode}
            disabled={!enabled || blocked}
            onChange={(event) => {
              setMode(event.target.value as StorageMode);
              if (event.target.value === 'GLOBAL_POOL' && !budgetValid)
                setBudget(String(state.defaultUserStorageMiB / 1024));
              edited();
            }}
          >
            <option value="GLOBAL_POOL">{t('storagePolicy.mode.GLOBAL_POOL')}</option>
            <option value="PER_USER_BUDGET">{t('storagePolicy.mode.PER_USER_BUDGET')}</option>
          </Select>
          <Info
            label={t('storagePolicy.policyHelp')}
            content={t(limited ? 'storagePolicy.limitedHelp' : 'storagePolicy.globalHelp')}
          />
        </div>
        {limited && (
          <Input
            label={t('storagePolicy.defaultQuota')}
            type="number"
            min={0}
            max={maximumMiB / 1024}
            step="any"
            required
            value={budget}
            disabled={!enabled || blocked}
            aria-invalid={!budgetValid || undefined}
            onChange={(event) => {
              event.currentTarget.setCustomValidity(
                validMiB(event.currentTarget.valueAsNumber * 1024)
                  ? ''
                  : t('storagePolicy.invalidSize'),
              );
              setBudget(event.target.value);
              edited();
            }}
          />
        )}
      </div>
      {!budgetValid && (
        <p className="storage-blocker" role="status">
          {t('storagePolicy.invalidSize')}
        </p>
      )}
      {review && (
        <div className="storage-review">
          <div className="storage-review-heading">
            <h3 ref={reviewHeading} tabIndex={-1}>
              {t('storagePolicy.allocations')}
            </h3>
            <Info
              label={t('storagePolicy.allocationHelp')}
              content={
                limited
                  ? `${t('storagePolicy.reviewLimited')}\n\n${t('storagePolicy.backupHelp')}`
                  : t('storagePolicy.reviewUnlimited')
              }
            />
            <span className="storage-check-state muted" role="status">
              {checking || (needsCheck.current && enabled && budgetValid)
                ? t('storagePolicy.checking')
                : ''}
            </span>
          </div>
          {(underway || blocked) && (
            <Notice>
              {t(blocked ? 'storagePolicy.blockedCompact' : 'storagePolicy.progress', {
                applied,
                total: servers.length,
              })}
            </Notice>
          )}
          {review.errorCode && (
            <ErrorNotice
              error={new ApiError(review.errorCode, `errors.${review.errorCode}`)}
              retry={enabled ? () => checkSoon.current(true) : undefined}
            />
          )}
          {!review.errorCode &&
            !checkError &&
            servers.some((server) => server.usageBytes === null) && (
              <ErrorNotice
                error={new ApiError('integration_unavailable', 'storagePolicy.missingMeasurement')}
                retry={enabled ? () => checkSoon.current(true) : undefined}
              />
            )}
          {review.status === 'completed' && <Notice>{t('storagePolicy.completed')}</Notice>}
          {review.users.length === 0 && <p className="muted">{t('storagePolicy.noServers')}</p>}
          {review.users.map((user, index) => {
            const allocation = allocations[index];
            if (!allocation) return null;
            return (
              <StorageUser
                key={user.userId}
                user={user}
                allocation={allocation}
                limited={limited}
                editable={enabled}
                cleanup={canEdit && !underway}
                quota={quotas[user.userId] ?? String(allocation.quotaMiB / 1024)}
                disks={disks}
                setQuota={(value) => {
                  setQuotas((previous) => ({ ...previous, [user.userId]: value }));
                  edited();
                }}
                setDisk={(id, value) => {
                  setDisks((previous) => ({ ...previous, [id]: value }));
                  edited();
                }}
              />
            );
          })}
        </div>
      )}
      {!review && checking && (
        <p className="muted" role="status">
          {t('storagePolicy.checking')}
        </p>
      )}
      {canEdit && (
        <div className="storage-review-actions">
          <button
            ref={confirmTrigger}
            type="button"
            disabled={!ready}
            onClick={() => setConfirm(true)}
          >
            {t(blocked ? 'storagePolicy.resume' : 'storagePolicy.confirmApply')}
          </button>
        </div>
      )}
      <Dialog
        open={confirm}
        title={t('storagePolicy.confirmTitle')}
        onClose={closeConfirm}
        closeDisabled={busy}
        initialFocusSelector="[data-storage-cancel]"
      >
        {review && (
          <>
            <p>
              {t(limited ? 'storagePolicy.confirmLimited' : 'storagePolicy.confirmUnlimited', {
                count: servers.length,
                quota: unit(budgetMiB),
              })}
            </p>
            <p className="muted">{t('storagePolicy.confirmCheck')}</p>
            {Boolean(actionError) && (
              <div ref={dialogError} tabIndex={-1}>
                <ErrorNotice error={actionError} />
              </div>
            )}
            {Boolean(checkError) && (
              <ErrorNotice error={checkError} retry={() => checkSoon.current(true)} />
            )}
            <div className="actions">
              <button
                data-storage-cancel
                type="button"
                className="secondary"
                disabled={busy}
                onClick={closeConfirm}
              >
                {t('web.cancel')}
              </button>
              <button type="button" disabled={!ready} onClick={() => void apply()}>
                {t(busy ? 'web.pending' : 'storagePolicy.confirmApply')}
              </button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}

function StorageUser({
  user,
  allocation,
  limited,
  editable,
  cleanup,
  quota,
  disks,
  setQuota,
  setDisk,
}: {
  user: StoragePolicyUser;
  allocation: StorageAllocation;
  limited: boolean;
  editable: boolean;
  cleanup: boolean;
  quota: string;
  disks: Record<string, string>;
  setQuota: (value: string) => void;
  setDisk: (id: string, value: string) => void;
}) {
  const t = useT();
  const format = useFormat();
  const unit = (value: number) =>
    Number.isFinite(value) ? format.bytes(value * bytesPerMiB) : '—';
  const unlimited = !limited || allocation.quotaMiB === 0;
  const required = allocation.servers.reduce(
    (sum, server, index) => sum + server.diskMiB * (1 + (user.servers[index]?.backupSlots ?? 0)),
    0,
  );
  const unavailable = user.servers.some((server) => server.usageBytes === null);
  const occupied = user.servers.reduce((sum, server) => sum + (server.usageBytes ?? 0), 0);
  const shortfall = unlimited ? 0 : Math.max(0, required - allocation.quotaMiB);
  return (
    <section className="storage-user" aria-label={user.name}>
      <div className="storage-user-heading">
        <div className="storage-user-name">
          <h4>{user.name}</h4>
          <small className="muted">
            {t('storagePolicy.filesUsed', {
              value: unavailable ? t('storagePolicy.unavailable') : format.bytes(occupied),
            })}
          </small>
        </div>
        <div className="storage-user-total">
          {unlimited ? (
            <strong>{t('storagePolicy.unlimited')}</strong>
          ) : (
            <>
              <span>{t('storagePolicy.reservedCompact', { value: unit(required) })}</span>
              <small className={shortfall > 0 ? 'storage-blocker' : 'muted'}>
                {t(shortfall > 0 ? 'storagePolicy.shortfall' : 'storagePolicy.remaining', {
                  value: unit(
                    shortfall > 0 ? shortfall : Math.max(0, allocation.quotaMiB - required),
                  ),
                })}
              </small>
            </>
          )}
        </div>
        {limited && (
          <div className="storage-field-help">
            <Input
              label={t('storagePolicy.userQuota', { name: user.name })}
              type="number"
              min={0}
              max={maximumMiB / 1024}
              step="any"
              required
              value={quota}
              disabled={!editable}
              aria-invalid={!validMiB(allocation.quotaMiB, true) || undefined}
              onChange={(event) => {
                event.currentTarget.setCustomValidity(
                  validMiB(event.currentTarget.valueAsNumber * 1024, true)
                    ? ''
                    : t('storagePolicy.invalidUserSize'),
                );
                setQuota(event.target.value);
              }}
            />
            <Info
              label={t('storagePolicy.userQuotaHelp', { name: user.name })}
              content={t('storagePolicy.zeroHelp')}
            />
          </div>
        )}
      </div>
      {shortfall > 0 && (
        <p className="storage-row-warning storage-blocker">{t('storagePolicy.resolveCompact')}</p>
      )}
      {limited && !validMiB(allocation.quotaMiB, true) && (
        <p className="storage-row-warning storage-blocker">{t('storagePolicy.invalidUserSize')}</p>
      )}
      <div className="storage-server-list">
        {user.servers.map((server, index) => {
          const disk = allocation.servers[index]?.diskMiB ?? 0;
          const tooSmall =
            !unlimited && server.minimumDiskMiB !== null && disk < server.minimumDiskMiB;
          return (
            <div key={server.serverId} className="storage-server">
              <div className="storage-server-name">
                <strong>{server.name}</strong>
                {cleanup && (
                  <div className="actions storage-cleanup-actions">
                    <a
                      href={`/servers/${encodeURIComponent(server.serverId)}/files`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={t('storagePolicy.openFilesLabel', { name: server.name })}
                    >
                      {t('storagePolicy.openFiles')} <span aria-hidden="true">↗</span>
                    </a>
                    <a
                      href={`/servers/${encodeURIComponent(server.serverId)}/backups`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={t('storagePolicy.openBackupsLabel', { name: server.name })}
                    >
                      {t('storagePolicy.openBackups')} <span aria-hidden="true">↗</span>
                    </a>
                  </div>
                )}
              </div>
              <div className="storage-server-measurement">
                <span>
                  {t('storagePolicy.used', {
                    value:
                      server.usageBytes === null
                        ? t('storagePolicy.unavailable')
                        : format.bytes(server.usageBytes),
                  })}
                </span>
                <small className="muted">
                  {t('storagePolicy.currentLimit', {
                    value:
                      server.currentDiskMiB === 0
                        ? t('storagePolicy.unlimited')
                        : unit(server.currentDiskMiB),
                  })}
                </small>
                {server.observedAt && (
                  <Tooltip
                    content={`${t('storagePolicy.measured')} ${format.date(server.observedAt)}`}
                  >
                    <time dateTime={server.observedAt} className="storage-measured muted">
                      {format.date(server.observedAt)}
                    </time>
                  </Tooltip>
                )}
              </div>
              <div className="storage-server-allocation">
                {unlimited ? (
                  <span className="muted">{t('storagePolicy.unlimited')}</span>
                ) : (
                  <>
                    <Input
                      label={t('storagePolicy.serverQuota', { name: server.name })}
                      type="number"
                      min={0}
                      max={maximumMiB / 1024}
                      step="any"
                      required
                      value={disks[server.serverId] ?? (disk ? disk / 1024 : '')}
                      disabled={!editable || server.minimumDiskMiB === null}
                      aria-invalid={tooSmall || !validMiB(disk) || undefined}
                      onChange={(event) => setDisk(server.serverId, event.target.value)}
                    />
                    <small className={tooSmall ? 'storage-blocker' : 'muted'}>
                      {server.minimumDiskMiB === null
                        ? t('storagePolicy.missingMeasurement')
                        : t('storagePolicy.minimum', { value: unit(server.minimumDiskMiB) })}
                    </small>
                    {server.backupSlots > 0 && (
                      <small className="muted">
                        {t('storagePolicy.backupReservation', {
                          count: server.backupSlots,
                          value: unit(disk * server.backupSlots),
                        })}
                      </small>
                    )}
                  </>
                )}
              </div>
              {server.errorCode && (
                <p className="storage-blocker">{t(`errors.${server.errorCode}`)}</p>
              )}
              {server.usageBytes === null && (
                <p className="storage-blocker">{t('storagePolicy.missingMeasurement')}</p>
              )}
              {!unlimited && server.minimumDiskMiB !== null && !validMiB(disk) && (
                <p className="storage-blocker">{t('storagePolicy.invalidSize')}</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
