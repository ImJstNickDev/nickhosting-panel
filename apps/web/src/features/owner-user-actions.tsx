import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, readApi } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { identityChanged, type WebSession } from '../app/session.js';
import { ActionForm, Dialog, ErrorNotice, Input, Textarea, text } from '../components/ui.js';
import { OwnerAuthDialog } from './owner-auth-dialog.js';
import { useRefreshAtExpiry } from './use-storage-usage.js';
import './owner-user-actions.css';

type Recovery = { url: string; expiresAt: string };
type Status = { available: boolean; expiresAt: string | null };
type Phase =
  | { kind: 'reason' }
  | { kind: 'support'; reason: string }
  | { kind: 'recovery'; mode: 'create' | 'reveal'; expiresAt?: string }
  | { kind: 'link'; link: Recovery };

function localMinute(time: number) {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function RecoveryDialog({
  link,
  user,
  onClose,
  onExpiry,
}: {
  link: Recovery;
  user: string;
  onClose: () => void;
  onExpiry: (expiresAt: string) => void;
}) {
  const t = useT(),
    format = useFormat();
  const input = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<'ready' | 'copied' | 'failed'>('ready');
  const [editing, setEditing] = useState(false);
  const now = Date.now();
  return (
    <Dialog
      open
      closeIcon
      title={t('owner.recoveryLink')}
      onClose={onClose}
      className="owner-action-dialog"
      initialFocusSelector="input[readonly]"
    >
      <div className="owner-link-content">
        <p className="owner-dialog-context">{user}</p>
        <Input
          ref={input}
          label={t('owner.recoveryLink')}
          readOnly
          value={link.url}
          autoComplete="off"
          onFocus={(e) => e.target.select()}
        />
        {editing ? (
          <ActionForm
            success={false}
            submitLabel={t('web.next')}
            onCancel={() => setEditing(false)}
            onSubmit={async (data) => onExpiry(new Date(text(data, 'expires')).toISOString())}
          >
            <Input
              label={t('web.expires')}
              name="expires"
              type="datetime-local"
              defaultValue={localMinute(Date.parse(link.expiresAt))}
              min={localMinute(now + 60000)}
              max={localMinute(now + 365 * 86400000)}
              required
            />
          </ActionForm>
        ) : (
          <div className="owner-link-expiry">
            <span>
              {t('web.expires')}{' '}
              <time dateTime={link.expiresAt}>{format.date(link.expiresAt)}</time>
            </span>
            <button type="button" className="owner-text-action" onClick={() => setEditing(true)}>
              {t('owner.changeExpiry')}
            </button>
          </div>
        )}
        {copy === 'failed' && <p role="alert">{t('owner.inviteCopyFailed')}</p>}
        {!editing && (
          <div className="owner-dialog-footer">
            <button type="button" className="secondary" onClick={onClose}>
              {t('web.close')}
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link.url);
                  setCopy('copied');
                } catch {
                  setCopy('failed');
                  input.current?.focus();
                  input.current?.select();
                }
              }}
            >
              <span aria-live="polite">
                {t(copy === 'copied' ? 'web.copied' : 'owner.copyLink')}
              </span>
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function recoveryStatusKey(ownerId: string, userId: string) {
  return ['owner-recovery-status', ownerId, userId] as const;
}

export function useOwnerRecoveryStatus(ownerId: string, userId: string, enabled: boolean) {
  return useQuery({
    queryKey: recoveryStatusKey(ownerId, userId),
    networkMode: 'always',
    queryFn: ({ signal }) =>
      readApi<Status>(`/v1/owner/users/${encodeURIComponent(userId)}/recovery-link`, signal),
    enabled,
  });
}

export function OwnerUserActions({
  actor,
  user,
  status,
  profileConfirmed,
}: {
  actor: WebSession['actor'];
  status: ReturnType<typeof useOwnerRecoveryStatus>;
  profileConfirmed: boolean;
  user: { id: string; name: string; email: string; role: string };
}) {
  const t = useT(),
    format = useFormat(),
    navigate = useNavigate(),
    queryClient = useQueryClient();
  const key = recoveryStatusKey(actor.id, user.id);
  const path = `/v1/owner/users/${encodeURIComponent(user.id)}/recovery-link`;
  const [phase, setPhase] = useState<Phase>();
  const [customExpiry, setCustomExpiry] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const begin = (button: HTMLButtonElement, next: Phase) => {
    trigger.current = button;
    setPhase(next);
  };
  const close = () => {
    setPhase(undefined);
    setCustomExpiry('');
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) trigger.current?.focus();
    });
  };
  const deadline = status.data?.expiresAt ? Date.parse(status.data.expiresAt) : Number.NaN;
  useRefreshAtExpiry(deadline);
  const canRecover =
    profileConfirmed && user.role !== 'owner' && !status.isError && status.data?.available;
  const active = canRecover && Date.now() < deadline;
  const showingLink = phase?.kind === 'link';
  const { refetch } = status;
  useEffect(() => {
    if (!showingLink) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refetch();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [showingLink, refetch]);
  useEffect(() => {
    if (phase?.kind === 'link' && (!active || status.data?.expiresAt !== phase.link.expiresAt)) {
      setPhase(undefined);
    }
  }, [active, phase, status.data?.expiresAt]);
  return (
    <>
      {profileConfirmed && user.role !== 'owner' && status.isError && (
        <ErrorNotice error={status.error} retry={() => void status.refetch()} />
      )}
      {canRecover && (
        <button
          type="button"
          className="secondary"
          onClick={(e) =>
            begin(e.currentTarget, { kind: 'recovery', mode: active ? 'reveal' : 'create' })
          }
        >
          {t(active ? 'owner.showRecoveryLink' : 'owner.generateRecoveryLink')}
        </button>
      )}
      {actor.id !== user.id && (
        <button
          type="button"
          className="secondary"
          onClick={(e) => begin(e.currentTarget, { kind: 'reason' })}
        >
          {t('web.support')}
        </button>
      )}
      {phase?.kind === 'reason' && (
        <Dialog
          open
          closeIcon
          className="owner-action-dialog"
          title={t('web.support')}
          onClose={close}
          initialFocusSelector="textarea"
        >
          <p className="owner-dialog-context">{t('owner.supportContext', { name: user.name })}</p>
          <ActionForm
            onCancel={close}
            success={false}
            submitLabel={t('web.next')}
            submitDisabled={!profileConfirmed}
            onSubmit={async (data) => setPhase({ kind: 'support', reason: text(data, 'reason') })}
          >
            <Textarea
              label={t('web.reason')}
              name="reason"
              minLength={8}
              maxLength={300}
              rows={3}
              required
            />
          </ActionForm>
        </Dialog>
      )}
      {(phase?.kind === 'support' || phase?.kind === 'recovery') && (
        <OwnerAuthDialog
          actor={actor}
          subjectUserId={user.id}
          purpose={phase.kind === 'support' ? 'support' : 'recovery-link'}
          onClose={close}
          description={
            phase.kind === 'support'
              ? t('owner.confirmSupport', { name: user.name })
              : phase.expiresAt
                ? t('owner.confirmExpiry', {
                    name: user.name,
                    expires: format.date(phase.expiresAt),
                  })
                : t(phase.mode === 'reveal' ? 'owner.confirmReveal' : 'owner.confirmRecovery', {
                    name: user.name,
                  })
          }
          submitLabel={t(
            phase.kind === 'support'
              ? 'owner.startSupport'
              : phase.expiresAt
                ? 'web.save'
                : phase.mode === 'reveal'
                  ? 'owner.showRecoveryLink'
                  : 'owner.generateRecoveryLink',
          )}
          onVerified={async (stepUpToken) => {
            if (phase.kind === 'support') {
              await api('/v1/web/support', {
                body: { stepUpToken, subjectUserId: user.id, reason: phase.reason },
              });
              await identityChanged();
              navigate('/');
            } else {
              const link = await api<Recovery>(path, {
                body: {
                  stepUpToken,
                  mode: phase.mode,
                  expiresAt:
                    phase.expiresAt ??
                    (phase.mode === 'create' && customExpiry
                      ? new Date(customExpiry).toISOString()
                      : undefined),
                },
              }).catch((error: unknown) => {
                void status.refetch();
                throw error;
              });
              await queryClient.cancelQueries({ queryKey: key });
              queryClient.setQueryData<Status>(key, { available: true, expiresAt: link.expiresAt });
              setPhase({ kind: 'link', link });
            }
          }}
        >
          {phase.kind === 'recovery' && phase.mode === 'create' && !phase.expiresAt && (
            <details className="owner-expiry-option">
              <summary>
                {customExpiry
                  ? `${t('web.expires')} · ${format.date(customExpiry)}`
                  : t('owner.recoveryDuration')}
              </summary>
              <Input
                label={t('web.expires')}
                name="expires"
                type="datetime-local"
                min={localMinute(Date.now() + 60000)}
                max={localMinute(Date.now() + 365 * 86400000)}
                value={customExpiry}
                onChange={(e) => setCustomExpiry(e.target.value)}
              />
            </details>
          )}
        </OwnerAuthDialog>
      )}
      {phase?.kind === 'link' && active && status.data?.expiresAt === phase.link.expiresAt && (
        <RecoveryDialog
          link={phase.link}
          user={`${user.name} · ${user.email}`}
          onClose={close}
          onExpiry={(expiresAt) => setPhase({ kind: 'recovery', mode: 'reveal', expiresAt })}
        />
      )}
    </>
  );
}
