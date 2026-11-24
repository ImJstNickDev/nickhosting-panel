import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { ErrorNotice } from '../../components/ui.js';
import './version-settings.css';
import type { ProvisioningStage } from '../../features/provisioning.api.js';
import { ProvisioningMark, StageIcon } from '../../features/provisioning.js';
import {
  isActive,
  type OpenworldUpdate,
  rememberUpdate,
  type UpdatePhase,
  updateKey,
  updatePath,
} from './version-update.api.js';

const stages = [
  { key: 'stepPrepare', icon: 'preparing', phases: ['preparing'] },
  { key: 'stepStop', icon: 'starting', phases: ['waiting-empty', 'notice', 'stopping'] },
  { key: 'stepBackup', icon: 'preparing', phases: ['backup'] },
  { key: 'stepInstall', icon: 'installing', phases: ['installing'] },
  { key: 'stepVerify', icon: 'configuring', phases: ['verifying'] },
  { key: 'stepStart', icon: 'starting', phases: ['starting'] },
] satisfies { key: string; icon: ProvisioningStage; phases: UpdatePhase[] }[];

function Countdown({ deadline }: { deadline: string }) {
  const t = useT();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const seconds = Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000));
  return (
    <span className="provisioning-clock" role="timer" aria-label={t(updateKey('remaining'))}>
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  );
}
export function OpenworldUpdateProgress({
  serverId,
  current,
  settings = false,
  error,
  retry,
}: {
  serverId: string;
  current: OpenworldUpdate;
  settings?: boolean;
  error?: unknown;
  retry(): void;
}) {
  const t = useT();
  const cache = useQueryClient();
  const cancel = useMutation({
    mutationFn: () =>
      api<OpenworldUpdate>(`${updatePath(serverId)}/${encodeURIComponent(current.id)}/cancel`, {
        method: 'POST',
      }),
    onSuccess: (value) => rememberUpdate(cache, serverId, value),
    onError: retry,
  });
  const active = isActive(current);
  const visible = stages.filter(
    (stage) =>
      (stage.key !== 'stepBackup' || current.backupBefore) &&
      (!['stepStop', 'stepStart'].includes(stage.key) || current.restart !== false),
  );
  const index = visible.findIndex((stage) =>
    (stage.phases as UpdatePhase[]).includes(current.phase),
  );
  const link = `/servers/${serverId}/${settings ? 'console' : 'game/version'}`;
  return (
    <aside
      className="provisioning-panel ow-update-progress"
      data-state={active ? 'active' : current.phase}
      aria-label={t(updateKey('workflow'))}
    >
      <ProvisioningMark
        phase={visible[index]?.icon ?? 'ready'}
        complete={current.phase === 'completed'}
      />
      <div className="provisioning-current">
        <span className="provisioning-eyebrow">
          {current.fromVersion} → {current.toVersion}
        </span>
        <h2 aria-live="polite">
          {t(updateKey(current.phase === 'backup' ? 'backupPhase' : current.phase))}
        </h2>
        {current.phase === 'notice' && current.deadline && (
          <Countdown deadline={current.deadline} />
        )}
      </div>
      {active && (
        <ol className="provisioning-stages" aria-label={t('provisioning.steps')}>
          {visible.map((stage, i) => {
            const state = i === index ? 'active' : i < index ? 'completed' : 'pending';
            return (
              <li
                key={stage.key}
                data-state={state}
                aria-current={i === index ? 'step' : undefined}
              >
                <span className="provisioning-stage-icon">
                  <StageIcon stage={stage.icon} complete={i < index} />
                </span>
                <span>
                  {t(
                    updateKey(
                      state === 'active' && ['waiting-empty', 'notice'].includes(current.phase)
                        ? 'stepWait'
                        : stage.key,
                    ),
                  )}
                </span>
                <span className="visually-hidden">{t(`provisioning.stage.${state}`)}</span>
              </li>
            );
          })}
        </ol>
      )}
      {current.warning && ['notice_failed', 'reminder_failed'].includes(current.warning) && (
        <p className="provisioning-context">{t(updateKey(current.warning))}</p>
      )}
      {current.error && (
        <p className="provisioning-context" role="alert">
          {t(`errors.${current.error}`)}
        </p>
      )}
      {error != null && <ErrorNotice error={error} retry={retry} />}
      {cancel.error && <ErrorNotice error={cancel.error} />}
      <div className="provisioning-links">
        {current.cancellable && active && (
          <button
            className="secondary"
            type="button"
            disabled={cancel.isPending || Boolean(error)}
            onClick={() => cancel.mutate()}
          >
            {t(updateKey('cancel'))}
          </button>
        )}
        <Link to={link}>{t(updateKey(settings ? 'openConsole' : 'details'))}</Link>
      </div>
    </aside>
  );
}
