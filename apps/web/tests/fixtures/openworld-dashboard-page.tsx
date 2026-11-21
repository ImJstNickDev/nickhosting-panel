import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { OpenworldDashboard } from '../../src/integrations/openworld/dashboard.js';
import '../../src/app/style.css';

const id = '10000000-0000-4000-8000-000000000001';
const owner = !location.search.includes('subuser');
function Fixture() {
  const [state, setState] = useState({
    enabled: !owner,
    canConfigure: owner,
    privateAddress: null as string | null,
  });
  return (
    <main>
      <OpenworldDashboard
        data={{ values: {}, rows: [], metadata: state }}
        serverId={id}
        serverName="Openworld"
        runtimeState="running"
        canManage={owner}
        permissionKeys={owner ? ['settings.read', 'settings.write'] : ['settings.read']}
        pending={false}
        onAccepted={() => {}}
        reload={async () => {
          setState(await api(`/v1/servers/${id}/openworld/dashboard`));
        }}
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
