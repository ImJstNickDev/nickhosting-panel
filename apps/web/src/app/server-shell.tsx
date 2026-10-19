import { useEffect, useRef } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useMatch, useParams } from 'react-router';
import { ApiError } from '../api/client.js';
import { ErrorNotice, Loading } from '../components/ui.js';
import { GameSections } from '../features/game-sections.js';
import {
  availableGameSections,
  gameUiRegistry,
  getGameSectionView,
} from '../features/integrations.js';
import { ProvisioningHistory } from '../features/provisioning.js';
import { useServer } from '../features/service-contracts.js';
import './server-game.css';
import { useT } from './i18n.js';

function accessLost(error: unknown) {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

export function ServerShell() {
  const location = useLocation(),
    tabsElement = useRef<HTMLElement>(null);
  const gameRoute = useMatch('/servers/:serverId/game/:sectionId');
  const statusRoute = useMatch('/servers/:serverId/status');
  const { serverId = '' } = useParams(),
    t = useT(),
    server = useServer(serverId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reveal the active tab after route or loaded server changes.
  useEffect(() => {
    const active = tabsElement.current?.querySelector<HTMLAnchorElement>('[aria-current="page"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [location.pathname, server.data?.id]);
  if (server.isPending) return <Loading />;
  const renderer =
    server.data && gameRoute
      ? gameUiRegistry
          .get(server.data.gameId)
          ?.descriptor.sections.find(
            (section) =>
              section.id === gameRoute.params.sectionId ||
              section.aliases.includes(gameRoute.params.sectionId ?? ''),
          )?.renderer
      : undefined;
  // A transient background failure must not discard a custom view's request
  // receipt. Its section boundary shows the error and blocks mutations.
  if (server.error && (!server.data || !getGameSectionView(renderer) || accessLost(server.error)))
    return <ErrorNotice error={server.error} retry={() => void server.refetch()} />;

  const value = server.data,
    base = `/servers/${serverId}`;
  const tabs: string[][] = [
    ...(value.capabilities?.console || value.permissions.operate
      ? [['console', 'web.console']]
      : []),
    ...(value.capabilities?.files
      ? [
          ['files', 'web.files'],
          ['sftp', 'SFTP'],
        ]
      : []),
    ...(value.capabilities?.backups ? [['backups', 'web.backups']] : []),
    ['network', 'web.network'],
    ['automation', 'web.automation'],
    ['activity', 'web.activity'],
    ...(value.permissions.manage ? [['settings', 'web.settings']] : []),
  ];
  const game = gameUiRegistry.get(value.gameId);
  const gameSections = availableGameSections(value);
  return (
    <>
      <nav
        ref={tabsElement}
        className="tabs"
        aria-label={t('web.servers')}
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLAnchorElement)
            event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }}
      >
        {tabs.map(([slug, key]) => (
          <NavLink key={slug} to={`${base}/${slug}`} end={slug !== 'automation'}>
            {key === 'SFTP' ? key : t(key ?? '')}
          </NavLink>
        ))}
        {game && Boolean(gameSections?.length) && (
          <NavLink to={`${base}/game`}>{t(game.descriptor.nameKey)}</NavLink>
        )}
        <NavLink to={`${base}/status`} end>
          {t('web.serverStatus')}
        </NavLink>
      </nav>
      <Outlet />
      {statusRoute && (
        <ProvisioningHistory serverId={serverId} operationId={value.activeOperationId} />
      )}
    </>
  );
}
export function ServerGameSection() {
  const { serverId = '', sectionId = '' } = useParams(),
    location = useLocation(),
    server = useServer(serverId),
    t = useT();
  if (server.isPending) return <Loading />;
  const renderer =
    server.data &&
    gameUiRegistry
      .get(server.data.gameId)
      ?.descriptor.sections.find(
        (section) => section.id === sectionId || section.aliases.includes(sectionId),
      )?.renderer;
  if (server.error && (!server.data || !getGameSectionView(renderer) || accessLost(server.error)))
    return <ErrorNotice error={server.error} retry={() => void server.refetch()} />;

  const game = gameUiRegistry.get(server.data.gameId);
  const sections = availableGameSections(server.data);
  if (!sectionId && sections?.[0]) return <Navigate to={sections[0].id} replace />;
  const canonical = sections.find((section) => section.aliases.includes(sectionId));
  if (canonical)
    return (
      <Navigate
        to={{
          pathname: `/servers/${serverId}/game/${canonical.id}`,
          search: location.search,
          hash: location.hash,
        }}
        replace
      />
    );
  return (
    <>
      {game && Boolean(sections?.length) && (
        <nav className="tabs game-section-tabs" aria-label={t(game.descriptor.nameKey)}>
          {sections?.map((section) => (
            <NavLink key={section.id} to={`/servers/${serverId}/game/${section.id}`} end>
              {t(section.titleKey)}
            </NavLink>
          ))}
        </nav>
      )}
      <GameSections
        key={`${serverId}:${sectionId}`}
        serverId={serverId}
        sectionId={sectionId}
        gameId={server.data.gameId}
      />
    </>
  );
}

export function ServerIndex() {
  const { serverId = '' } = useParams();
  const server = useServer(serverId);
  if (server.isPending) return <Loading />;
  if (server.error) return <ErrorNotice error={server.error} />;
  return (
    <Navigate
      to={
        server.data.capabilities?.console || server.data.permissions.operate ? 'console' : 'status'
      }
      replace
    />
  );
}
