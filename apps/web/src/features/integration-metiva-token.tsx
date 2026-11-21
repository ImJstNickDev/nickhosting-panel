import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { ErrorNotice, Loading, Notice, Section } from '../components/ui.js';
import { OwnerSecretForm } from './owner-secret-form.js';

export async function resetMetivaCatalogs(cache: QueryClient, gameId?: string) {
  const scope = gameId ? [gameId] : [];
  await Promise.all([
    cache.resetQueries({ queryKey: ['integration-versions', ...scope] }),
    cache.resetQueries({ queryKey: ['creation', 'catalog', ...scope] }),
  ]);
}

export function IntegrationMetivaToken({ gameId }: { gameId: string }) {
  const t = useT();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const path = `/v1/owner/integrations/${encodeURIComponent(gameId)}/metiva-token`;
  const status = useQuery({
    queryKey: ['game-metiva-token', gameId],
    enabled: open,
    queryFn: ({ signal }) =>
      api<{ configured: boolean; inherited: boolean; locked: boolean }>(path, { signal }),
  });
  return (
    <Section>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>{t('owner.secret.metivaAccessToken')}</summary>
        {open &&
          (status.isPending ? (
            <Loading />
          ) : status.error ? (
            <ErrorNotice error={status.error} retry={() => void status.refetch()} />
          ) : (
            <>
              <p className="muted">
                {t(
                  status.data.configured
                    ? 'ownerIntegration.metivaOverride'
                    : status.data.inherited
                      ? 'ownerIntegration.metivaGlobal'
                      : 'web.unconfigured',
                )}
              </p>
              {status.data.locked ? (
                <Notice>{t('owner.environmentLocked')}</Notice>
              ) : (
                <OwnerSecretForm
                  path={path}
                  allowClear={status.data.configured}
                  onSaved={async () => {
                    await Promise.all([status.refetch(), resetMetivaCatalogs(cache, gameId)]);
                  }}
                />
              )}
            </>
          ))}
      </details>
    </Section>
  );
}
