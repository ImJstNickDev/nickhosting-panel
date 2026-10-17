import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router';
import { api } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import { ActionForm, ErrorNotice, Notice, Select, text } from '../components/ui.js';
import { ServerWakeSettings } from './auto-wake-policy.js';
import { AutomationSwitch } from './automation-controls.js';
import { SchedulesSection } from './automation-schedules.js';
import { GatewayMessageEditor } from './gateway-message-editor.js';
import { PolicyHeading, ServerSleepEditor } from './server-automation-controls.js';
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
                  submitLabel={t('service.configureSleep')}
                  onSubmit={async () => {
                    await api(`${serverPath(serverId)}/gateway`, {
                      method: 'PUT',
                      body: data.proposedPolicy,
                      headers: { 'If-None-Match': '*' },
                    });
                    await policy.refetch();
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
                  key={JSON.stringify(sleep)}
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
                    await api(`${serverPath(serverId)}/gateway`, {
                      method: 'PUT',
                      body: {
                        ...existing,
                        idleTimeoutInherited: timeout === null,
                        idleTimeoutSeconds: timeout === null || timeout === -1 ? null : timeout,
                        ...(owner
                          ? { idleTimeoutUserAccess: readSleepAccess(form, 'sleepAccess') }
                          : {}),
                      },
                    });
                    await policy.refetch();
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
      {data.policy && editable && data.policyControlsEditable !== false && (
        <details className="automation-policy automation-advanced sleep-wake-advanced">
          <summary>{t('automation.gatewayOperation')}</summary>
          <ActionForm
            key={`${data.policy.enabled}-${data.policy.mode}`}
            onSubmit={async (form) => {
              await api(`${serverPath(serverId)}/gateway`, {
                method: 'PUT',
                body: {
                  ...data.policy,
                  enabled: form.get('enabled') === 'true',
                  mode: text(form, 'mode'),
                },
              });
              await policy.refetch();
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
            <Select label={t('service.automationMode')} name="mode" defaultValue={data.policy.mode}>
              <option value="auto">{t('service.automatic')}</option>
              <option value="manually_stopped">{t('service.manuallyStopped')}</option>
              <option value="maintenance">{t('service.maintenance')}</option>
            </Select>
          </ActionForm>
        </details>
      )}
    </div>
  );
}
