import type { ContentPolicyOverride, resolveContentPolicy } from '@nickhosting/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import {
  ActionForm,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  Section,
  Select,
  Textarea,
} from '../components/ui.js';

type Policy = {
  policy: ContentPolicyOverride;
  effective: ReturnType<typeof resolveContentPolicy>;
  locked: boolean;
};
const limits = [
  'sourceGlobalBytes',
  'sourceUserBytes',
  'sourceConcurrent',
  'sourceUserConcurrent',
  'sourceFreeBytes',
  'sourceFreePercent',
] as const;
export function IntegrationContentPolicy({ gameId }: { gameId: string }) {
  const t = useT();
  const path = `/v1/owner/integrations/${encodeURIComponent(gameId)}/content-policy`;
  const query = useQuery({
    queryKey: ['integration-content-policy', gameId],
    queryFn: () => api<Policy>(path),
  });
  return (
    <Section
      title={t('contentPolicy.title')}
      actions={<Link to="/owner/settings#content">{t('contentPolicy.globalLink')}</Link>}
    >
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorNotice error={query.error} />
      ) : (
        <PolicyForm
          key={JSON.stringify(query.data)}
          data={query.data}
          save={async (policy) => {
            await api(path, { method: 'PUT', body: policy });
            await query.refetch();
          }}
        />
      )}
    </Section>
  );
}
function PolicyForm({
  data,
  save,
}: {
  data: Policy;
  save: (policy: ContentPolicyOverride) => Promise<void>;
}) {
  const t = useT(),
    format = useFormat();
  const [restricted, setRestricted] = useState(data.policy.downloadOrigins !== undefined);
  return (
    <fieldset disabled={data.locked}>
      {data.locked && <Notice>{t('owner.environmentLocked')}</Notice>}
      <p className="muted">{t('contentPolicy.globalBound')}</p>
      <ActionForm
        onSubmit={async (form) => {
          const policy: ContentPolicyOverride = {};
          for (const key of limits) {
            const raw = String(form.get(key) ?? '').trim();
            if (raw) policy[key] = Number(raw);
          }
          if (restricted)
            policy.downloadOrigins = String(form.get('downloadOrigins') ?? '')
              .split('\n')
              .map((v) => v.trim())
              .filter(Boolean);
          await save(policy);
        }}
      >
        <div className="integration-settings-grid">
          {limits.map((key) => (
            <div key={key}>
              <Input
                label={t(`contentPolicy.${key}`)}
                name={key}
                type="number"
                step={key === 'sourceFreePercent' ? 'any' : 1}
                min={key.startsWith('sourceFree') ? 0 : 1}
                max={
                  key === 'sourceFreePercent'
                    ? 95
                    : key === 'sourceConcurrent'
                      ? 100
                      : key === 'sourceUserConcurrent'
                        ? 20
                        : Number.MAX_SAFE_INTEGER
                }
                defaultValue={data.policy[key] ?? ''}
                placeholder={`${t('contentPolicy.inherit')}: ${key.endsWith('Bytes') ? format.bytes(Number(data.effective.fields[key]?.global)) : format.number(Number(data.effective.fields[key]?.global))}`}
              />
              <small className="muted">
                {t('contentPolicy.effective')}:{' '}
                {key.endsWith('Bytes')
                  ? format.bytes(data.effective.values[key])
                  : format.number(data.effective.values[key])}
              </small>
            </div>
          ))}
        </div>
        <Select
          label={t('contentPolicy.origins')}
          value={restricted ? 'restrict' : 'inherit'}
          onChange={(e) => setRestricted(e.target.value === 'restrict')}
        >
          <option value="inherit">{t('contentPolicy.inherit')}</option>
          <option value="restrict">{t('contentPolicy.override')}</option>
        </Select>
        {restricted && (
          <Textarea
            name="downloadOrigins"
            label={t('contentPolicy.origins')}
            defaultValue={data.policy.downloadOrigins?.join('\n') ?? ''}
          />
        )}
        <small className="muted">{t('contentPolicy.originsHelp')}</small>
      </ActionForm>
    </fieldset>
  );
}
