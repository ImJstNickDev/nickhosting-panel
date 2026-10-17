import { useQuery } from '@tanstack/react-query';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import type { GameManifest } from '../../../../packages/game-sdk/src/index.js';
import type { listPlatformGames } from '../../../../packages/server-management/src/platform-queries.js';
import { api, queryClient } from '../api/client.js';
import type { Result } from '../api/contracts.js';
import { useT } from '../app/i18n.js';
import {
  ActionForm,
  Badge,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  Page,
  Section,
  Select,
  Textarea,
  text,
} from '../components/ui.js';
import { IntegrationWakeSettings } from './auto-wake-policy.js';
import { IntegrationContentPolicy } from './integration-content-policy.js';
import { IntegrationRuntimeMappings } from './integration-runtime-mappings.js';
import { getGameAdminSections, getGameArtwork, getGameConnectionAdmin } from './integrations.js';
import { IntegrationConnectionSettings } from './owner-domains.js';
import { IntegrationSleepSettings } from './sleep-timeout.js';
import './owner-integrations.css';

type Module = { id: string; manifest: GameManifest };
const moduleQuery = {
  queryKey: ['owner-game-modules'],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api<Module[]>('/v1/owner/game-modules', { signal }),
  staleTime: 60_000,
};
const gamesQuery = {
  queryKey: ['owner-games'],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api<Result<typeof listPlatformGames>>('/v1/platform/owner/games', { signal }),
  staleTime: 30_000,
};
export function OwnerIntegrationsPage() {
  const t = useT(),
    games = useQuery(gamesQuery),
    modules = useQuery(moduleQuery);
  return (
    <Page title={t('web.integrations')}>
      {games.isPending || modules.isPending ? (
        <Loading />
      ) : games.error || modules.error ? (
        <ErrorNotice
          error={games.error ?? modules.error}
          retry={() => {
            void games.refetch();
            void modules.refetch();
          }}
        />
      ) : !modules.data.length ? (
        <Empty />
      ) : (
        <div className="owner-integration-list">
          {modules.data.map((module) => {
            const stored = games.data.find((game) => game.id === module.id),
              art = getGameArtwork(module.id);
            return (
              <Link
                key={module.id}
                className="owner-integration-card"
                to={`/owner/integrations/${encodeURIComponent(module.id)}`}
              >
                {art && <img src={art} alt="" />}
                <span className="owner-integration-card-copy">
                  <strong>{t(module.manifest.nameKey)}</strong>
                  <Badge
                    value={stored?.state ?? 'development'}
                    label={t(`owner.rollout.${stored?.state ?? 'development'}`)}
                  />
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </Page>
  );
}

export function OwnerGameAdmin() {
  const { gameId = '', '*': route = '' } = useParams(),
    t = useT();
  const modules = useQuery(moduleQuery);
  if (modules.isPending)
    return (
      <Page title={t('web.integrations')}>
        <Loading />
      </Page>
    );
  if (modules.error)
    return (
      <Page title={t('web.integrations')}>
        <ErrorNotice error={modules.error} retry={() => void modules.refetch()} />
      </Page>
    );
  const module = modules.data.find((item) => item.id === gameId);
  return module ? (
    <IntegrationWorkspace key={gameId} module={module} section={route || 'general'} />
  ) : (
    <Page title={t('web.integrations')}>
      <Notice>{t('web.errors.notFound')}</Notice>
    </Page>
  );
}
function IntegrationWorkspace({ module, section }: { module: Module; section: string }) {
  const t = useT(),
    location = useLocation();
  const gameId = module.id,
    base = `/owner/integrations/${encodeURIComponent(gameId)}`;
  const contributed = useMemo(() => getGameAdminSections(gameId), [gameId]),
    Connection = getGameConnectionAdmin(gameId);
  const [visited, setVisited] = useState<string[]>([]);
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    Array.from(navigation.current?.querySelectorAll<HTMLAnchorElement>('a[data-section]') ?? [])
      .find((item) => item.dataset.section === section)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [section]);
  useEffect(() => {
    if (contributed.some((item) => item.id === section))
      setVisited((current) => (current.includes(section) ? current : [...current, section]));
  }, [section, contributed]);
  const tabs = [
    { id: 'general', titleKey: 'ownerIntegration.general' },
    { id: 'runtime', titleKey: 'ownerIntegration.runtime' },
    ...contributed,
    ...(module.manifest.connection.mode !== 'static-host-port' || Connection
      ? [{ id: 'connection', titleKey: 'ownerIntegration.connection' }]
      : []),
    ...(module.manifest.capabilities.wake !== 'unsupported'
      ? [{ id: 'sleep', titleKey: 'ownerIntegration.sleep' }]
      : []),
    { id: 'content', titleKey: 'ownerIntegration.content' },
  ];
  const active = contributed.find((item) => item.id === section);
  if (!tabs.some((tab) => tab.id === section)) return <Navigate to={base} replace />;
  return (
    <Page
      title={t(module.manifest.nameKey)}
      actions={<Link to="/owner/integrations">{t('web.integrations')}</Link>}
    >
      <nav
        ref={navigation}
        className="tabs owner-integration-tabs"
        aria-label={t('ownerIntegration.navigation')}
      >
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            data-section={tab.id}
            to={{ pathname: `${base}/${tab.id}`, search: location.search }}
            className={section === tab.id ? 'active' : ''}
            aria-current={section === tab.id ? 'page' : undefined}
          >
            {t(tab.titleKey)}
          </Link>
        ))}
      </nav>
      <div className="owner-integration-body">
        {section === 'general' && <IntegrationGeneral module={module} />}
        {section === 'runtime' && (
          <IntegrationRuntimeMappings gameId={gameId} manifest={module.manifest} />
        )}
        {section === 'connection' && (
          <div className="stack">
            <Section
              title={t('ownerIntegration.connection')}
              actions={<Link to="/owner/settings#dns">{t('ownerIntegration.globalSettings')}</Link>}
            >
              <IntegrationConnectionSettings
                gameId={gameId}
                shared={module.manifest.connection.mode === 'shared-host'}
                embedded
              />
            </Section>
            {Connection && <Connection />}
          </div>
        )}
        {section === 'sleep' && (
          <Section
            title={t('ownerIntegration.sleep')}
            actions={<Link to="/owner/settings#sleep">{t('ownerIntegration.globalSettings')}</Link>}
          >
            <IntegrationWakeSettings
              gameId={gameId}
              initialRuntimeId={new URLSearchParams(location.search).get('runtime') ?? undefined}
            />
            <IntegrationSleepSettings
              gameId={gameId}
              initialRuntimeId={new URLSearchParams(location.search).get('runtime') ?? undefined}
              embedded
            />
          </Section>
        )}
        {section === 'content' && <IntegrationContentPolicy gameId={gameId} />}
        {active && (
          <Suspense fallback={<Loading />}>
            <active.Component />
          </Suspense>
        )}
        {contributed
          .filter((item) => visited.includes(item.id) || item.id === section)
          .map((item) => (
            <div key={item.id} hidden={item.id !== section}>
              <Suspense fallback={<Loading />}>
                <item.Background />
              </Suspense>
            </div>
          ))}
      </div>
    </Page>
  );
}
function IntegrationGeneral({ module }: { module: Module }) {
  const t = useT(),
    games = useQuery(gamesQuery),
    stored = games.data?.find((game) => game.id === module.id);
  return (
    <Section title={t('ownerIntegration.general')}>
      {games.isPending ? (
        <Loading />
      ) : games.error ? (
        <ErrorNotice error={games.error} retry={() => void games.refetch()} />
      ) : (
        <ActionForm
          onSubmit={async (data) => {
            await api('/v1/owner/games', {
              method: 'PUT',
              body: {
                manifest: module.manifest,
                rollout: {
                  gameId: module.id,
                  state: text(data, 'state'),
                  allowedUserIds: text(data, 'allowlist').split(/\s+/).filter(Boolean),
                },
              },
            });
            await queryClient.invalidateQueries({ queryKey: ['owner-games'] });
          }}
        >
          <Select
            label={t('owner.rollout')}
            name="state"
            defaultValue={stored?.state ?? 'development'}
          >
            {['development', 'private-testing', 'public', 'disabled-for-new-servers'].map(
              (state) => (
                <option key={state} value={state}>
                  {t(`owner.rollout.${state}`)}
                </option>
              ),
            )}
          </Select>
          <Textarea
            label={t('owner.testerAllowlist')}
            name="allowlist"
            defaultValue={stored?.allowlist?.join('\n') ?? ''}
          />
        </ActionForm>
      )}
    </Section>
  );
}
