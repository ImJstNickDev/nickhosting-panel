import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { OwnerGameAdmin, OwnerIntegrationsPage } from '../../src/features/owner-integrations.js';
import '../../src/app/style.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing root');
createRoot(root).render(
  <BrowserRouter>
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <main style={{ padding: 24, maxWidth: 1200, margin: 'auto' }}>
          <Routes>
            <Route path="/owner/integrations" element={<OwnerIntegrationsPage />} />
            <Route path="/owner/integrations/:gameId/*" element={<OwnerGameAdmin />} />
          </Routes>
        </main>
      </LocaleProvider>
    </QueryClientProvider>
  </BrowserRouter>,
);
