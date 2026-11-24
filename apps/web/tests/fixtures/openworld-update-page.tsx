import { QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { ConsolePage } from '../../src/features/console.js';
import { availableGameSections, getGameSectionView } from '../../src/features/integrations.js';
import { useServer } from '../../src/features/service-contracts.js';
import '../../src/app/style.css';

const serverId = '10000000-0000-4000-8000-000000000001';
function Settings() {
  const { data } = useServer(serverId);
  const section = data && availableGameSections(data).find((item) => item.id === 'version');
  const View = getGameSectionView(section?.renderer);
  if (!data || !View) return null;
  return (
    <View
      serverId={serverId}
      serverName={data.name}
      runtimeState={data.runtimeState}
      permissionKeys={data.permissionKeys}
      canManage={data.permissions.manage}
      data={{ values: {}, rows: [] }}
      pending={false}
      onAccepted={() => {}}
      reload={async () => {}}
    />
  );
}
createRoot(document.getElementById('root') as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <LocaleProvider>
        <main style={{ padding: 16 }}>
          <Suspense>
            <Routes>
              <Route path="/servers/:serverId/game/version" element={<Settings />} />
              <Route
                path="/servers/:serverId/console"
                element={<ConsolePage serverId={serverId} />}
              />
            </Routes>
          </Suspense>
        </main>
      </LocaleProvider>
    </BrowserRouter>
  </QueryClientProvider>,
);
