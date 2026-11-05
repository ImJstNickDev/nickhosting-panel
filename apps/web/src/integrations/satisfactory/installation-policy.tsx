import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { ActionForm, ErrorNotice, Input, Loading, Notice, Section } from '../../components/ui.js';

export function SatisfactoryInstallationPolicy() {
  const t = useT();
  const settings = useQuery({
    queryKey: ['owner-settings'],
    queryFn: () =>
      api<{
        config: { values: { satisfactoryInstallationRetries: number }; lockedKeys: string[] };
      }>('/v1/owner/settings'),
  });
  if (settings.error) return <ErrorNotice error={settings.error} />;
  if (!settings.data) return <Loading />;
  const locked = settings.data.config.lockedKeys.includes('satisfactoryInstallationRetries');
  return (
    <Section title={t('ownerIntegration.installation')}>
      {locked && <Notice>{t('sleepTiming.locked')}</Notice>}
      <ActionForm
        disabled={locked}
        key={settings.data.config.values.satisfactoryInstallationRetries}
        onSubmit={async (data) => {
          await api('/v1/owner/settings', {
            method: 'PATCH',
            body: { satisfactoryInstallationRetries: Number(data.get('retries')) },
          });
          await settings.refetch();
        }}
      >
        <Input
          label={t('ownerIntegration.installationRetries')}
          name="retries"
          type="number"
          min="0"
          max="5"
          step="1"
          required
          defaultValue={settings.data.config.values.satisfactoryInstallationRetries}
        />
        <p>{t('ownerIntegration.installationRetriesHelp')}</p>
      </ActionForm>
    </Section>
  );
}
