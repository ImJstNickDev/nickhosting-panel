import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, api, idempotencyKey } from '../../api/client.js';
import { useFormat, useT } from '../../app/i18n.js';
import {
  Check,
  Dialog,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  Section,
  Select,
  Time,
} from '../../components/ui.js';
import { Switch } from '../../components/workspace-controls.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import { useServer } from '../../features/service-contracts.js';
import { OpenworldUpdateProgress } from './version-progress.js';
import {
  isActive,
  type OpenworldUpdate,
  rememberUpdate,
  type UpdateCatalog,
  type UpdateRequest,
  updateKey,
  updatePath,
  useOpenworldUpdate,
} from './version-update.api.js';
import './version-settings.css';

function UpdateDialog({
  serverId,
  catalog,
  targetVersion,
  runtimeState,
  canBackup,
  blocked,
  open,
  onClose,
}: {
  serverId: string;
  catalog: UpdateCatalog;
  targetVersion: string;
  runtimeState: string;
  canBackup: boolean;
  blocked: boolean;
  open: boolean;
  onClose(retain: boolean): void;
}) {
  const t = useT(),
    navigate = useNavigate(),
    cache = useQueryClient();
  const [delay, setDelay] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [seconds, setSeconds] = useState(String(catalog.defaultNoticeSeconds));
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const [uncertain, setUncertain] = useState<UpdateRequest>();
  const lock = useRef(false);
  const frozen = busy || Boolean(uncertain);
  const mode = empty ? 'when-empty' : delay ? 'timed' : 'immediate';
  const valid =
    mode !== 'timed' || (/^\d+$/.test(seconds) && Number(seconds) >= 1 && Number(seconds) <= 86400);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || (!uncertain && (!valid || blocked || (backup && !canBackup)))) return;
    lock.current = true;
    setBusy(true);
    setFailure(undefined);
    const request: UpdateRequest = uncertain ?? {
      version: targetVersion,
      expectedVersion: catalog.installedVersion,
      mode,
      ...(mode === 'timed' && { noticeSeconds: Number(seconds) }),
      backupBefore: backup,
      idempotencyKey: idempotencyKey(),
    };
    try {
      const accepted = await api<OpenworldUpdate>(updatePath(serverId), {
        method: 'POST',
        body: request,
      });
      await rememberUpdate(cache, serverId, accepted);
      navigate(`/servers/${serverId}/console`);
    } catch (error) {
      if (!(error instanceof ApiError) || !error.status || error.status >= 500)
        setUncertain(request);
      else {
        setUncertain(undefined);
        if (error.status === 409)
          void cache.invalidateQueries({ queryKey: ['openworld', serverId, 'update-catalog'] });
      }
      setFailure(error);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const offline = ['offline', 'stopped'].includes(runtimeState);
  return (
    <Dialog
      open={open}
      title={t(updateKey('workflow'))}
      onClose={() => {
        if (!busy) onClose(Boolean(uncertain));
      }}
      closeIcon
      closeDisabled={busy}
      className="confirmation-dialog ow-update-dialog"
    >
      <form onSubmit={submit}>
        <div className="ow-update-route">
          <div>
            <span>{t(updateKey('from'))}</span>
            <strong>{catalog.installedVersion}</strong>
          </div>
          <span aria-hidden="true">→</span>
          <div>
            <span>{t(updateKey('to'))}</span>
            <strong>{targetVersion}</strong>
          </div>
        </div>
        <div className="ow-update-options">
          <Switch
            label={t(updateKey('delay'))}
            checked={delay && !empty}
            disabled={frozen}
            onChange={(enabled) => {
              setDelay(enabled);
              if (enabled) setEmpty(false);
            }}
          />
          {mode === 'timed' && (
            <Input
              label={t(updateKey('duration'))}
              value={seconds}
              type="number"
              min={1}
              max={86400}
              step={1}
              required
              disabled={frozen}
              onChange={(e) => setSeconds(e.target.value)}
            />
          )}
          <Switch
            label={t(updateKey('empty'))}
            checked={empty}
            disabled={frozen}
            onChange={setEmpty}
          />
          <p className="muted" role="status">
            {t(
              updateKey(
                mode === 'when-empty'
                  ? 'emptyHint'
                  : mode === 'timed'
                    ? 'timedHint'
                    : 'immediateHint',
              ),
            )}
          </p>
        </div>
        {canBackup && (
          <Check
            label={t(updateKey('backup'))}
            checked={backup}
            disabled={frozen}
            onChange={(e) => setBackup(e.target.checked)}
          />
        )}
        {(offline || runtimeState === 'running') && (
          <p className="muted">{t(updateKey(offline ? 'offline' : 'running'))}</p>
        )}
        {failure != null && <ErrorNotice error={failure} />}
        {uncertain && <Notice>{t(updateKey('uncertain'))}</Notice>}
        <div className="actions">
          <button type="submit" disabled={busy || (!uncertain && (!valid || blocked))}>
            {t(busy ? 'web.pending' : updateKey(uncertain ? 'retryRequest' : 'submit'))}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function OpenworldVersionSettings({
  serverId,
  pending,
  runtimeState,
  canManage,
  permissionKeys,
}: GameSectionViewProps) {
  const t = useT(),
    format = useFormat();
  const server = useServer(serverId);
  const state = useOpenworldUpdate(serverId, canManage, server.data?.activeOperationId);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [review, setReview] = useState<{
    targetVersion: string;
    catalog: UpdateCatalog;
  }>();
  const data = state.catalog.data;
  if (!canManage) return <Notice>{t('gameUi.noPermission')}</Notice>;
  if (!data && state.current)
    return (
      <OpenworldUpdateProgress
        serverId={serverId}
        current={state.current}
        settings
        error={state.statusError}
        retry={state.retry}
      />
    );
  if (!data)
    return state.error ? <ErrorNotice error={state.error} retry={state.retry} /> : <Loading />;
  const target =
    data.releases.find((item) => item.version === selected) ??
    data.releases.find((item) => item.version === data.latestVersion);
  const active = isActive(state.current);
  const blocked = pending || Boolean(state.error) || active;
  return (
    <>
      <Section title={t('games.openworld.version')}>
        <div className="ow-version-row">
          <div>
            <span className="muted">{t(updateKey('installed'))}</span>
            <strong>{data.installedVersion ?? t('web.unavailable')}</strong>
          </div>
          {data.latestVersion && (
            <div>
              <span className="muted">{t(updateKey('latest'))}</span>
              <strong>{data.latestVersion}</strong>
            </div>
          )}
        </div>
        {review && !open && (
          <button type="button" onClick={() => setOpen(true)}>
            {t(updateKey('retryRequest'))}
          </button>
        )}
        {(!review || open) &&
          !active &&
          data.installedVersion &&
          (!data.latestVersion ? (
            <p className="muted">{t(updateKey('current'))}</p>
          ) : (
            <div className="ow-version-choice">
              <Select
                label={t(updateKey('target'))}
                value={target?.version ?? ''}
                disabled={blocked}
                onChange={(e) => setSelected(e.target.value)}
              >
                {data.releases.map((release) => (
                  <option key={release.version} value={release.version}>
                    {release.version} · {format.bytes(release.size)}
                  </option>
                ))}
              </Select>
              <button
                type="button"
                disabled={!target || blocked}
                onClick={() => {
                  if (data.installedVersion && target) {
                    setOpen(true);
                    setReview({
                      targetVersion: target.version,
                      catalog: data,
                    });
                  }
                }}
              >
                {t(updateKey('review'))}
              </button>
            </div>
          ))}
        {!active && state.error != null && <ErrorNotice error={state.error} retry={state.retry} />}
      </Section>
      {state.current &&
        (active || state.current.phase === 'failed' ? (
          <OpenworldUpdateProgress
            serverId={serverId}
            current={state.current}
            settings
            error={state.statusError}
            retry={state.retry}
          />
        ) : (
          <Section title={t(updateKey('last'))}>
            <span>
              {t(updateKey(state.current.phase))} · {state.current.fromVersion} →{' '}
              {state.current.toVersion} · <Time value={state.current.updatedAt} />
            </span>
          </Section>
        ))}
      {review && (
        <UpdateDialog
          serverId={serverId}
          catalog={review.catalog}
          targetVersion={review.targetVersion}
          runtimeState={runtimeState}
          canBackup={permissionKeys.includes('backups.create')}
          blocked={
            blocked ||
            data.installedVersion !== review.catalog.installedVersion ||
            !data.releases.some((r) => r.version === review.targetVersion)
          }
          open={open}
          onClose={(retain) => {
            setOpen(false);
            if (!retain) setReview(undefined);
          }}
        />
      )}
    </>
  );
}
