import { QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { gameUiRegistry, getGameSectionView } from '../../src/features/integrations.js';
import '../../src/app/style.css';

const params = new URLSearchParams(location.search);
const section = gameUiRegistry.get('openworld')?.descriptor.sections.find((s) => s.id === 'rules');
const View = getGameSectionView(section?.renderer);
if (!View) throw Error('Missing rules section');
const permissions = params.has('restricted') ? [] : ['game.openworld.rules.view'];
if (params.has('manage')) permissions.push('game.openworld.rules.manage');
if (params.has('territory')) permissions.push('game.openworld.territory.manage');
if (params.has('groups')) permissions.push('game.openworld.roles.manage');
if (params.has('map')) permissions.push('game.openworld.map.read');
if (params.has('consoleRead')) permissions.push('console.read');
if (params.has('consoleCommand')) permissions.push('console.command');
createRoot(document.getElementById('root') as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <LocaleProvider>
        <main style={{ margin: '20px auto', maxWidth: 960, padding: '0 12px' }}>
          <Suspense>
            <View
              serverId="10000000-0000-4000-8000-000000000001"
              serverName="North Coast"
              data={{ values: {}, rows: [] }}
              canManage={false}
              permissionKeys={permissions}
              runtimeState={params.has('offline') ? 'offline' : 'running'}
              pending={false}
              reload={async () => {}}
              onAccepted={() => {}}
            />
          </Suspense>
        </main>
      </LocaleProvider>
    </BrowserRouter>
  </QueryClientProvider>,
);
