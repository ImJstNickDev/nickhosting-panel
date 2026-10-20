import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { MinecraftModsSection } from '../../src/integrations/minecraft/mods.js';
import '../../src/app/style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <LocaleProvider>
      <BrowserRouter>
        <main style={{ padding: 'clamp(12px, 3vw, 36px)', maxWidth: 1400, margin: 'auto' }}>
          <h1 style={{ marginBottom: 18 }}>Fabric · Mods</h1>
          <MinecraftModsSection
            data={{ values: {}, rows: [] }}
            serverId="10000000-0000-4000-8000-000000000001"
            serverName="Fabric"
            runtimeState="running"
            canManage={!new URLSearchParams(location.search).has('readonly')}
            pending={false}
            onAccepted={() => {}}
            reload={async () => {}}
          />
        </main>
      </BrowserRouter>
    </LocaleProvider>
  </QueryClientProvider>,
);
