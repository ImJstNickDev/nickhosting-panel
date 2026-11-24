import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { api, queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { OpenworldDashboard } from '../../src/integrations/openworld/dashboard.js';
import '../../src/app/style.css';

const id = '10000000-0000-4000-8000-000000000001';
const owner = !location.search.includes('subuser');
function Fixture() {
  const query = useQuery({
    queryKey: ['game-section', id, 'openworld', 'dashboard'],
    queryFn: async ({ signal }) => ({
      values: {},
      rows: [],
      metadata: await api<{
        enabled: boolean;
        canConfigure: boolean;
        canOpen: boolean;
        nativePrepared: boolean;
        phase: string;
        hostname: string | null;
      }>(`/v1/servers/${id}/openworld/dashboard`, { signal }),
    }),
  });
  if (!query.data) return null;
  return (
    <main>
      <OpenworldDashboard
        data={query.data}
        serverId={id}
        serverName="Openworld"
        runtimeState="running"
        canManage={owner}
        permissionKeys={
          owner ? ['settings.read', 'settings.write'] : ['game.openworld.dashboard.admin']
        }
        pending={false}
        onAccepted={() => {}}
        reload={() => query.refetch()}
      />
    </main>
  );
}
createRoot(document.getElementById('root') as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <LocaleProvider>
      <Fixture />
    </LocaleProvider>
  </QueryClientProvider>,
);
