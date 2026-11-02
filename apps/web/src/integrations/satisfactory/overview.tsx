import { useQuery } from '@tanstack/react-query';
import type { SatisfactoryGameState } from '../../../../../games/satisfactory/src/api.js';
import { api } from '../../api/client.js';
import { useFormat, useT } from '../../app/i18n.js';
import { Details, ErrorNotice } from '../../components/ui.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import './settings.css';

type Overview = {
  configured: boolean;
  state: SatisfactoryGameState | null;
  observedAt: string | null;
  source: 'live' | 'snapshot' | 'unavailable';
};
export function SatisfactoryOverviewSection(props: GameSectionViewProps) {
  const t = useT(),
    format = useFormat();
  const key = (name: string) => `games.satisfactory.overview.${name}`;
  const query = useQuery({
    queryKey: ['satisfactory-overview', props.serverId, props.runtimeState],
    queryFn: ({ signal }) =>
      api<Overview>(`/v1/servers/${encodeURIComponent(props.serverId)}/satisfactory/api/overview`, {
        signal,
      }),
    refetchInterval: props.runtimeState === 'running' ? 15000 : false,
  });
  const state = query.data?.state;
  return (
    <section className="workspace-surface satisfactory-settings">
      <div className="form-footer">
        <h2>{t(key('title'))}</h2>
        <button
          type="button"
          className="secondary"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t(key('refresh'))}
        </button>
      </div>
      {query.error && <ErrorNotice error={query.error} />}
      {query.isPending && <p role="status">{t('web.loading')}</p>}
      {query.data && (
        <>
          <p>{t(key(query.data.source))}</p>
          {!query.data.configured && <p>{t('games.satisfactory.api.unconfigured')}</p>}
          {query.data.observedAt && (
            <p>
              {t(key('observedAt'))}: {format.date(query.data.observedAt)}
            </p>
          )}
          {state && (
            <Details
              values={[
                [t('games.satisfactory.api.session'), state.activeSessionName || '—'],
                [t(key('running')), t(key(state.isGameRunning ? 'yes' : 'no'))],
                [
                  t('games.satisfactory.api.players'),
                  `${state.numConnectedPlayers} / ${state.playerLimit}`,
                ],
                [t(key('tier')), format.number(state.techTier)],
                [t(key('phase')), state.gamePhase || '—'],
                [t(key('schematic')), state.activeSchematic || '—'],
                [t(key('duration')), format.number(state.totalGameDuration / 3600)],
                [t(key('paused')), t(key(state.isGamePaused ? 'yes' : 'no'))],
                [t('games.satisfactory.api.tickRate'), format.number(state.averageTickRate)],
              ]}
            />
          )}
        </>
      )}
    </section>
  );
}
