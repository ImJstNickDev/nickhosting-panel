import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { NavigationGuardProvider } from '../../src/components/navigation-guard.js';
import { AutomationPage } from '../../src/features/automation.js';
import { BackupsPage } from '../../src/features/backups-sftp.js';
import '../../src/app/style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <LocaleProvider>
      <RouterProvider
        router={createMemoryRouter([
          {
            path: '*',
            element: (
              <NavigationGuardProvider>
                <main style={{ padding: '24px', maxWidth: 1100, margin: 'auto' }}>
                  <h1>Fixture server</h1>
                  {new URLSearchParams(window.location.search).get('page') === 'automation' ? (
                    <AutomationPage serverId="backup-fixture" />
                  ) : (
                    <BackupsPage serverId="backup-fixture" />
                  )}
                </main>
              </NavigationGuardProvider>
            ),
          },
        ])}
      />
    </LocaleProvider>
  </QueryClientProvider>,
);
