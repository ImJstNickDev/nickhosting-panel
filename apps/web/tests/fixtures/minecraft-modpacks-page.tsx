import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { GameSections } from '../../src/features/game-sections.js';
import { MinecraftModpacksSection } from '../../src/integrations/minecraft/modpacks.js';
import '../../src/app/style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <LocaleProvider>
      <BrowserRouter>
        <main style={{ padding: 'clamp(12px,3vw,36px)', maxWidth: 1400, margin: 'auto' }}>
          <h1 style={{ marginBottom: 18 }}>Minecraft · Modpacks</h1>
          {new URLSearchParams(location.search).has('core') ? (
            <GameSections
              serverId="10000000-0000-4000-8000-000000000001"
              gameId="minecraft"
              sectionId="modpacks"
            />
          ) : (
            <MinecraftModpacksSection
              data={{ values: {}, rows: [] }}
              serverId="10000000-0000-4000-8000-000000000001"
              serverName="Fixture"
              runtimeState="running"
              canManage={!new URLSearchParams(location.search).has('readonly')}
              permissionKeys={
                new URLSearchParams(location.search).has('readonly')
                  ? []
                  : [
                      'game.minecraft.modpacks.read',
                      'game.minecraft.modpacks.write',
                      ...(new URLSearchParams(location.search).has('nodeleteworlds')
                        ? []
                        : ['game.minecraft.worlds.read', 'game.minecraft.worlds.delete']),
                      ...(new URLSearchParams(location.search).has('nobackup')
                        ? []
                        : ['backups.create']),
                    ]
              }
              pending={false}
              onAccepted={() => {}}
              reload={async () => {}}
            />
          )}
        </main>
      </BrowserRouter>
    </LocaleProvider>
  </QueryClientProvider>,
);
