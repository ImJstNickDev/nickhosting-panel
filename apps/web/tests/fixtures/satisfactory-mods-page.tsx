import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { NavigationGuardProvider } from '../../src/components/navigation-guard.js';
import { SatisfactoryModsSection } from '../../src/integrations/satisfactory/mods.js';
import { SatisfactorySettingsSection } from '../../src/integrations/satisfactory/settings.js';
import '../../src/app/style.css';

const settings = location.search.includes('settings');
const Section = settings ? SatisfactorySettingsSection : SatisfactoryModsSection;

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <LocaleProvider>
      <RouterProvider
        router={createBrowserRouter([
          {
            path: '*',
            element: (
              <NavigationGuardProvider>
                <main style={{ padding: 24, maxWidth: 1000, margin: 'auto' }}>
                  <h1>Satisfactory</h1>
                  <Section
                    data={{ values: {}, rows: [] }}
                    serverId="10000000-0000-4000-8000-000000000001"
                    serverName="Satisfactory"
                    runtimeState={
                      (settings || location.search.includes('running')) &&
                      !location.search.includes('offline')
                        ? 'running'
                        : 'offline'
                    }
                    canManage={!location.search.includes('readonly')}
                    permissionKeys={['server:manage', 'console.power']}
                    pending={location.search.includes('pending')}
                    onAccepted={(jobId) => {
                      document.body.dataset.job = jobId;
                    }}
                    reload={async () => {}}
                  />
                </main>
              </NavigationGuardProvider>
            ),
          },
        ])}
      />
    </LocaleProvider>
  </QueryClientProvider>,
);
