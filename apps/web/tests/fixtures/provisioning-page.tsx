import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import { queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { ConsolePage } from '../../src/features/console.js';
import '../../src/app/style.css';

const id = '10000000-0000-4000-8000-000000000001';
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <LocaleProvider>
      <BrowserRouter>
        <main style={{ padding: '24px', maxWidth: 1320, margin: 'auto' }}>
          <nav className="tabs" aria-label="Server">
            <Link to="/provisioning-fixture">Console</Link>
            <Link to="/provisioning-files">Files</Link>
          </nav>
          <Routes>
            <Route path="/provisioning-fixture" element={<ConsolePage serverId={id} />} />
            <Route path="*" element={<h1>Files</h1>} />
          </Routes>
        </main>
      </BrowserRouter>
    </LocaleProvider>
  </QueryClientProvider>,
);
