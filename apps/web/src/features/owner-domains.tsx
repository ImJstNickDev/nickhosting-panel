import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import { Tooltip } from '../components/tooltip.js';
import { ActionForm, ErrorNotice, Input, Loading, Notice, Select } from '../components/ui.js';
import './connection.css';

type Domain = { id: string; hostname: string; zoneId: string; target?: string; enabled: boolean };
type Term = { value: string; match: 'exact' | 'word' | 'substring' };
type Policy = {
  selection: 'all' | 'allow' | 'deny';
  domainIds: string[];
  defaultDomainId?: string;
  sharedLabel?: string;
};
type Settings = { config: { values: Record<string, unknown>; lockedKeys: string[] } };
export const domainSettingKeys = [
  'dnsDomains',
  'dnsDefaultDomainId',
  'dnsBlockedTerms',
  'dnsNameReuseDelaySeconds',
  'dnsGamePolicies',
];
export function configuredDomains(values: Record<string, unknown>): Domain[] {
  const entries = values.dnsDomains as Domain[] | undefined;
  if (entries?.length) return entries;
  return values.dnsBaseDomain && values.cloudflareZoneId
    ? [
        {
          id: 'legacy',
          hostname: String(values.dnsBaseDomain),
          zoneId: String(values.cloudflareZoneId),
          ...(values.dnsTarget ? { target: String(values.dnsTarget) } : {}),
          enabled: true,
        },
      ]
    : [];
}
export function OwnerDomains({
  values,
  lockedKeys,
  editable,
  onSaved,
}: {
  values: Record<string, unknown>;
  lockedKeys: string[];
  editable: boolean;
  onSaved: () => Promise<unknown>;
}) {
  const t = useT();
  const [domains, setDomains] = useState(() => configuredDomains(values));
  const [defaultId, setDefaultId] = useState(
    String(values.dnsDefaultDomainId ?? domains[0]?.id ?? ''),
  );
  const [terms, setTerms] = useState(() =>
    ((values.dnsBlockedTerms as Term[]) ?? []).map((term) => ({
      ...term,
      key: crypto.randomUUID(),
    })),
  );
  const legacyLocked =
    !(values.dnsDomains as Domain[] | undefined)?.length &&
    ['dnsBaseDomain', 'cloudflareZoneId', 'dnsTarget'].some((key) => lockedKeys.includes(key));
  const preserveLastDomain =
    domains.length === 1 && Boolean(values.dnsBaseDomain && values.cloudflareZoneId);
  const locked = (key: string) =>
    !editable || lockedKeys.includes(key) || (key === 'dnsDomains' && legacyLocked);
  const update = (index: number, patch: Partial<Domain>) =>
    setDomains((current) =>
      current.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );
  return (
    <fieldset disabled={!editable} className="domain-editor">
      {(legacyLocked || domainSettingKeys.some((key) => lockedKeys.includes(key))) && (
        <Notice>{t('sleepTiming.locked')}</Notice>
      )}
      <ActionForm
        disabled={locked('dnsDomains') && locked('dnsDefaultDomainId')}
        onSubmit={async () => {
          if (!locked('dnsDefaultDomainId') && !defaultId && values.dnsDefaultDomainId)
            await api('/v1/owner/settings/dnsDefaultDomainId', { method: 'DELETE' });
          await api('/v1/owner/settings', {
            method: 'PATCH',
            body: {
              ...(!locked('dnsDomains')
                ? {
                    dnsDomains: domains.map((entry) => ({
                      ...entry,
                      hostname: entry.hostname.trim().toLowerCase(),
                      zoneId: entry.zoneId.trim().toLowerCase(),
                      ...(entry.target?.trim()
                        ? { target: entry.target.trim() }
                        : { target: undefined }),
                    })),
                  }
                : {}),
              ...(!locked('dnsDefaultDomainId')
                ? { dnsDefaultDomainId: defaultId || undefined }
                : {}),
            },
          });
          await onSaved();
        }}
      >
        {domains.map((entry, index) => (
          <div className="domain-row" key={entry.id}>
            <Input
              label={t('connection.domain')}
              required
              value={entry.hostname}
              disabled={locked('dnsDomains')}
              onChange={(event) => update(index, { hostname: event.target.value })}
            />
            <Input
              label={t('connection.zone')}
              required
              value={entry.zoneId}
              disabled={locked('dnsDomains')}
              onChange={(event) => update(index, { zoneId: event.target.value })}
            />
            <Input
              label={t('connection.target')}
              value={entry.target ?? ''}
              disabled={locked('dnsDomains')}
              onChange={(event) => update(index, { target: event.target.value })}
            />
            <Select
              label={t('web.status')}
              value={entry.enabled ? 'enabled' : 'disabled'}
              disabled={locked('dnsDomains')}
              onChange={(event) => update(index, { enabled: event.target.value === 'enabled' })}
            >
              <option value="enabled">{t('connection.available')}</option>
              <option value="disabled">{t('connection.unavailable')}</option>
            </Select>
            <div className="domain-row-actions">
              <button
                type="button"
                className="secondary"
                disabled={locked('dnsDefaultDomainId') || !entry.enabled}
                aria-pressed={defaultId === entry.id}
                onClick={() => setDefaultId(entry.id)}
              >
                {t(defaultId === entry.id ? 'connection.default' : 'connection.makeDefault')}
              </button>
              <Tooltip content={t(preserveLastDomain ? 'connection.disableLast' : 'web.remove')}>
                <span>
                  {' '}
                  <button
                    type="button"
                    className="secondary"
                    disabled={locked('dnsDomains') || preserveLastDomain}
                    onClick={() => {
                      setDomains((current) => current.filter((domain) => domain.id !== entry.id));
                      if (defaultId === entry.id) setDefaultId('');
                    }}
                  >
                    {t('web.remove')}
                  </button>
                </span>
              </Tooltip>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="secondary"
          disabled={locked('dnsDomains')}
          onClick={() =>
            setDomains((current) => [
              ...current,
              { id: `domain-${crypto.randomUUID()}`, hostname: '', zoneId: '', enabled: true },
            ])
          }
        >
          {t('connection.addDomain')}
        </button>
      </ActionForm>
      <details>
        <summary>{t('connection.blockedTerms')}</summary>
        <ActionForm
          disabled={locked('dnsBlockedTerms') && locked('dnsNameReuseDelaySeconds')}
          onSubmit={async (data) => {
            await api('/v1/owner/settings', {
              method: 'PATCH',
              body: {
                ...(!locked('dnsBlockedTerms')
                  ? {
                      dnsBlockedTerms: terms.map((term) => ({
                        match: term.match,
                        value: term.value.trim(),
                      })),
                    }
                  : {}),
                ...(!locked('dnsNameReuseDelaySeconds')
                  ? { dnsNameReuseDelaySeconds: Number(data.get('reuse')) }
                  : {}),
              },
            });
            await onSaved();
          }}
        >
          <div className="domain-terms">
            {terms.map((term, index) => (
              <div className="domain-term" key={term.key}>
                <Input
                  label={t('connection.term')}
                  required
                  value={term.value}
                  disabled={locked('dnsBlockedTerms')}
                  onChange={(event) =>
                    setTerms((current) =>
                      current.map((entry, i) =>
                        i === index ? { ...entry, value: event.target.value } : entry,
                      ),
                    )
                  }
                />
                <Select
                  label={t('connection.match')}
                  value={term.match}
                  disabled={locked('dnsBlockedTerms')}
                  onChange={(event) =>
                    setTerms((current) =>
                      current.map((entry, i) =>
                        i === index
                          ? { ...entry, match: event.target.value as Term['match'] }
                          : entry,
                      ),
                    )
                  }
                >
                  {(['exact', 'word', 'substring'] as const).map((match) => (
                    <option key={match} value={match}>
                      {t(`connection.match.${match}`)}
                    </option>
                  ))}
                </Select>
                <button
                  type="button"
                  className="secondary"
                  aria-label={t('web.remove')}
                  disabled={locked('dnsBlockedTerms')}
                  onClick={() => setTerms((current) => current.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="secondary"
            disabled={locked('dnsBlockedTerms')}
            onClick={() =>
              setTerms((current) => [
                ...current,
                { value: '', match: 'exact', key: crypto.randomUUID() },
              ])
            }
          >
            {t('connection.addTerm')}
          </button>
          <Input
            label={t('connection.reuseDelay')}
            name="reuse"
            type="number"
            min={0}
            step={1}
            required
            disabled={locked('dnsNameReuseDelaySeconds')}
            defaultValue={Number(values.dnsNameReuseDelaySeconds ?? 0)}
          />
        </ActionForm>
      </details>
    </fieldset>
  );
}
export function IntegrationConnectionSettings({
  gameId,
  shared = false,
}: {
  gameId: string;
  shared?: boolean;
}) {
  const t = useT();
  const settings = useQuery({
    queryKey: ['owner-settings'],
    queryFn: () => api<Settings>('/v1/owner/settings'),
  });
  return (
    <details>
      <summary>{t('connection.domains')}</summary>
      {settings.isPending ? (
        <Loading />
      ) : settings.error ? (
        <ErrorNotice error={settings.error} />
      ) : (
        <IntegrationDomainForm
          key={JSON.stringify(settings.data.config.values.dnsGamePolicies)}
          gameId={gameId}
          shared={shared}
          settings={settings.data}
          onSaved={() => settings.refetch()}
        />
      )}
    </details>
  );
}
function IntegrationDomainForm({
  gameId,
  shared,
  settings,
  onSaved,
}: {
  gameId: string;
  shared: boolean;
  settings: Settings;
  onSaved: () => Promise<unknown>;
}) {
  const t = useT();
  const session = useSession();
  const values = settings.config.values;
  const all = (values.dnsGamePolicies ?? {}) as Record<string, Policy>;
  const [policy, setPolicy] = useState<Policy>(all[gameId] ?? { selection: 'all', domainIds: [] });
  const domains = configuredDomains(values);
  const eligible = domains.filter(
    (entry) =>
      entry.enabled &&
      (policy.selection === 'all' ||
        (policy.selection === 'allow'
          ? policy.domainIds.includes(entry.id)
          : !policy.domainIds.includes(entry.id))),
  );
  return (
    <fieldset
      disabled={
        settings.config.lockedKeys.includes('dnsGamePolicies') ||
        session.data?.context.role !== 'owner' ||
        session.data?.context.sessionType !== 'regular'
      }
    >
      <ActionForm
        onSubmit={async () => {
          await api('/v1/owner/settings', {
            method: 'PATCH',
            body: { dnsGamePolicies: { ...all, [gameId]: policy } },
          });
          await onSaved();
        }}
      >
        <Select
          label={t('connection.domainPolicy')}
          value={policy.selection}
          onChange={(event) =>
            setPolicy({
              ...policy,
              selection: event.target.value as Policy['selection'],
              defaultDomainId: undefined,
            })
          }
        >
          {(['all', 'allow', 'deny'] as const).map((mode) => (
            <option value={mode} key={mode}>
              {t(`connection.policy.${mode}`)}
            </option>
          ))}
        </Select>
        {policy.selection !== 'all' && (
          <div className="domain-picks">
            {domains.map((entry) => (
              <button
                type="button"
                className="secondary"
                aria-pressed={policy.domainIds.includes(entry.id)}
                key={entry.id}
                onClick={() =>
                  setPolicy({
                    ...policy,
                    defaultDomainId: undefined,
                    domainIds: policy.domainIds.includes(entry.id)
                      ? policy.domainIds.filter((id) => id !== entry.id)
                      : [...policy.domainIds, entry.id],
                  })
                }
              >
                {entry.hostname}
              </button>
            ))}
          </div>
        )}
        <Select
          label={t('connection.defaultDomain')}
          value={policy.defaultDomainId ?? ''}
          onChange={(event) =>
            setPolicy({ ...policy, defaultDomainId: event.target.value || undefined })
          }
        >
          <option value="">{t('connection.inherit')}</option>
          {eligible.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.hostname}
            </option>
          ))}
        </Select>
        {shared && (
          <Input
            label={t('connection.sharedLabel')}
            value={policy.sharedLabel ?? ''}
            maxLength={63}
            onChange={(event) =>
              setPolicy({ ...policy, sharedLabel: event.target.value || undefined })
            }
          />
        )}
      </ActionForm>
    </fieldset>
  );
}
