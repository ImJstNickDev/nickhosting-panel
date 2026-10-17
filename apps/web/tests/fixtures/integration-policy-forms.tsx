import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { IntegrationContentPolicy } from '../../src/features/integration-content-policy.js';
import { MinecraftResponseSettings } from '../../src/features/integration-game-settings.js';
import '../../src/app/style.css';
import '../../src/features/owner-integrations.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing root');
createRoot(root).render(
  <BrowserRouter>
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <main
          className="owner-integration-body"
          style={{ padding: 24, maxWidth: 960, margin: 'auto' }}
        >
          {location.pathname.endsWith('content') ? (
            <IntegrationContentPolicy gameId="minecraft" />
          ) : (
            <MinecraftResponseSettings />
          )}
        </main>
      </LocaleProvider>
    </QueryClientProvider>
  </BrowserRouter>,
);
