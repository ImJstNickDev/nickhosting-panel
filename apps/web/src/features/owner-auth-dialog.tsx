import { type ReactNode, useState } from 'react';
import { ApiError, api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import type { WebSession } from '../app/session.js';
import { ActionForm, Dialog, Input, text } from '../components/ui.js';

export function OwnerAuthDialog({
  actor,
  purpose,
  subjectUserId,
  description,
  submitLabel,
  onVerified,
  onClose,
  children,
}: {
  actor: WebSession['actor'];
  purpose: 'support' | 'recovery-link';
  subjectUserId: string;
  description: string;
  submitLabel: string;
  onVerified: (stepUpToken: string) => Promise<void>;
  onClose: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState(false);
  return (
    <Dialog
      open
      title={t('owner.verifyIdentity')}
      onClose={onClose}
      closeIcon
      closeDisabled={busy}
      initialFocusSelector="input[type=password]"
      className="owner-action-dialog"
    >
      <p className="owner-dialog-context">{description}</p>
      <ActionForm
        success={false}
        onCancel={onClose}
        onBusyChange={setBusy}
        submitLabel={submitLabel}
        onSubmit={async (data) => {
          const grant = await api<{ token: string }>('/v1/identity/step-up', {
            body: {
              purpose,
              subjectUserId,
              password: String(data.get('password')),
              ...(actor.twoFactorEnabled &&
                (recovery
                  ? { recoveryCode: text(data, 'recovery') }
                  : { totpCode: text(data, 'totp') })),
            },
          }).catch((error: unknown) => {
            if (error instanceof ApiError && error.code === 'forbidden') {
              throw new ApiError(error.code, 'owner.verifyFailed');
            }
            throw error;
          });
          await onVerified(grant.token);
        }}
      >
        {children}
        <Input
          label={t('owner.adminAccount')}
          type="email"
          name="username"
          autoComplete="username"
          value={actor.email}
          readOnly
        />
        <Input
          label={t('web.currentPassword')}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        {actor.twoFactorEnabled && (
          <>
            {recovery ? (
              <Input
                key="recovery"
                label={t('web.recoveryCode')}
                name="recovery"
                autoComplete="off"
                required
              />
            ) : (
              <Input
                key="totp"
                label={t('web.code')}
                name="totp"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
            )}
            <button
              type="button"
              className="owner-text-action"
              onClick={() => setRecovery(!recovery)}
            >
              {t(recovery ? 'owner.useAuthenticator' : 'web.useRecovery')}
            </button>
          </>
        )}
      </ActionForm>
    </Dialog>
  );
}
