import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { api, queryClient } from '../../src/api/client.js';
import { LocaleProvider } from '../../src/app/i18n.js';
import { useConnectionAvailability } from '../../src/features/connection-availability.js';
import {
  type ConnectionChoice,
  ConnectionFields,
  CreationConnection,
  useConnectionOptions,
} from '../../src/features/connection-fields.js';
import { ConsoleSummary } from '../../src/features/console-summary.js';
import { CreateServerPage } from '../../src/features/create-server.js';
import { NetworkPage } from '../../src/features/network.js';
import { IntegrationConnectionSettings, OwnerDomains } from '../../src/features/owner-domains.js';
import '../../src/app/style.css';

function Fixture() {
  const view = new URLSearchParams(location.search).get('view');
  const navigation = useLocation();
  const options = useConnectionOptions(
    ['creation', 'availability'].includes(view ?? '') ? 'fixture' : '',
  );
  const [choice, setChoice] = useState<ConnectionChoice>({});
  const availability = useConnectionAvailability(
    'fixture',
    options.data,
    choice,
    view === 'availability',
    setChoice,
  );
  const [continued, setContinued] = useState(false);
  const settings = useQuery({
    queryKey: ['owner-settings'],
    queryFn: () =>
      api<{ config: { values: Record<string, unknown>; lockedKeys: string[] } }>(
        '/v1/owner/settings',
      ),
    enabled: view === 'owner',
  });
  return (
    <main style={{ padding: 24, maxWidth: 1000, margin: 'auto' }}>
      <h1>Domains fixture</h1>
      {view === 'summary' ? (
        <ConsoleSummary serverId="domain-fixture" availability="unavailable" />
      ) : view === 'wizard' ? (
        navigation.pathname.startsWith('/servers/') ? (
          <output data-testid="created-console">{navigation.pathname}</output>
        ) : (
          <CreateServerPage />
        )
      ) : view === 'availability' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (availability.canContinue) setContinued(true);
          }}
        >
          <CreationConnection
            options={options}
            value={choice}
            onChange={setChoice}
            availability={availability.state}
            retry={availability.retry}
            generate={availability.canGenerate ? () => void availability.generate() : undefined}
            generating={availability.generating}
          />
          <button type="submit" disabled={!availability.canContinue}>
            Next
          </button>
          <output>{continued ? 'continued' : ''}</output>
        </form>
      ) : view === 'creation' ? (
        options.data && (
          <>
            <ConnectionFields options={options.data} value={choice} onChange={setChoice} />
            <output>{JSON.stringify(choice)}</output>
          </>
        )
      ) : view === 'owner' ? (
        settings.data && (
          <>
            <OwnerDomains
              key={JSON.stringify(settings.data.config)}
              values={settings.data.config.values}
              lockedKeys={settings.data.config.lockedKeys}
              editable
              onSaved={() => settings.refetch()}
            />
            <IntegrationConnectionSettings gameId="fixture" />
          </>
        )
      ) : (
        <NetworkPage serverId="domain-fixture" />
      )}
    </main>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(
  <MemoryRouter>
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <Fixture />
      </LocaleProvider>
    </QueryClientProvider>
  </MemoryRouter>,
);
