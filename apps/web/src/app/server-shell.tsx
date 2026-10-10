import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation, useParams } from 'react-router';
import { ErrorNotice, Loading, Page } from '../components/ui.js';
import { GameSections } from '../features/game-sections.js';
import { gameUiRegistry } from '../features/integrations.js';
import { useServer } from '../features/service-contracts.js';
import { useT } from './i18n.js';

export function ServerShell() {
  const location = useLocation(),
    tabsElement = useRef<HTMLElement>(null);
  const { serverId = '' } = useParams(),
    t = useT(),
    server = useServer(serverId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reveal the active tab after route or loaded server changes.
  useEffect(() => {
    tabsElement.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [location.pathname, server.data?.id]);
  if (server.isPending) return <Loading />;
  if (server.error) return <ErrorNotice error={server.error} />;
  const value = server.data,
    base = `/servers/${serverId}`;
  const tabs = [
    ['', 'web.overview'],
    ...(value.capabilities?.console ? [['console', 'web.console']] : []),
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
  return (
    <Page title={value.name}>
      <nav ref={tabsElement} className="tabs" aria-label={t('web.servers')}>
        {tabs.map(([slug, key]) => (
          <NavLink key={slug} to={`${base}/${slug}`} end>
            {key === 'SFTP' ? key : t(key!)}
          </NavLink>
        ))}
        {game?.descriptor.sections.map((section) => (
          <NavLink key={section.id} to={`${base}/game/${section.id}`}>
            {t(section.titleKey)}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </Page>
  );
}
export function ServerGameSection() {
  const { serverId = '', sectionId = '' } = useParams(),
    server = useServer(serverId);
  if (server.isPending) return <Loading />;
  if (server.error) return <ErrorNotice error={server.error} />;
  return <GameSections serverId={serverId} sectionId={sectionId} gameId={server.data.gameId} />;
}
