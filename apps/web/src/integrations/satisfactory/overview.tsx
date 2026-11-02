import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { SatisfactoryGameState } from '../../../../../games/satisfactory/src/api.js';
import {
  type SatisfactoryProgressionLabel,
  satisfactoryPhaseLabel,
  satisfactorySchematicLabel,
} from '../../../../../games/satisfactory/src/ui/progression.js';
import { api } from '../../api/client.js';
import { useFormat, useLocale, useT } from '../../app/i18n.js';
import { Details, ErrorNotice } from '../../components/ui.js';
import { IconAction } from '../../components/workspace-controls.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import './overview.css';

type Overview = {
  configured: boolean;
  state: SatisfactoryGameState | null;
  observedAt: string | null;
  source: 'live' | 'snapshot' | 'unavailable';
};
export function SatisfactoryOverviewSection(props: GameSectionViewProps) {
  const t = useT(),
    format = useFormat();
  const { locale } = useLocale();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const key = (name: string) => `games.satisfactory.overview.${name}`;
  const query = useQuery({
    queryKey: ['satisfactory-overview', props.serverId, props.runtimeState],
    queryFn: ({ signal }) =>
      api<Overview>(`/v1/servers/${encodeURIComponent(props.serverId)}/satisfactory/api/overview`, {
        signal,
      }),
    refetchInterval: props.runtimeState === 'running' ? 15000 : false,
  });
  const label = (value: SatisfactoryProgressionLabel) =>
    value.kind === 'localized' ? t(value.key, value.values) : value.label;
  const state = query.data?.state;
  const source = query.error && state ? 'snapshot' : query.data?.source;
  const timestamp = query.data?.observedAt;
  const observedAt = timestamp ? Date.parse(timestamp) : Number.NaN;
  const age = Math.max(0, (now - observedAt) / 1000);
  const unit = age >= 86400 ? 'day' : age >= 3600 ? 'hour' : 'minute';
  const divisor = unit === 'day' ? 86400 : unit === 'hour' ? 3600 : 60;
  const relative = !Number.isFinite(observedAt)
    ? ''
    : age < 60
      ? t(key('justNow'))
      : new Intl.RelativeTimeFormat(locale === 'it' ? 'it' : 'en', { numeric: 'always' }).format(
          -Math.floor(age / divisor),
          unit,
        );
  return (
    <section className="workspace-surface ficsit-overview">
      <header className="ficsit-overview-header">
        <h2>{t(key('title'))}</h2>
        {source && source !== 'unavailable' && (
          <span className={`ficsit-overview-source ${source}`}>{t(key(source))}</span>
        )}
      </header>
      {query.error && <ErrorNotice error={query.error} />}
      {query.isPending && <p role="status">{t('web.loading')}</p>}
      {query.data && (
        <>
          {query.data.source === 'unavailable' && <p>{t(key('unavailable'))}</p>}
          {!query.data.configured && <p>{t('games.satisfactory.api.unconfigured')}</p>}
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
                [
                  t(key('phase')),
                  <span className="ficsit-progression" key="project-assembly">
                    <svg
                      width="22"
                      height="26"
                      viewBox="0 0 24 28"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M10 1v18M14 1v18M6 19h12l4 6H2zM8 19v-5h8v5M5 26h14M4 7h16M7 4h10v6H7z" />
                    </svg>
                    <span>{label(satisfactoryPhaseLabel(state.gamePhase))}</span>
                  </span>,
                ],
                [t(key('schematic')), label(satisfactorySchematicLabel(state.activeSchematic))],
                [t(key('duration')), format.number(state.totalGameDuration / 3600)],
                [t(key('paused')), t(key(state.isGamePaused ? 'yes' : 'no'))],
                [t('games.satisfactory.api.tickRate'), format.number(state.averageTickRate)],
              ]}
            />
          )}
        </>
      )}
      <footer className="ficsit-overview-updated">
        {timestamp && Number.isFinite(observedAt) && (
          <time dateTime={timestamp} title={format.date(timestamp)}>
            {t(key('lastUpdated'), { time: relative })}
          </time>
        )}
        <IconAction
          label={t(key('refresh'))}
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 7v5h-5M4 17v-5h5" />
            <path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" />
          </svg>
        </IconAction>
      </footer>
    </section>
  );
}
