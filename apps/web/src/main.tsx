import { QueryClientProvider } from '@tanstack/react-query';
import { type ComponentType, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes, useParams } from 'react-router';
import { queryClient } from './api/client.js';
import { LocaleProvider, useT } from './app/i18n.js';
import { ServerGameSection, ServerShell } from './app/server-shell.js';
import { AuthCallback, Shell } from './app/shell.js';
import { Page } from './components/ui.js';
import { AccountPage } from './features/account.js';
import { ActivityPage, JobPage } from './features/activity.js';
import { Invite, Login, Recovery, Setup } from './features/auth.js';
import { AutomationPage } from './features/automation.js';
import { BackupsPage, SftpPage } from './features/backups-sftp.js';
import { ConsolePage } from './features/console.js';
import { CreateServerPage } from './features/create-server.js';
import { FilesPage } from './features/files.js';
import { NetworkPage } from './features/network.js';
import { OwnerHealthPage, OwnerInfrastructurePage } from './features/owner-infrastructure.js';
import { OwnerGameAdmin, OwnerIntegrationsPage } from './features/owner-integrations.js';
import { OwnerOperationsPage } from './features/owner-operations.js';
import { OwnerSettingsPage } from './features/owner-settings.js';
import {
  InvitationsPage,
  OwnerAuditPage,
  OwnerUserPage,
  OwnerUsersPage,
} from './features/owner-users.js';
import { ProjectPage, ProjectsPage } from './features/projects.js';
import { HomePage, ServerOverview, ServerSettings, ServersPage } from './features/servers.js';
import './app/style.css';

function ServerPage({ component: Component }: { component: ComponentType<{ serverId: string }> }) {
  const { serverId = '' } = useParams();
  return <Component serverId={serverId} />;
}
function NotFound() {
  const t = useT();
  return (
    <Page title={t('web.errors.notFound')}>
      <Link to="/">{t('web.home')}</Link>
    </Page>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/invite/:token" element={<Invite />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/recover" element={<Recovery mode="request" />} />
            <Route path="/reset-password" element={<Recovery mode="reset" />} />
            <Route path="/verify" element={<Recovery mode="verify" />} />
            <Route path="/account/link-email" element={<Recovery mode="link" />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route element={<Shell />}>
              <Route index element={<HomePage />} />
              <Route path="/servers" element={<ServersPage />} />
              <Route path="/servers/new" element={<CreateServerPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:projectId" element={<ProjectPage />} />
              <Route path="/activity" element={<ActivityPage />} />
              <Route path="/activity/:jobId" element={<JobPage />} />
              <Route path="/settings" element={<AccountPage />} />
              <Route path="/servers/:serverId" element={<ServerShell />}>
                <Route index element={<ServerPage component={ServerOverview} />} />
                <Route path="console" element={<ServerPage component={ConsolePage} />} />
                <Route path="files" element={<ServerPage component={FilesPage} />} />
                <Route path="sftp" element={<ServerPage component={SftpPage} />} />
                <Route path="backups" element={<ServerPage component={BackupsPage} />} />
                <Route path="network" element={<ServerPage component={NetworkPage} />} />
                <Route path="automation" element={<ServerPage component={AutomationPage} />} />
                <Route path="activity" element={<ServerPage component={ActivityPage} />} />
                <Route path="settings" element={<ServerPage component={ServerSettings} />} />
                <Route path="game/:sectionId" element={<ServerGameSection />} />
              </Route>
              <Route path="/owner" element={<OwnerHealthPage />} />
              <Route path="/owner/users" element={<OwnerUsersPage />} />
              <Route path="/owner/users/:userId" element={<OwnerUserPage />} />
              <Route path="/owner/invitations" element={<InvitationsPage />} />
              <Route path="/owner/servers" element={<ServersPage />} />
              <Route path="/owner/infrastructure" element={<OwnerInfrastructurePage />} />
              <Route path="/owner/integrations" element={<OwnerIntegrationsPage />} />
              <Route path="/owner/integrations/:gameId" element={<OwnerGameAdmin />} />
              <Route path="/owner/operations" element={<OwnerOperationsPage />} />
              <Route path="/owner/audit" element={<OwnerAuditPage />} />
              <Route path="/owner/settings" element={<OwnerSettingsPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </LocaleProvider>
  </StrictMode>,
);
