import { createMinecraftUiController } from '@nickhosting/minecraft/ui';
import { useQuery } from '@tanstack/react-query';
import { lazy, type ReactNode, Suspense, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../api/client.js';
import { useFormat, useT } from '../../app/i18n.js';
import { ErrorNotice, Loading } from '../../components/ui.js';
import { gameUiClient } from '../../features/integrations.js';
import { MinecraftPlayerAvatar } from './player-avatar.js';
import { PlayerRoles } from './player-card.js';
import type { PlayerGameMode, PlayerGameplayAction } from './player-detail-actions.js';
import { PlayerIcon } from './player-icons.js';
import { PlayerUuid } from './player-uuid.js';
import type { MinecraftPlayerRow } from './players-model.js';
import './player-detail.css';

const controller = createMinecraftUiController(gameUiClient);
const key = (name: string) => `games.minecraft.players.${name}`;
const loadContent = () => import('./player-detail.js');
const Content = lazy(() =>
  loadContent().then((module) => ({ default: module.MinecraftPlayerDetailContent })),
);

export interface PlayerDetailProps {
  serverId: string;
  uuid: string;
  row?: MinecraftPlayerRow;
  pending: boolean;
  permissionKeys: readonly string[];
  legacyActions(row: MinecraftPlayerRow): ReactNode[];
  onAction(action: PlayerGameplayAction, mode?: PlayerGameMode): void;
  onBack(): void;
}

export function MinecraftPlayerDetailView(props: PlayerDetailProps) {
  const { serverId, uuid, row } = props;
  const t = useT();
  const format = useFormat();
  const heading = useRef<HTMLHeadingElement>(null);
  const validUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uuid);
  const queryKey = ['minecraft-player-detail', serverId, uuid];
  const saved = useQuery({
    queryKey: [...queryKey, 'saved'],
    queryFn: ({ signal }) => controller.savedPlayerDetails(serverId, uuid, signal),
    enabled: validUuid,
    retry: false,
  });
  const status = useQuery({
    queryKey: [...queryKey, 'status'],
    queryFn: ({ signal }) => controller.playerStatus(serverId, uuid, signal),
    enabled: validUuid,
    retry: false,
  });
  useEffect(() => {
    if (validUuid) void loadContent().catch(() => {});
  }, [validUuid]);
  const denied = [saved.error, status.error].find(
    (error) => error instanceof ApiError && [401, 403, 404].includes(error.status),
  );
  const data = saved.data;
  const name = (data ? data.player.name : row?.name) ?? uuid;
  const showIdentity = validUuid && !denied && Boolean(row || data);
  useEffect(() => {
    if (showIdentity && heading.current?.dataset.uuid === uuid)
      heading.current.focus({ preventScroll: true });
  }, [showIdentity, uuid]);
  const refresh = () => Promise.all([saved.refetch(), status.refetch()]);
  const statusReady = status.isSuccess && !status.isFetching;
  const live = statusReady ? status.data : undefined;
  const online = live?.online ?? 'unknown';
  const back = (
    <Link
      className="minecraft-player-back"
      to={`/servers/${serverId}/game/players`}
      onClick={props.onBack}
    >
      ← {t(key('backToPlayers'))}
    </Link>
  );
  if (!validUuid)
    return (
      <>
        {back}
        <p role="alert">{t(key('invalidPlayer'))}</p>
      </>
    );
  if (denied)
    return (
      <>
        {back}
        <ErrorNotice error={denied} retry={() => void refresh()} />
      </>
    );
  return (
    <div className="minecraft-player-detail">
      <div className="minecraft-player-detail-toolbar">
        {back}
        <button
          type="button"
          className="secondary minecraft-player-refresh"
          disabled={saved.isFetching || status.isFetching || props.pending}
          aria-busy={saved.isFetching || status.isFetching}
          onClick={() => void refresh()}
        >
          <PlayerIcon name="refresh" />
          {t(key('refreshDetail'))}
        </button>
      </div>
      {showIdentity && (
        <header className="minecraft-player-detail-header">
          <MinecraftPlayerAvatar name={name} uuid={uuid} />
          <div className="minecraft-player-detail-identity">
            <div className="minecraft-player-identity-line">
              <h2 tabIndex={-1} ref={heading} data-uuid={uuid}>
                {name}
              </h2>
              <PlayerUuid uuid={uuid} />
            </div>
            <div className="minecraft-player-detail-meta">
              <span className="minecraft-player-presence">
                {t(key(status.isFetching ? 'onlineLoading' : `presence.${online}`))}
              </span>
              {row && <PlayerRoles row={{ ...row, online: false }} />}
              {data && (
                <span className="minecraft-player-saved-time">
                  {data.snapshot.savedAt
                    ? t(key('savedAt'), { date: format.date(data.snapshot.savedAt) })
                    : t(key('saveTimeUnknown'))}
                </span>
              )}
            </div>
            {data && data.snapshot.state !== 'available' && (
              <p className="minecraft-player-snapshot-state" role="status">
                {t(key(`snapshot.${data.snapshot.state}`))}
              </p>
            )}
          </div>
        </header>
      )}
      {status.isError && <ErrorNotice error={status.error} retry={() => void status.refetch()} />}
      {saved.isError ? (
        <ErrorNotice error={saved.error} retry={() => void saved.refetch()} />
      ) : data ? (
        <Suspense fallback={<Loading />}>
          <Content
            {...props}
            statusReady={statusReady}
            data={{ ...data, online, capabilities: live?.capabilities ?? [] }}
          />
        </Suspense>
      ) : (
        <Loading />
      )}
    </div>
  );
}
