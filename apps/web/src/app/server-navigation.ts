import type { SidebarIconName } from '../components/sidebar.js';
import { availableGameSections } from '../features/integrations.js';
import type { ServerInfo } from '../features/service-contracts.js';

type NavigationItem = {
  to: string;
  label: string;
  icon: SidebarIconName;
  group: string;
  active: boolean;
};
/** Permission-aware presentation only. Every operation is authorized by its API. */
export function serverNavigation(
  server: ServerInfo,
  pathname: string,
  t: (key: string) => string,
): NavigationItem[] {
  const base = `/servers/${server.id}`;
  const keys = (server as ServerInfo & { permissionKeys?: readonly string[] }).permissionKeys;
  const can = (permission: string, fallback = true) =>
    keys ? keys.includes(permission) : fallback;
  const sections = availableGameSections(server);
  const entries: {
    slug: string;
    label: string;
    icon: SidebarIconName;
    group: 'server' | 'tools' | 'config';
    order: number;
    active?: boolean;
  }[] = [];
  const add = (
    allowed: boolean,
    slug: string,
    label: string,
    icon: SidebarIconName,
    group: 'server' | 'tools' | 'config',
    order: number,
    active?: boolean,
  ) => {
    if (allowed) entries.push({ slug, label, icon, group, order, active });
  };
  add(
    true,
    (Boolean(server.capabilities?.console) && can('console.read')) ||
      can('console.power', server.permissions.operate)
      ? 'console'
      : 'status',
    'web.console',
    'console',
    'server',
    10,
    pathname === `${base}/console` || pathname === `${base}/status`,
  );
  add(
    Boolean(server.capabilities?.files) && can('files.read'),
    'files',
    'web.files',
    'files',
    'server',
    20,
  );
  add(can('activity.read'), 'activity', 'web.activity', 'activity', 'server', 30);
  add(
    Boolean(server.capabilities?.backups) && can('backups.read'),
    'backups',
    'web.backups',
    'backups',
    'tools',
    80,
  );
  add(can('schedules.read'), 'automation', 'serverNav.schedules', 'schedules', 'tools', 90);
  add(can('network.read'), 'network', 'serverNav.network', 'network', 'config', 10);
  add(
    can('settings.read', server.permissions.manage) ||
      sections.some((s) => s.navigation?.placement === 'settings'),
    'settings',
    'web.settings',
    'settings',
    'config',
    20,
    pathname.startsWith(`${base}/settings`) ||
      sections.some(
        (s) => s.navigation?.placement === 'settings' && pathname === `${base}/game/${s.id}`,
      ),
  );
  add(can('subusers.read', false), 'subusers', 'serverNav.subusers', 'users', 'config', 30);
  for (const section of sections) {
    const navigation = section.navigation;
    if (!navigation || navigation.placement === 'settings') continue;
    entries.push({
      slug: `game/${section.id}`,
      label: section.titleKey,
      icon: navigation.icon,
      group: navigation.group,
      order: navigation.order,
    });
  }
  return ['server', 'tools', 'config'].flatMap((group) =>
    entries
      .filter((e) => e.group === group)
      .sort((a, b) => a.order - b.order)
      .map((entry) => ({
        to: `${base}/${entry.slug}`,
        label: t(entry.label),
        icon: entry.icon,
        group: t(`serverNav.${group}`),
        active:
          entry.active ??
          (pathname === `${base}/${entry.slug}` || pathname.startsWith(`${base}/${entry.slug}/`)),
      })),
  );
}
