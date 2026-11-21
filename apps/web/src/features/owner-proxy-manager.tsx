import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { ActionForm, Input, Notice } from '../components/ui.js';

export function OwnerProxyManager({
  config,
  secret,
  editable,
  onSaved,
}: {
  config: { values: Record<string, unknown>; lockedKeys: string[] };
  secret: { configured: boolean; locked: boolean };
  editable: boolean;
  onSaved: () => Promise<unknown>;
}) {
  const t = useT();
  const currentUrl = String(config.values.npmApiUrl ?? '');
  const currentEmail = String(config.values.npmAcmeEmail ?? '');
  const [url, setUrl] = useState(currentUrl);
  const [email, setEmail] = useState(currentEmail);
  const [token, setToken] = useState('');
  const urlLocked = config.lockedKeys.includes('npmApiUrl');
  const emailLocked = config.lockedKeys.includes('npmAcmeEmail');
  const path = '/v1/owner/secrets/npmAccessToken';
  const dirty = url.trim() !== currentUrl || email.trim() !== currentEmail || Boolean(token);
  return (
    <details>
      <summary>
        Nginx Proxy Manager{' '}
        <small>{t(secret.configured ? 'owner.configured' : 'web.unconfigured')}</small>
      </summary>
      <ActionForm
        disabled={!editable}
        submitDisabled={!dirty}
        onSubmit={async () => {
          const patch: Record<string, string> = {};
          if (!urlLocked && !secret.configured && url.trim() !== currentUrl)
            patch.npmApiUrl = url.trim();
          if (!emailLocked && email.trim() !== currentEmail) patch.npmAcmeEmail = email.trim();
          // Only hand the token to NickPanel after the destination was accepted.
          if (Object.keys(patch).length)
            await api('/v1/owner/settings', { method: 'PATCH', body: patch });
          try {
            if (token && !secret.locked) {
              await api(path, {
                method: 'PUT',
                body: { value: token, expectedOrigin: new URL(url.trim()).origin },
              });
              setToken('');
            }
          } finally {
            await onSaved();
          }
        }}
      >
        <Input
          name="url"
          type="url"
          label={t('owner.config.npmApiUrl')}
          required
          value={url}
          disabled={!editable || urlLocked || secret.configured}
          hint={
            urlLocked
              ? t('owner.environmentLocked')
              : secret.configured
                ? t('owner.npmChangeUrl')
                : undefined
          }
          onChange={(e) => setUrl(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <Input
          name="email"
          type="email"
          label={t('owner.config.npmAcmeEmail')}
          required
          value={email}
          disabled={!editable || emailLocked}
          hint={emailLocked ? t('owner.environmentLocked') : undefined}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <Input
          name="token"
          type="password"
          label={t('owner.secret.npmAccessToken')}
          value={token}
          maxLength={4096}
          disabled={!editable || secret.locked}
          hint={secret.locked ? t('owner.environmentLocked') : undefined}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
        />
      </ActionForm>
      {!editable && <Notice>{t('owner.readOnlySettings')}</Notice>}
      {editable && !secret.locked && secret.configured && (
        <ActionForm
          submitLabel={t('owner.npmRemoveToken')}
          onSubmit={async () => {
            await api(path, { method: 'DELETE' });
            setToken('');
            await onSaved();
          }}
        >
          {null}
        </ActionForm>
      )}
    </details>
  );
}
