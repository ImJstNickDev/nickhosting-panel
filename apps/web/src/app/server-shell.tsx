import { Link, Navigate, Outlet, useLocation, useMatch, useParams } from 'react-router';
import { ApiError } from '../api/client.js';
import { ErrorNotice, Loading } from '../components/ui.js';
import { GameSections } from '../features/game-sections.js';
import { availableGameSections } from '../features/integrations.js';
import { ProvisioningHistory } from '../features/provisioning.js';
import { useServer } from '../features/service-contracts.js';
import { useT } from './i18n.js';
import './server-game.css';

function accessLost(error: unknown) {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

export function ServerShell() {
  const statusRoute = useMatch('/servers/:serverId/status');
  const { serverId = '' } = useParams();
  const server = useServer(serverId);
  const location = useLocation();
  const t = useT();
  if (server.isPending) return <Loading />;
  if (!server.data || (server.error && accessLost(server.error)))
    return <ErrorNotice error={server.error} retry={() => void server.refetch()} />;
  const base = `/servers/${serverId}`;
  const settingsSections = availableGameSections(server.data).filter(
    (s) => s.navigation?.placement === 'settings',
  );
  const settingsLinks = [
    ...(server.data.permissionKeys.includes('settings.read')
      ? [{ to: `${base}/settings`, label: t('serverSettings.general') }]
      : []),
    ...settingsSections.map((s) => ({ to: `${base}/game/${s.id}`, label: t(s.titleKey) })),
    ...(server.data.permissionKeys.includes('settings.read')
      ? [
          { to: `${base}/settings/sleep`, label: t('automation.tab.sleep') },
          ...(server.data.connectionMode === 'gateway' && server.data.capabilities?.gatewayMessages
            ? [{ to: `${base}/settings/messages`, label: t('automation.tab.messages') }]
            : []),
        ]
      : []),
  ];
  const inSettings =
    location.pathname.startsWith(`${base}/settings`) ||
    settingsLinks.some((link) => link.to === location.pathname);
  if (
    location.pathname === `${base}/settings` &&
    !server.data.permissionKeys.includes('settings.read') &&
    settingsLinks[0]
  )
    return <Navigate to={settingsLinks[0].to} replace />;
  return (
    <>
      {server.error && <ErrorNotice error={server.error} retry={() => void server.refetch()} />}
      {inSettings && (
        <nav className="settings-navigation" aria-label={t('web.settings')}>
          {settingsLinks.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              aria-current={location.pathname === link.to ? 'page' : undefined}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      )}
      <Outlet />
      {statusRoute && (
        <ProvisioningHistory serverId={serverId} operationId={server.data.activeOperationId} />
      )}
    </>
  );
}
export function ServerGameSection() {
  const { serverId = '', sectionId = '' } = useParams(),
    location = useLocation(),
    server = useServer(serverId);
  if (server.isPending) return <Loading />;
  if (server.error && (!server.data || accessLost(server.error)))
    return <ErrorNotice error={server.error} retry={() => void server.refetch()} />;

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
    <GameSections
      key={`${serverId}:${sectionId}`}
      serverId={serverId}
      sectionId={sectionId}
      gameId={server.data.gameId}
    />
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
        (server.data.capabilities?.console &&
          server.data.permissionKeys.includes('console.read')) ||
        server.data.permissionKeys.includes('console.power')
          ? 'console'
          : 'status'
      }
      replace
    />
  );
}
