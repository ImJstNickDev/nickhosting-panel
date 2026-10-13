import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { Dialog, ErrorNotice, Input, Loading, Notice, Select, Time } from '../components/ui.js';
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
const bytesPerMiB = 1024 * 1024;
// GiB inputs use a zero step base: Firefox aligns native arrows to `min` even
// with step="any". Positive/observed minimums are validated separately below.
const validMiB = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= maximumMiB;

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
  const active = state.transition;
  const initial =
    active && ['draft', 'applying', 'blocked'].includes(active.status) ? active : state;
  const [mode, setMode] = useState<StorageMode>(initial.policy);
  const [budget, setBudget] = useState(String(initial.defaultUserStorageMiB / 1024));
  const [quotas, setQuotas] = useState<Record<string, string>>({});
  const [disks, setDisks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [confirm, setConfirm] = useState(false);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const confirmTrigger = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const dialogErrorRef = useRef<HTMLDivElement>(null);
  const completed = useRef<string | undefined>(undefined);
  const lock = [...lockedKeys, ...state.lockedKeys].some((key) =>
    ['storagePolicy', 'defaultUserStorageMiB'].includes(key),
  );
  const canEdit = editable && !lock;
  const underway = active?.status === 'applying';
  const hasPartial = active?.status === 'blocked';
  const review = active && ['draft', 'applying', 'blocked'].includes(active.status) ? active : null;
  const draftMatches =
    review?.policy === mode && review.defaultUserStorageMiB === Number(budget) * 1024;
  const isLimited = review?.policy === 'PER_USER_BUDGET';
  const hasEdits = Object.keys(quotas).length > 0 || Object.keys(disks).length > 0;
  const editableReview = canEdit && !busy && !underway && Boolean(draftMatches);
  const unit = (value: number) => format.bytes(value * bytesPerMiB);
  const allocations: StorageAllocation[] = (review?.users ?? []).map((user) => ({
    userId: user.userId,
    quotaMiB:
      quotas[user.userId] === undefined ? user.quotaMiB : Number(quotas[user.userId]) * 1024,
    servers: user.servers.map((server) => ({
      serverId: server.serverId,
      diskMiB: !isLimited
        ? 0
        : disks[server.serverId] === undefined
          ? (server.proposedDiskMiB ?? 0)
          : Number(disks[server.serverId]) * 1024,
    })),
  }));
  const unsafe = Boolean(
    review?.users.some((user, index) => {
      const allocation = allocations[index];
      if (!allocation) return true;
      if (!isLimited) return user.servers.some((server) => server.usageBytes === null);
      const required = allocation.servers.reduce(
        (sum, server, serverIndex) =>
          sum + server.diskMiB * (1 + (user.servers[serverIndex]?.backupSlots ?? 0)),
        0,
      );
      return (
        !validMiB(allocation.quotaMiB) ||
        required > allocation.quotaMiB ||
        user.servers.some((server, serverIndex) => {
          const limit = allocation.servers[serverIndex]?.diskMiB ?? 0;
          return (
            server.minimumDiskMiB === null || !validMiB(limit) || limit < server.minimumDiskMiB
          );
        })
      );
    }),
  );
  const servers = review?.users.flatMap((user) => user.servers) ?? [];
  const applied = servers.filter((server) => server.status === 'applied').length;

  useEffect(() => {
    if (error) (confirm ? dialogErrorRef.current : errorRef.current)?.focus();
  }, [error, confirm]);
  useEffect(() => {
    if (active?.status === 'completed' && completed.current !== active.id) {
      completed.current = active.id;
      void onSaved();
    }
  }, [active?.id, active?.status, onSaved]);

  const store = (transition: StorageTransition) =>
    client.setQueryData<StoragePolicyStatus>(queryKey, (previous) =>
      previous
        ? {
            ...previous,
            ...(transition.status === 'completed'
              ? {
                  policy: transition.policy,
                  defaultUserStorageMiB: transition.defaultUserStorageMiB,
                }
              : {}),
            transition,
          }
        : previous,
    );
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(failure);
      void client.invalidateQueries({ queryKey });
    } finally {
      setBusy(false);
    }
  }
  const closeConfirm = () => {
    if (busy) return;
    setConfirm(false);
    requestAnimationFrame(() => confirmTrigger.current?.focus());
  };

  return (
    <div className="storage-policy" aria-busy={busy}>
      <p className="storage-current">
        <span>{t('storagePolicy.current')}</span>
        <strong>{t(`storagePolicy.mode.${state.policy}`)}</strong>
      </p>
      {!editable ? (
        <Notice>{t('owner.readOnlySettings')}</Notice>
      ) : lock ? (
        <Notice>{t('owner.environmentLocked')}</Notice>
      ) : null}
      {Boolean(error) && (
        <div ref={errorRef} tabIndex={-1}>
          <ErrorNotice error={error} />
        </div>
      )}
      {canEdit && (
        <form
          className="storage-target"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const quota = Number(budget) * 1024;
              if (!validMiB(quota))
                throw new ApiError('validation_failed', 'storagePolicy.invalidSize');
              const next = await storagePolicyApi.preview(mode, quota);
              setQuotas({});
              setDisks({});
              store(next);
              requestAnimationFrame(() => previewHeading.current?.focus());
            });
          }}
        >
          <fieldset disabled={busy || underway || hasPartial}>
            <Select
              label={t('storagePolicy.mode')}
              value={mode}
              onChange={(event) => setMode(event.target.value as StorageMode)}
            >
              <option value="GLOBAL_POOL">{t('storagePolicy.mode.GLOBAL_POOL')}</option>
              <option value="PER_USER_BUDGET">{t('storagePolicy.mode.PER_USER_BUDGET')}</option>
            </Select>
            {mode === 'PER_USER_BUDGET' && (
              <Input
                label={t('storagePolicy.defaultQuota')}
                type="number"
                min={0}
                max={maximumMiB / 1024}
                step="any"
                required
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
              />
            )}
            {!hasPartial && (
              <button type="submit" className="secondary">
                {busy
                  ? t('web.pending')
                  : t(review ? 'storagePolicy.refresh' : 'storagePolicy.preview')}
              </button>
            )}
          </fieldset>
          <p className="muted">
            {t(mode === 'GLOBAL_POOL' ? 'storagePolicy.globalHelp' : 'storagePolicy.limitedHelp')}
          </p>
        </form>
      )}
      {active?.status === 'completed' && <Notice>{t('storagePolicy.completed')}</Notice>}
      {review && (
        <div className="storage-review">
          <header className="storage-review-heading">
            <h3 ref={previewHeading} tabIndex={-1}>
              {t('storagePolicy.review')}
            </h3>
            <span className="muted">{t(`storagePolicy.status.${review.status}`)}</span>
          </header>
          <p>{t(isLimited ? 'storagePolicy.reviewLimited' : 'storagePolicy.reviewUnlimited')}</p>
          {isLimited && <p className="muted">{t('storagePolicy.backupHelp')}</p>}
          {(underway || hasPartial) && (
            <Notice>
              {t(hasPartial ? 'storagePolicy.blocked' : 'storagePolicy.applying', {
                applied,
                total: servers.length,
              })}
            </Notice>
          )}
          {review.errorCode && (
            <ErrorNotice error={new ApiError(review.errorCode, `errors.${review.errorCode}`)} />
          )}
          {!draftMatches && <Notice>{t('storagePolicy.changed')}</Notice>}
          {review.users.length === 0 && <p className="muted">{t('storagePolicy.noServers')}</p>}
          {review.users.map((user, index) => {
            const allocation = allocations[index];
            if (!allocation) return null;
            return (
              <StorageUser
                key={user.userId}
                user={user}
                allocation={allocation}
                limited={Boolean(isLimited)}
                editable={editableReview}
                cleanup={canEdit && !underway}
                quota={quotas[user.userId]}
                disks={disks}
                setQuota={(value) =>
                  setQuotas((previous) => ({ ...previous, [user.userId]: value }))
                }
                setDisk={(id, value) => setDisks((previous) => ({ ...previous, [id]: value }))}
              />
            );
          })}
          {unsafe && (
            <p className="storage-blocker" role="status">
              {t('storagePolicy.resolveFirst')}
            </p>
          )}
          {canEdit && (
            <div className="actions storage-review-actions">
              {hasPartial && (
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      store(await storagePolicyApi.refresh(review.id));
                    })
                  }
                >
                  {t('storagePolicy.refreshMeasurements')}
                </button>
              )}
              {hasPartial && (
                <button
                  className="secondary"
                  type="button"
                  disabled={busy || hasEdits || unsafe}
                  onClick={() =>
                    void run(async () => {
                      store(await storagePolicyApi.retry(review.id));
                    })
                  }
                >
                  {t('storagePolicy.recheck')}
                </button>
              )}
              <button
                ref={confirmTrigger}
                type="button"
                disabled={!editableReview || unsafe}
                onClick={() => setConfirm(true)}
              >
                {t(hasPartial ? 'storagePolicy.resume' : 'storagePolicy.apply')}
              </button>
            </div>
          )}
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
              {t(isLimited ? 'storagePolicy.confirmLimited' : 'storagePolicy.confirmUnlimited', {
                count: servers.length,
                quota: unit(review.defaultUserStorageMiB),
              })}
            </p>
            <p className="muted">{t('storagePolicy.confirmCheck')}</p>
            {Boolean(error) && (
              <div ref={dialogErrorRef} tabIndex={-1}>
                <ErrorNotice error={error} />
              </div>
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
              <button
                type="button"
                disabled={busy || unsafe || !draftMatches}
                onClick={() =>
                  void run(async () => {
                    const next = await storagePolicyApi.apply(review.id, allocations);
                    store(next);
                    setConfirm(false);
                    setQuotas({});
                    setDisks({});
                    requestAnimationFrame(() => previewHeading.current?.focus());
                  })
                }
              >
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
  quota: string | undefined;
  disks: Record<string, string>;
  setQuota: (value: string) => void;
  setDisk: (serverId: string, value: string) => void;
}) {
  const t = useT();
  const format = useFormat();
  const unit = (value: number) => format.bytes(value * bytesPerMiB);
  const required = allocation.servers.reduce(
    (sum, server, index) => sum + server.diskMiB * (1 + (user.servers[index]?.backupSlots ?? 0)),
    0,
  );
  const unavailable = user.servers.some((server) => server.usageBytes === null);
  const occupied = user.servers.reduce((sum, server) => sum + (server.usageBytes ?? 0), 0);
  const shortfall = Math.max(0, required - allocation.quotaMiB);
  return (
    <section className="storage-user" aria-label={user.name}>
      <div className="storage-user-heading">
        <div>
          <h4>{user.name}</h4>
          <p className="muted">
            {t('storagePolicy.filesUsed', {
              value: unavailable ? t('storagePolicy.unavailable') : format.bytes(occupied),
            })}
          </p>
        </div>
        {limited && (
          <Input
            label={t('storagePolicy.userQuota', { name: user.name })}
            type="number"
            min={0}
            max={maximumMiB / 1024}
            step="any"
            value={quota ?? user.quotaMiB / 1024}
            disabled={!editable}
            onChange={(event) => setQuota(event.target.value)}
          />
        )}
      </div>
      {limited && (
        <div className="storage-budget">
          <span>{t('storagePolicy.reserved', { value: unit(required) })}</span>
          {shortfall > 0 ? (
            <strong className="storage-blocker">
              {t('storagePolicy.shortfall', { value: unit(shortfall) })}
            </strong>
          ) : (
            <span className="muted">
              {t('storagePolicy.remaining', {
                value: unit(Math.max(0, allocation.quotaMiB - required)),
              })}
            </span>
          )}
        </div>
      )}
      {limited && !validMiB(allocation.quotaMiB) && (
        <p className="storage-resolution storage-blocker">{t('storagePolicy.invalidSize')}</p>
      )}
      {shortfall > 0 && limited && (
        <p className="storage-resolution">{t('storagePolicy.resolveUser')}</p>
      )}
      <div className="storage-server-list">
        {user.servers.map((server, index) => {
          const disk = allocation.servers[index]?.diskMiB ?? 0;
          const tooSmall =
            limited && server.minimumDiskMiB !== null && disk < server.minimumDiskMiB;
          return (
            <div key={server.serverId} className="storage-server">
              <div className="storage-server-name">
                <strong>{server.name}</strong>
                <span className="muted">
                  {t('storagePolicy.used', {
                    value:
                      server.usageBytes === null
                        ? t('storagePolicy.unavailable')
                        : format.bytes(server.usageBytes),
                  })}
                </span>
                <small className="muted">
                  {t('storagePolicy.measured')} <Time value={server.observedAt} />
                </small>
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
              <div className="storage-server-allocation">
                {limited ? (
                  <Input
                    label={t('storagePolicy.serverQuota', { name: server.name })}
                    type="number"
                    min={0}
                    max={maximumMiB / 1024}
                    step="any"
                    value={
                      disks[server.serverId] ??
                      (server.proposedDiskMiB === null ? '' : server.proposedDiskMiB / 1024)
                    }
                    disabled={!editable || server.minimumDiskMiB === null}
                    aria-invalid={tooSmall || undefined}
                    onChange={(event) => setDisk(server.serverId, event.target.value)}
                  />
                ) : (
                  <strong>{t('storagePolicy.unlimited')}</strong>
                )}
                <small className="muted">
                  {t('storagePolicy.currentLimit', {
                    value:
                      server.currentDiskMiB === 0
                        ? t('storagePolicy.unlimited')
                        : unit(server.currentDiskMiB),
                  })}
                </small>
                {limited && server.minimumDiskMiB !== null && (
                  <small className={tooSmall ? 'storage-blocker' : 'muted'}>
                    {t('storagePolicy.minimum', { value: unit(server.minimumDiskMiB) })}
                  </small>
                )}
                {limited && server.backupSlots > 0 && (
                  <small className="muted">
                    {t('storagePolicy.backupReservation', {
                      count: server.backupSlots,
                      value: unit(disk * server.backupSlots),
                    })}
                  </small>
                )}
              </div>
              {(server.status === 'applied' || server.errorCode) && (
                <p className={server.errorCode ? 'storage-blocker' : 'muted'}>
                  {server.errorCode
                    ? t(`errors.${server.errorCode}`)
                    : t('storagePolicy.serverApplied')}
                </p>
              )}
              {server.usageBytes === null && (
                <p className="storage-blocker">{t('storagePolicy.missingMeasurement')}</p>
              )}
              {limited && server.minimumDiskMiB !== null && !validMiB(disk) && (
                <p className="storage-blocker">{t('storagePolicy.invalidSize')}</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
