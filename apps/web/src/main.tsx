import { QueryClientProvider } from '@tanstack/react-query';
import { type ComponentType, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createBrowserRouter,
  createRoutesFromElements,
  Link,
  matchRoutes,
  Navigate,
  Route,
  RouterProvider,
  useParams,
  useRouteError,
} from 'react-router';
import { queryClient } from './api/client.js';
import { LocaleProvider, useT } from './app/i18n.js';
import { ErrorNotice, Loading, Page } from './components/ui.js';
import './app/style.css';

const auth = () => import('./features/auth.js');
const shell = () => import('./app/shell.js');
const workspace = () => import('./app/server-shell.js');
const home = () => import('./features/servers.js');
const servers = () => import('./features/server-browser.js');
const projects = () => import('./features/projects.js');
const activity = () => import('./features/activity.js');
const account = () => import('./features/account.js');
const automation = () => import('./features/automation.js');
const infrastructure = () => import('./features/owner-infrastructure.js');
const integrations = () => import('./features/owner-integrations.js');
const users = () => import('./features/owner-users.js');

function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return async () => ({ Component: (await load())[name] });
}
function serverPage<K extends string>(
  load: () => Promise<Record<K, ComponentType<{ serverId: string }>>>,
  name: K,
) {
  return async () => {
    const Component: ComponentType<{ serverId: string }> = (await load())[name];
    function ServerPage() {
      const { serverId = '' } = useParams();
      return <Component serverId={serverId} />;
    }
    return { Component: ServerPage };
  };
}
function recovery(mode: 'request' | 'reset' | 'verify' | 'link') {
  return async () => {
    const { Recovery } = await auth();
    return { Component: () => <Recovery mode={mode} /> };
  };
}
function RouteError() {
  return <ErrorNotice error={useRouteError()} retry={() => window.location.reload()} />;
}

function NotFound() {
  const t = useT();
  return (
    <Page title={t('web.errors.notFound')}>
      <Link to="/">{t('web.home')}</Link>
    </Page>
  );
}

// Keep one route tree; the data router enables draft-safe SPA navigation blocking.
const routes = createRoutesFromElements(
  <Route HydrateFallback={Loading} ErrorBoundary={RouteError}>
    <Route path="/login" lazy={page(auth, 'Login')} />
    <Route path="/invite/:token" lazy={page(auth, 'Invite')} />
    <Route path="/setup" lazy={page(auth, 'Setup')} />
    <Route path="/recover" lazy={recovery('request')} />
    <Route path="/reset-password" lazy={recovery('reset')} />
    <Route path="/verify" lazy={recovery('verify')} />
    <Route path="/account/link-email" lazy={recovery('link')} />
    <Route path="/auth/callback" lazy={page(shell, 'AuthCallback')} />
    <Route lazy={page(shell, 'Shell')}>
      <Route index lazy={page(home, 'HomePage')} />
      <Route path="/servers" lazy={page(servers, 'ServersPage')} />
      <Route
        path="/servers/new"
        lazy={page(() => import('./features/create-server.js'), 'CreateServerPage')}
      />
      <Route path="/projects" lazy={page(projects, 'ProjectsPage')} />
      <Route path="/projects/:projectId" lazy={page(projects, 'ProjectPage')} />
      <Route path="/activity" lazy={page(activity, 'ActivityPage')} />
      <Route path="/activity/:jobId" lazy={page(activity, 'JobPage')} />
      <Route path="/settings" lazy={page(account, 'AccountPage')}>
        <Route index lazy={page(account, 'AccountProfile')} />
        <Route path="security" lazy={page(account, 'AccountSecurity')} />
      </Route>
      <Route
        id="server-workspace"
        path="/servers/:serverId"
        lazy={async () => {
          const { ServerShell, workspaceHandle } = await workspace();
          return { Component: ServerShell, handle: workspaceHandle };
        }}
      >
        <Route index lazy={page(workspace, 'ServerIndex')} />
        <Route path="status" lazy={serverPage(home, 'ServerOverview')} />
        <Route
          path="console"
          lazy={serverPage(() => import('./features/console.js'), 'ConsolePage')}
        />
        <Route path="files" lazy={serverPage(() => import('./features/files.js'), 'FilesPage')} />
        <Route path="sftp" element={<Navigate to="../files?sftp=open" replace />} />
        <Route
          path="backups"
          lazy={serverPage(() => import('./features/backups-sftp.js'), 'BackupsPage')}
        />
        <Route
          path="network"
          lazy={serverPage(() => import('./features/network.js'), 'NetworkPage')}
        />
        <Route path="schedules" element={<Navigate to="../automation" replace />} />
        <Route path="automation" lazy={serverPage(automation, 'AutomationPage')} />
        <Route path="automation/sleep" element={<Navigate to="../settings/sleep" replace />} />
        <Route
          path="automation/messages"
          element={<Navigate to="../settings/messages" replace />}
        />
        <Route path="activity" lazy={serverPage(activity, 'ActivityPage')} />
        <Route
          path="settings"
          lazy={serverPage(() => import('./features/server-settings.js'), 'ServerSettings')}
        />
        <Route path="settings/sleep" lazy={serverPage(automation, 'AutomationPage')} />
        <Route path="settings/messages" lazy={serverPage(automation, 'AutomationPage')} />
        <Route
          path="subusers"
          lazy={serverPage(() => import('./features/subusers.js'), 'ServerSubusers')}
        />
        <Route path="game" lazy={page(workspace, 'ServerGameSection')} />
        <Route path="game/:sectionId/*" lazy={page(workspace, 'ServerGameSection')} />
      </Route>
      <Route path="/owner" lazy={page(infrastructure, 'OwnerHealthPage')} />
      <Route path="/owner/users" lazy={page(users, 'OwnerUsersPage')} />
      <Route path="/owner/users/:userId" lazy={page(users, 'OwnerUserPage')} />
      <Route path="/owner/invitations" lazy={page(users, 'InvitationsPage')} />
      <Route path="/owner/servers" lazy={page(servers, 'ServersPage')} />
      <Route path="/owner/infrastructure" lazy={page(infrastructure, 'OwnerInfrastructurePage')} />
      <Route path="/owner/integrations" lazy={page(integrations, 'OwnerIntegrationsPage')} />
      <Route path="/owner/integrations/:gameId/*" lazy={page(integrations, 'OwnerGameAdmin')} />
      <Route
        path="/owner/operations"
        lazy={page(() => import('./features/owner-operations.js'), 'OwnerOperationsPage')}
      />
      <Route path="/owner/audit" lazy={page(users, 'OwnerAuditPage')} />
      <Route
        path="/owner/settings"
        lazy={page(() => import('./features/owner-settings.js'), 'OwnerSettingsPage')}
      />
      <Route path="*" element={<NotFound />} />
    </Route>
  </Route>,
);

const router = createBrowserRouter(routes);

const prefetched = new WeakSet<() => Promise<unknown>>();

// Warm code and styles only for the local destination the user is pointing to or
// focusing. Data requests retain their normal authorization and navigation lifecycle.
function prefetchDestination(event: PointerEvent | FocusEvent) {
  if (event instanceof PointerEvent && event.pointerType !== 'mouse') return;
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest('a[href]');
  if (
    !(link instanceof HTMLAnchorElement) ||
    link.hasAttribute('download') ||
    (link.target && link.target !== '_self')
  )
    return;
  if (link.origin !== location.origin || link.pathname === location.pathname) return;
  for (const match of matchRoutes(routes, link.pathname) ?? []) {
    const lazy = match.route.lazy;
    if (typeof lazy === 'function' && !prefetched.has(lazy)) {
      prefetched.add(lazy);
      void lazy().catch(() => prefetched.delete(lazy));
    }
  }
}
document.addEventListener('pointerover', prefetchDestination);
document.addEventListener('focusin', prefetchDestination);

const root = document.getElementById('root');
if (!root) throw new Error('application_root_missing');
createRoot(root).render(
  <StrictMode>
    <LocaleProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </LocaleProvider>
  </StrictMode>,
);
