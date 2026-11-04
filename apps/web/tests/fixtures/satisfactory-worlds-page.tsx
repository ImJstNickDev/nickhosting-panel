import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { NavigationGuardProvider } from '../../src/components/navigation-guard.js';
import { SatisfactoryOverviewSection } from '../../src/integrations/satisfactory/overview.js';
import { SatisfactoryWorldsSection } from '../../src/integrations/satisfactory/worlds.js';
import '../../src/app/style.css';

const Section = location.search.includes('overview')
  ? SatisfactoryOverviewSection
  : SatisfactoryWorldsSection;

function FixtureSection() {
  const [runtimeState, setRuntimeState] = useState(
    location.search.includes('offline') ? 'offline' : 'running',
  );
  useEffect(() => {
    const change = (event: Event) => setRuntimeState((event as CustomEvent<string>).detail);
    window.addEventListener('fixture-runtime', change);
    return () => window.removeEventListener('fixture-runtime', change);
  }, []);
  const [pending, setPending] = useState(location.search.includes('pending'));
  useEffect(() => {
    const change = (event: Event) => setPending((event as CustomEvent<boolean>).detail);
    window.addEventListener('fixture-pending', change);
    return () => window.removeEventListener('fixture-pending', change);
  }, []);
  return (
    <Section
      data={{ values: {}, rows: [] }}
      serverId="10000000-0000-4000-8000-000000000001"
      serverName="Satisfactory"
      runtimeState={runtimeState}
      canManage={!location.search.includes('readonly')}
      permissionKeys={['server:manage', 'console.power', 'files.read']}
      pending={pending}
      onAccepted={(jobId) => {
        document.body.dataset.job = jobId;
      }}
      reload={async () => {}}
    />
  );
}

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
                  <FixtureSection />
                </main>
              </NavigationGuardProvider>
            ),
          },
        ])}
      />
    </LocaleProvider>
  </QueryClientProvider>,
);
