import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { ActionForm, Input } from '../components/ui.js';
export function OwnerSecretForm({
  path,
  onSaved,
  allowClear = false,
}: {
  path: string;
  onSaved: () => Promise<void>;
  allowClear?: boolean;
}) {
  const t = useT();
  const [value, setValue] = useState('');
  return (
    <>
      <ActionForm
        onSubmit={async () => {
          await api(path, { method: 'PUT', body: { value } });
          setValue('');
          await onSaved();
        }}
      >
        <Input
          label={t('owner.newCredential')}
          name="value"
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          required
          maxLength={4096}
        />
      </ActionForm>
      {allowClear && (
        <ActionForm
          submitLabel={t('ownerIntegration.metivaClear')}
          onSubmit={async () => {
            await api(path, { method: 'DELETE' });
            setValue('');
            await onSaved();
          }}
        >
          {null}
        </ActionForm>
      )}
    </>
  );
}
