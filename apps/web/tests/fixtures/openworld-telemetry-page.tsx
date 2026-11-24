import { QueryClientProvider } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useParams } from 'react-router';
import { queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { gameUiRegistry, getGameSectionView } from '../../src/features/integrations.js';
import '../../src/app/style.css';

const id = '10000000-0000-4000-8000-000000000001';
if (location.pathname === '/telemetry-fixture')
  sessionStorage.setItem('fixture-options', location.search);
const params = new URLSearchParams(
  location.search || sessionStorage.getItem('fixture-options') || '',
);
if (location.pathname === '/telemetry-fixture')
  history.replaceState(null, '', `/servers/${id}/game/${params.get('section')}${location.hash}`);
const permissionKeys = ['game.openworld.players.read', 'game.openworld.performance.read'];
if (!params.has('reader')) permissionKeys.push('game.openworld.players.inspect');
if (params.get('section') === 'map' || params.has('mapAccess'))
  permissionKeys.push('game.openworld.map.read');
if (params.has('zoneAccess'))
  permissionKeys.push('game.openworld.rules.view', 'game.openworld.territory.manage');
if (params.has('seedAccess')) permissionKeys.push('game.openworld.seed.inspect');
if (params.has('cartographer')) permissionKeys.push('game.openworld.checkpoints.manage');
if (params.has('moderator')) permissionKeys.push('game.openworld.players.moderate');
if (params.has('accessEditor'))
  permissionKeys.push(
    'game.openworld.bans.manage',
    'game.openworld.roles.manage',
    'game.openworld.territory.manage',
  );
if (params.has('screenshots')) permissionKeys.push('game.openworld.players.screenshots');
function FixtureView() {
  const { sectionId } = useParams();
  const section = gameUiRegistry
    .get('openworld')
    ?.descriptor.sections.find((s) => s.id === sectionId);
  const View = getGameSectionView(section?.renderer);
  const [effective, setEffective] = useState(permissionKeys);
  useEffect(() => {
    const revoke = (event: Event) => {
      const permission = (event as CustomEvent<string>).detail;
      setEffective((keys) => keys.filter((k) => k !== permission));
    };
    window.addEventListener('fixture-revoke', revoke);
    return () => window.removeEventListener('fixture-revoke', revoke);
  }, []);
  if (!View) return null;
  return (
    <View
      serverId={id}
      serverName="North Coast"
      data={{ values: {}, rows: [] }}
      canManage={false}
      permissionKeys={effective}
      runtimeState={params.has('offline') ? 'offline' : 'running'}
      pending={false}
      reload={async () => {}}
      onAccepted={() => {}}
    />
  );
}
createRoot(document.getElementById('root') as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <LocaleProvider>
        <main style={{ margin: '20px auto', maxWidth: 960, padding: '0 12px' }}>
          <Suspense>
            <Routes>
              <Route path="/servers/:serverId/game/:sectionId/*" element={<FixtureView />} />
            </Routes>
          </Suspense>
        </main>
      </LocaleProvider>
    </BrowserRouter>
  </QueryClientProvider>,
);
