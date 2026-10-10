import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { listPlatformGames } from '../../../../packages/server-management/src/platform-queries.js';
import { api } from '../api/client.js';
import type { Result } from '../api/contracts.js';
import { useT } from '../app/i18n.js';
import {
  ActionForm,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  Page,
  Section,
  Select,
  Textarea,
  Time,
  text,
} from '../components/ui.js';
import { getGameAdmin, getGameArtwork } from './integrations.js';
import { IntegrationSleepSettings } from './sleep-timeout.js';

export function OwnerIntegrationsPage() {
  const t = useT();
  const games = useQuery({
    queryKey: ['owner-games'],
    queryFn: () => api<Result<typeof listPlatformGames>>('/v1/platform/owner/games'),
  });
  const modules = useQuery({
    queryKey: ['owner-game-modules'],
    queryFn: () =>
      api<Array<{ id: string; manifest: { nameKey: string } }>>('/v1/owner/game-modules'),
  });
  return (
    <Page title={t('web.integrations')}>
      {games.isPending || modules.isPending ? (
        <Loading />
      ) : games.error || modules.error ? (
        <ErrorNotice error={games.error ?? modules.error} />
      ) : modules.data.length === 0 ? (
        <Empty />
      ) : (
        modules.data.map((module) => {
          const stored = games.data.find((game) => game.id === module.id);
          const art = getGameArtwork(module.id);
          return (
            <Section
              key={module.id}
              title={t(module.manifest.nameKey)}
              actions={
                getGameAdmin(module.id) ? (
                  <Link to={`/owner/integrations/${module.id}`}>{t('owner.compatibility')}</Link>
                ) : undefined
              }
            >
              <div className="integration-settings">
                {art && <img className="integration-art" src={art} alt="" />}
                <div>
                  <ActionForm
                    onSubmit={async (data) => {
                      await api('/v1/owner/games', {
                        method: 'PUT',
                        body: {
                          manifest: module.manifest,
                          rollout: {
                            gameId: module.id,
                            state: text(data, 'state'),
                            allowedUserIds: text(data, 'allowlist').split(/\s+/).filter(Boolean),
                          },
                        },
                      });
                      await games.refetch();
                    }}
                  >
                    <Select
                      label={t('owner.rollout')}
                      name="state"
                      defaultValue={stored?.state ?? 'development'}
                    >
                      {['development', 'private-testing', 'public', 'disabled-for-new-servers'].map(
                        (state) => (
                          <option key={state} value={state}>
                            {t(`owner.rollout.${state}`)}
                          </option>
                        ),
                      )}
                    </Select>
                    <Textarea
                      label={t('owner.testerAllowlist')}
                      name="allowlist"
                      defaultValue={stored?.allowlist?.join('\n') ?? ''}
                    />
                    <p className="muted">{t('owner.rolloutEvidence')}</p>
                  </ActionForm>
                  <IntegrationSleepSettings gameId={module.id} />
                  {stored && (
                    <p>
                      <Time value={stored.rolloutUpdatedAt} />
                    </p>
                  )}
                </div>
              </div>
            </Section>
          );
        })
      )}
    </Page>
  );
}
export function OwnerGameAdmin() {
  const { gameId = '' } = useParams(),
    t = useT();
  const Component = getGameAdmin(gameId);
  return Component ? (
    <Component />
  ) : (
    <Page title={t('web.integrations')}>
      <Notice>{t('web.errors.notFound')}</Notice>
    </Page>
  );
}
