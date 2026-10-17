import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router';
import { api } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import { ActionForm, ErrorNotice, Notice, Select, text } from '../components/ui.js';
import { ServerWakeAccessSettings, ServerWakeSettings } from './auto-wake-policy.js';
import { AutomationSwitch } from './automation-controls.js';
import { SchedulesSection } from './automation-schedules.js';
import { GatewayMessageEditor } from './gateway-message-editor.js';
import {
  PolicyHeading,
  ServerSleepAccessEditor,
  ServerSleepEditor,
} from './server-automation-controls.js';
import { platformPath, type SleepPolicy, serverPath, useServer } from './service-contracts.js';
import { readSleepAccess, readSleepTimeout } from './sleep-timeout.js';
import './automation.css';

export function AutomationPage({ serverId }: { serverId: string }) {
  const t = useT(),
    session = useSession(),
    server = useServer(serverId),
    location = useLocation();
  const editable =
    !!server.data?.permissions.manage && session.data?.context.sessionType === 'regular';
  const owner = session.data?.context.role === 'owner';
  const section = location.pathname.endsWith('/sleep')
    ? 'sleep'
    : location.pathname.endsWith('/messages')
      ? 'messages'
      : 'schedules';
  const base = `/servers/${encodeURIComponent(serverId)}/automation`;
  const tabs = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = tabs.current;
    const active = nav?.querySelector<HTMLElement>(`[data-section="${section}"]`);
    if (nav && active) {
      const bounds = nav.getBoundingClientRect(),
        item = active.getBoundingClientRect();
      if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right;
      else if (item.left < bounds.left) nav.scrollLeft -= bounds.left - item.left;
    }
  }, [section]);
  return (
    <div className="automation-page">
      <nav ref={tabs} className="automation-tabs" aria-label={t('web.automation')}>
        {(['schedules', 'sleep', 'messages'] as const)
          .filter(
            (tab) =>
              tab !== 'messages' ||
              (server.data?.connectionMode === 'gateway' &&
                server.data.capabilities?.gatewayMessages),
          )
          .map((tab) => (
            <Link
              key={tab}
              data-section={tab}
              to={tab === 'schedules' ? base : `${base}/${tab}`}
              aria-current={section === tab ? 'page' : undefined}
            >
              {t(`automation.tab.${tab}`)}
            </Link>
          ))}
      </nav>
      {section === 'schedules' ? (
        <SchedulesSection serverId={serverId} editable={editable} />
      ) : section === 'messages' ? (
        <GatewayMessageEditor serverId={serverId} />
      ) : (
        <SleepAndWake serverId={serverId} editable={editable} owner={owner} />
      )}
    </div>
  );
}
function SleepAndWake({
  serverId,
  editable,
  owner,
}: {
  serverId: string;
  editable: boolean;
  owner: boolean;
}) {
  const t = useT(),
    format = useFormat(),
    server = useServer(serverId);
  const policy = useQuery({
    queryKey: ['sleep-policy', serverId],
    queryFn: () => api<SleepPolicy>(`${platformPath(serverId)}/sleep-policy`),
    refetchInterval: 10000,
  });
  const savePolicy = useMutation({
    mutationFn: async (input: { body: unknown; headers?: Record<string, string> }) => {
      await api(`${serverPath(serverId)}/gateway`, { method: 'PUT', ...input });
      await policy.refetch();
    },
  });
  const consent = useQuery({
    queryKey: ['automation-consent', serverId],
    queryFn: () =>
      api<{ allowed: boolean; expectedIntent: string; grantBlockedReason: string | null }>(
        `${serverPath(serverId)}/automation-consent`,
      ),
    refetchInterval: 10000,
  });
  const data = policy.data;
  const sleep = data?.idleTimeout;
  if (!data)
    return policy.error ? (
      <ErrorNotice error={policy.error} />
    ) : (
      <div
        role="status"
        className="automation-skeleton"
        aria-busy="true"
        aria-label={t('web.loading')}
      />
    );
  return (
    <div className="sleep-wake-page">
      {policy.error && <ErrorNotice error={policy.error} />}
      <section className="sleep-wake-consent">
        <div className="sleep-wake-consent-copy">
          <h3>{t('automation.startPermission')}</h3>
          {consent.data && (
            <p>
              {t(
                consent.data.allowed
                  ? 'automation.startsAllowedHint'
                  : 'automation.startsPausedHint',
              )}
            </p>
          )}
        </div>
        {consent.error && <ErrorNotice error={consent.error} />}
        {consent.data && (
          <>
            <div className="automation-row">
              <span className="sleep-wake-status">
                {t(consent.data.allowed ? 'automation.startsAllowed' : 'automation.startsPaused')}
              </span>
              <AutomationSwitch
                label={t('automation.startPermission')}
                checked={consent.data.allowed}
                disabled={!editable || (!consent.data.allowed && !!consent.data.grantBlockedReason)}
                onChange={async (allowed) => {
                  await api(`${serverPath(serverId)}/automation-consent`, {
                    method: 'PUT',
                    body: { allowed, expectedIntent: consent.data?.expectedIntent },
                  });
                  await Promise.all([consent.refetch(), policy.refetch(), server.refetch()]);
                }}
              />
            </div>

            {consent.data.grantBlockedReason && (
              <Notice>{t(`service.consent.${consent.data.grantBlockedReason}`)}</Notice>
            )}
          </>
        )}
      </section>
      <div className="sleep-wake-settings">
        <section className="automation-policy sleep-wake-policy">
          {sleep ? (
            <PolicyHeading
              kind="sleep"
              title={t('automation.autoSleep')}
              value={
                sleep.effectiveSeconds === -1
                  ? t('sleepTiming.disabled')
                  : t('sleepTiming.minutes', {
                      minutes: format.number(sleep.effectiveSeconds / 60, 3),
                    })
              }
              source={sleep.source}
            />
          ) : (
            <h3>{t('automation.autoSleep')}</h3>
          )}
          <div className="sleep-wake-controls">
            {!data.policy ? (
              data.proposedPolicy && editable ? (
                <ActionForm
                  disabled={savePolicy.isPending}
                  submitLabel={t('service.configureSleep')}
                  onSubmit={async () => {
                    await savePolicy.mutateAsync({
                      body: data.proposedPolicy,
                      headers: { 'If-None-Match': '*' },
                    });
                  }}
                >
                  <p>{t('service.configureSleepDescription')}</p>
                </ActionForm>
              ) : (
                <Notice>
                  {t(
                    server.data?.connectionMode === 'direct'
                      ? 'service.directSleepUnavailable'
                      : 'service.sleepUnavailable',
                  )}
                </Notice>
              )
            ) : sleep ? (
              editable && (
                <ServerSleepEditor
                  disabled={savePolicy.isPending}
                  key={JSON.stringify([
                    sleep.overrideSeconds,
                    sleep.inheritedSeconds,
                    sleep.ownerBaselineSeconds,
                    owner ? null : sleep.userAccess,
                  ])}
                  sleep={sleep}
                  owner={owner}
                  onSubmit={async (form) => {
                    if (!data.policy) return;
                    const timeout = readSleepTimeout(form, 'idleMinutes');
                    const {
                      idleTimeoutSeconds: _seconds,
                      idleTimeoutInherited: _inherited,
                      ...existing
                    } = data.policy;
                    await savePolicy.mutateAsync({
                      body: {
                        ...existing,
                        idleTimeoutInherited: timeout === null,
                        idleTimeoutSeconds: timeout === null || timeout === -1 ? null : timeout,
                      },
                    });
                  }}
                />
              )
            ) : (
              <Notice>{t('sleepTiming.ownerControlled')}</Notice>
            )}
          </div>
        </section>
        <ServerWakeSettings serverId={serverId} editable={editable} owner={owner} />
      </div>
      {owner && editable && data.policy && (
        <details className="sleep-wake-admin">
          <summary>{t('automation.administration')}</summary>
          <div className="sleep-wake-admin-content">
            {data.policy && sleep && 'ownerUserAccessOverride' in sleep && (
              <section
                className="sleep-wake-admin-setting"
                aria-label={t('automation.sleepAccess')}
              >
                <h4>{t('automation.sleepAccess')}</h4>
                <ServerSleepAccessEditor
                  disabled={savePolicy.isPending}
                  key={JSON.stringify([sleep.ownerUserAccessOverride, sleep.inheritedUserAccess])}
                  sleep={sleep}
                  onSubmit={async (form) => {
                    if (!data.policy) return;
                    const {
                      idleTimeoutSeconds: _seconds,
                      idleTimeoutInherited: _inherited,
                      ...existing
                    } = data.policy;
                    await savePolicy.mutateAsync({
                      body: {
                        ...existing,
                        idleTimeoutUserAccess: readSleepAccess(form, 'sleepAccess'),
                      },
                    });
                  }}
                />
              </section>
            )}
            <ServerWakeAccessSettings serverId={serverId} />
            {data.policy && data.policyControlsEditable !== false && (
              <section
                className="sleep-wake-admin-setting sleep-wake-gateway"
                aria-label={t('automation.gatewayOperation')}
              >
                <h4>{t('automation.gatewayOperation')}</h4>
                <ActionForm
                  disabled={savePolicy.isPending}
                  key={`${data.policy.enabled}-${data.policy.mode}`}
                  onSubmit={async (form) => {
                    if (!data.policy) return;
                    const {
                      idleTimeoutSeconds: _seconds,
                      idleTimeoutInherited: _inherited,
                      ...existing
                    } = data.policy;
                    await savePolicy.mutateAsync({
                      body: {
                        ...existing,
                        enabled: form.get('enabled') === 'true',
                        mode: text(form, 'mode'),
                      },
                    });
                  }}
                >
                  <Select
                    label={t('automation.gatewayOperation')}
                    className="automation-label-hidden"
                    name="enabled"
                    defaultValue={String(data.policy.enabled)}
                  >
                    <option value="true">{t('web.enabled')}</option>
                    <option value="false">{t('web.disabled')}</option>
                  </Select>
                  <Select
                    label={t('service.automationMode')}
                    name="mode"
                    defaultValue={data.policy.mode}
                  >
                    <option value="auto">{t('service.automatic')}</option>
                    <option value="manually_stopped">{t('service.manuallyStopped')}</option>
                    <option value="maintenance">{t('service.maintenance')}</option>
                  </Select>
                </ActionForm>
              </section>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
