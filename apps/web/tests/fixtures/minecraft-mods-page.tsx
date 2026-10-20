import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { MinecraftModsSection } from '../../src/integrations/minecraft/mods.js';
import '../../src/app/style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
function ModsFixture() {
  const [visible, setVisible] = useState(true);
  return (
    <main style={{ padding: 'clamp(12px, 3vw, 36px)', maxWidth: 1400, margin: 'auto' }}>
      <h1 style={{ marginBottom: 18 }}>Fabric · Mods</h1>
      {new URLSearchParams(location.search).has('remount') && (
        <button type="button" onClick={() => setVisible((value) => !value)}>
          {visible ? 'Leave Mods' : 'Return to Mods'}
        </button>
      )}
      {visible && (
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
      )}
    </main>
  );
}
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <LocaleProvider>
      <BrowserRouter>
        <ModsFixture />
      </BrowserRouter>
    </LocaleProvider>
  </QueryClientProvider>,
);
