import { QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { gameUiRegistry, getGameSectionView } from '../../src/features/integrations.js';
import '../../src/app/style.css';

const params = new URLSearchParams(location.search);
const id = '10000000-0000-4000-8000-000000000001';
const permissionKeys = ['game.openworld.players.read', 'game.openworld.performance.read'];
if (!params.has('reader')) permissionKeys.push('game.openworld.players.inspect');
const section = gameUiRegistry
  .get('openworld')
  ?.descriptor.sections.find((s) => s.id === params.get('section'));
const View = getGameSectionView(section?.renderer);
if (!View) throw Error('Missing Openworld section renderer');
createRoot(document.getElementById('root') as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <LocaleProvider>
      <main style={{ margin: '20px auto', maxWidth: 960, padding: '0 12px' }}>
        <Suspense>
          <View
            serverId={id}
            serverName="North Coast"
            data={{ values: {}, rows: [] }}
            canManage={false}
            permissionKeys={permissionKeys}
            runtimeState={params.has('offline') ? 'offline' : 'running'}
            pending={false}
            reload={async () => {}}
            onAccepted={() => {}}
          />
        </Suspense>
      </main>
    </LocaleProvider>
  </QueryClientProvider>,
);
