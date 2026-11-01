import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { SftpPage } from '../../src/features/backups-sftp.js';
import '../../src/app/style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <MemoryRouter>
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <main style={{ padding: '24px', maxWidth: 1100, margin: 'auto' }}>
          <SftpPage serverId="sftp-fixture" />
        </main>
      </LocaleProvider>
    </QueryClientProvider>
  </MemoryRouter>,
);
