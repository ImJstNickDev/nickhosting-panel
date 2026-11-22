import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import type { OpenworldSavedPlayerDetail } from '../../../../../games/openworld/src/offline-players.js';
import type { OpenworldActionPlayer } from '../../../../../games/openworld/src/player-actions.js';
import type { OpenworldTelemetryData } from '../../../../../games/openworld/src/telemetry.js';
import { ApiError } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { ErrorNotice, Loading, Select } from '../../components/ui.js';
import { mapHref } from './map-players.js';
import { type ActionReceipt, PlayerActions } from './player-actions.js';
import { PlayerGallery } from './player-gallery.js';
import {
  type Connection,
  connection,
  type Player,
  PlayerArt,
  type Profile,
  people,
  playerParams,
  samePlayer,
  usePlayerFormat,
  verifiedAccount,
} from './player-identity.js';
import { PlayerEquipment, PlayerInventory } from './player-inventory.js';
import { PlayerVitals } from './player-vitals.js';
import { usePlayerResource } from './player-workspace.js';
import {
  key,
  Metrics,
  numeric,
  ObservationStamp,
  type ServerView,
  useTelemetry,
} from './telemetry.js';

type Pane = 'character' | 'inventory' | 'activity' | 'gallery' | 'network';
type Detail = OpenworldTelemetryData['player'];
const captureAccount = z.uuid();
export function PlayerProfile({
  server,
  selected,
  connected,
  accountSessions,
  onChooseSession,
  onIdentify,
  version,
  pendingRoster,
  rosterReason,
  inspect,
  moderate,
  screenshots,
  mapAccess,
  otherPlayers,
  watchUntil,
  onRequestAccepted,
  onServerGallery,
  backTo,
}: {
  server: ServerView;
  selected: Profile;
  connected?: Player;
  accountSessions: Player[];
  onChooseSession: (p: Player) => void;
  onIdentify: (account: string) => void;
  version?: string | null;
  pendingRoster: boolean;
  rosterReason: string | null;
  inspect: boolean;
  moderate: boolean;
  screenshots: boolean;
  mapAccess: boolean;
  otherPlayers: OpenworldActionPlayer[];
  watchUntil: number;
  onRequestAccepted: (r: ActionReceipt) => void;
  onServerGallery: () => void;
  backTo: string;
}) {
  const t = useT(),
    f = usePlayerFormat();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const [requested, setTab] = useState<Pane>('character');
  const [preferredSource, setSource] = useState<'live' | 'saved'>('live');
  const [receipt, setReceipt] = useState<ActionReceipt | null>(null);
  const session = selected.connection;
  const live = !!connected && !!session;
  const account = inspect ? selected.account || (connected && verifiedAccount(connected)) : null;
  const hasConnection = !!session || accountSessions.length > 0;
  const needsChoice = !live && accountSessions.length > 1;
  const canShowShots = !!(screenshots && account && captureAccount.safeParse(account).success);
  const panes: Pane[] = [
    'character',
    ...(inspect ? (['inventory', 'activity'] as const) : []),
    ...(canShowShots ? (['gallery'] as const) : []),
    ...(inspect && hasConnection ? (['network'] as const) : []),
  ];
  const tab = panes.includes(requested) ? requested : panes[0];
  const wantsLive = tab !== 'gallery' && (preferredSource === 'live' || tab === 'network');
  const detail = useTelemetry(
    server,
    'player',
    session ? `players/${session.id}?${playerParams(session)}` : 'players',
    inspect && live && wantsLive,
  );
  const raw = detail.data?.data;
  const data =
    live &&
    inspect &&
    !detail.error &&
    raw &&
    detail.data?.source === 'live' &&
    session &&
    samePlayer(
      session,
      connection(raw, detail.data.observedAt, detail.data.processRef ?? session.processRef),
    )
      ? raw
      : null;
  const observedAccount =
    (connected && verifiedAccount(connected)) || (data && verifiedAccount(data));
  useEffect(() => {
    if (inspect && observedAccount && !selected.account) onIdentify(observedAccount);
  }, [inspect, observedAccount, selected.account, onIdentify]);
  const resourcePane =
    inspect && (tab === 'character' || tab === 'inventory' || tab === 'activity');
  const source = !live || preferredSource === 'saved' ? 'saved' : 'live';
  const saved = usePlayerResource<OpenworldSavedPlayerDetail>(
    server,
    `players/saved/${encodeURIComponent(account ?? '')}`,
    { enabled: inspect && !!account && resourcePane && source === 'saved' },
  );
  const archive = account && !saved.error && saved.data?.uuid === account ? saved.data : null;
  const unavailable = (code: string) => <p className="ow-empty">{t(key(code))}</p>;
  const confirmedGone =
    !pendingRoster && !live && !!session && (!rosterReason || server.runtimeState === 'offline');
  const onlineOnlyMessage = needsChoice ? (
    <p className="ow-empty">{t(people('chooseSession'))}</p>
  ) : (
    unavailable(confirmedGone ? 'playerGone' : rosterReason || 'unavailable')
  );
  const actionTarget =
    source === 'live' && live && session && session.joinedAt !== null && session.processRef
      ? {
          player: { id: session.id, name: session.name, joinedAt: session.joinedAt },
          processRef: session.processRef,
        }
      : null;
  function content() {
    if (tab === 'gallery' && account && canShowShots)
      return <PlayerGallery server={server} account={account} watchUntil={watchUntil} />;
    if (!inspect) return !live ? pendingRoster ? <Loading /> : onlineOnlyMessage : null;
    if (tab === 'network' && !live) return pendingRoster ? <Loading /> : onlineOnlyMessage;
    if (source === 'live' || tab === 'network') {
      if (detail.error instanceof ApiError && detail.error.status === 404)
        return unavailable('playerGone');
      if (detail.error)
        return <ErrorNotice error={detail.error} retry={() => void detail.refetch()} />;
      if (detail.isPending) return <Loading />;
      if (!data) return unavailable(detail.data?.reason ?? 'unavailable');
      if (tab === 'inventory')
        return <PlayerInventory source="live" player={data} version={version} />;
      if (tab === 'activity') return <Activity stats={data.record} />;
      if (tab === 'network')
        return (
          <>
            <ObservationStamp value={detail.data} />
            <Network player={data} />
          </>
        );
      return (
        <Character
          server={server}
          live={data}
          session={session}
          mapAccess={mapAccess}
          version={version}
          skinHash={data.skinHash ?? connected?.skinHash}
        />
      );
    }
    if (!account) return pendingRoster ? <Loading /> : onlineOnlyMessage;
    if (saved.error instanceof ApiError && saved.error.status === 404)
      return unavailable('saveNotFound');
    if (saved.error) return <ErrorNotice error={saved.error} retry={() => void saved.refetch()} />;
    if (!archive) return <Loading />;
    if (tab === 'inventory')
      return <PlayerInventory source="saved" player={archive} version={version} />;
    if (tab === 'activity') return <Activity stats={archive.stats} />;
    return <Character server={server} archive={archive} mapAccess={mapAccess} version={version} />;
  }
  return (
    <>
      <Link className="ow-profile-back" to={backTo}>
        ← {t(key('players'))}
      </Link>
      <section className="ow-panel ow-profile" aria-labelledby={headingId}>
        <header className="ow-heading">
          <h2 id={headingId} ref={heading} tabIndex={-1}>
            {live ? selected.name : archive?.name || selected.name}
          </h2>
        </header>
        <div className="ow-profile-banner">
          <span className={`ow-presence ${live || accountSessions.length ? 'is-live' : ''}`}>
            {t(
              live || accountSessions.length
                ? key('connected')
                : people(
                    confirmedGone || server.runtimeState === 'offline' ? 'offlinePlayer' : 'saved',
                  ),
            )}
          </span>
          {live && tab !== 'character' && (
            <span>
              {[connected.world, connected.mode && f.mode(connected.mode), data?.role?.name]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
          {live && data?.accountVerified && <span>{t(key('verified'))}</span>}
        </div>
        {accountSessions.length > 1 && (
          <Select
            label={t(key('session'))}
            value={live ? String(connected.id) : ''}
            onChange={(e) => {
              const pick = accountSessions.find((p) => p.id === Number(e.target.value));
              if (pick) {
                setReceipt(null);
                setSource('live');
                onChooseSession(pick);
              }
            }}
          >
            <option value="" disabled>
              {t(people('chooseSession'))}
            </option>
            {accountSessions.map((p) => (
              <option key={p.id} value={p.id}>
                {[p.name, t(people('sessionId'), { id: p.id }), p.world]
                  .filter(Boolean)
                  .join(' · ')}
              </option>
            ))}
          </Select>
        )}
        {panes.length > 1 && (
          <fieldset className="ow-filters ow-profile-tabs">
            <legend className="visually-hidden">{t(key('details'))}</legend>
            {panes.map((p) => (
              <button key={p} type="button" aria-pressed={tab === p} onClick={() => setTab(p)}>
                {t(key(p))}
              </button>
            ))}
          </fieldset>
        )}
        {receipt && (
          <div role="status" className="ow-receipt">
            <span>
              {t(key(receipt.kind === 'screenshot' ? 'screenshotRequested' : 'actionAccepted'), {
                name: receipt.playerName,
                action: t(key(`action.${receipt.kind}`)),
              })}
            </span>
            {receipt.kind === 'screenshot' && screenshots && (
              <button
                className="secondary"
                type="button"
                onClick={canShowShots ? () => setTab('gallery') : onServerGallery}
              >
                {t(key('openGallery'))}
              </button>
            )}
            <button
              type="button"
              className="ow-dismiss"
              aria-label={t('web.close')}
              onClick={() => setReceipt(null)}
            >
              ×
            </button>
          </div>
        )}
        {resourcePane && (
          <div className="ow-source-row">
            {live && account && (
              <fieldset className="ow-switcher ow-source-picker">
                <legend className="visually-hidden">{t(people('source'))}</legend>
                {(['live', 'saved'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={source === s}
                    onClick={() => setSource(s)}
                  >
                    {t(s === 'live' ? key('live') : people('saveDetails'))}
                  </button>
                ))}
              </fieldset>
            )}
            {source === 'live' && data && <ObservationStamp value={detail.data} />}
            {source === 'saved' && archive && (
              <span className="ow-source-time">
                {t(key('lastSave'))} ·{' '}
                {f.stamp(
                  tab === 'activity' ? (archive.statsAt ?? archive.savedAt) : archive.savedAt,
                )}
              </span>
            )}
          </div>
        )}
        <div className={resourcePane || tab === 'network' ? 'ow-detail-content' : undefined}>
          {tab === 'character' && (moderate || screenshots) ? (
            <div className={inspect ? 'ow-character-workspace' : undefined}>
              {(inspect || !live) && <div className="ow-character-main">{content()}</div>}
              <PlayerActions
                key={JSON.stringify(actionTarget)}
                server={server}
                target={actionTarget}
                awaitingConfirmation={source === 'live' && !actionTarget}
                otherPlayers={otherPlayers}
                moderate={moderate}
                screenshots={screenshots}
                onAccepted={(r) => {
                  setReceipt(r);
                  onRequestAccepted(r);
                }}
              />
            </div>
          ) : (
            content()
          )}
        </div>
      </section>
    </>
  );
}

function Character({
  server,
  live,
  archive,
  session,
  mapAccess,
  version,
  skinHash,
}: {
  server: ServerView;
  live?: Detail;
  archive?: OpenworldSavedPlayerDetail;
  session?: Connection | null;
  mapAccess: boolean;
  version?: string | null;
  skinHash?: string | null;
}) {
  const t = useT(),
    f = usePlayerFormat();
  const person = live ?? archive;
  if (!person) return null;
  const pos = live?.pos ?? archive?.position,
    world = person.world;
  const map =
    mapAccess &&
    world &&
    !live?.inSpace &&
    numeric(pos?.face) &&
    Number.isInteger(pos.face) &&
    pos.face >= 0 &&
    pos.face <= 5 &&
    numeric(pos.x) &&
    numeric(pos.z)
      ? mapHref(server.serverId, {
          world,
          face: pos.face,
          x: pos.x,
          z: pos.z,
          ...(numeric(pos.y) ? { y: pos.y } : {}),
        })
      : null;
  const account = live?.account ?? archive?.uuid;
  return (
    <>
      <div className="ow-character">
        <div className="ow-character-portrait">
          <PlayerArt
            serverId={server.serverId}
            name={person.name ?? archive?.uuid ?? ''}
            session={session}
            hash={skinHash}
            savedSkin={archive && { account: archive.uuid, hash: archive.skinHash }}
            body
          />
        </div>
        <div className="ow-character-location">
          {world && <strong>{world}</strong>}
          <span>
            {[person.mode && f.mode(person.mode), live?.role?.name].filter(Boolean).join(' · ')}
          </span>
          {live && numeric(live.connectedS) && (
            <span>
              {t(key('session'))} · {f.duration(live.connectedS)}
            </span>
          )}
          {archive?.stats?.lastSeenMs && (
            <span>{t(people('lastVisitAt'), { time: f.stamp(archive.stats.lastSeenMs) })}</span>
          )}
          {map && <Link to={map}>{t('games.openworld.map.showOnMap')}</Link>}
        </div>
        <PlayerVitals
          vitals={person.vitals}
          version={version}
          saved={!!archive}
          observedAt={archive?.vitalsObservedAt}
        />
      </div>
      <PlayerEquipment player={person} version={version} />
      {(pos || account || live?.geo) && (
        <details className="ow-disclosure ow-identity-details">
          <summary>{t(people('details'))}</summary>
          <Metrics
            items={[
              ...(account ? [[t(key('account')), account] as [string, string]] : []),
              ...(pos
                ? [
                    [
                      t(key('localPosition')),
                      [pos.x, pos.y, pos.z].map((v) => f.metric(v, '', 2)).join(', '),
                    ] as [string, string],
                  ]
                : []),
              ...(live?.geo
                ? ([
                    [t(key('latitude')), f.metric(live.geo.lat, '°', 4)],
                    [t(key('longitude')), f.metric(live.geo.lon, '°', 4)],
                    [t(key('altitude')), f.metric(live.geo.alt, 'm', 0)],
                  ] as [string, string][])
                : []),
            ]}
          />
        </details>
      )}
    </>
  );
}
function Network({ player: p }: { player: Detail }) {
  const t = useT(),
    f = usePlayerFormat();
  return (
    <Metrics
      items={[
        [t(key('ping')), f.metric(p.pingMs, 'ms')],
        [t(key('loss')), f.metric(p.lossPct, '%')],
        [t(key('inbound')), f.bitrate(p.recvKbps)],
        [t(key('outbound')), f.bitrate(p.sentKbps)],
        [t(key('fps')), f.metric(p.client?.fps)],
        [t(key('loaded')), f.metric(p.client?.columnsLoaded)],
        [t(key('pending')), f.metric(p.client?.columnsPending)],
        ['MTU', f.metric(p.mtu, 'B')],
      ]}
    />
  );
}
function Activity({ stats }: { stats: Detail['record'] | OpenworldSavedPlayerDetail['stats'] }) {
  const t = useT(),
    f = usePlayerFormat();
  if (!stats) return <p className="ow-empty">{t(key('detailedMetricsUnavailable'))}</p>;
  const rows: [string, string][] = [
    [t(key('firstSeen')), f.stamp(stats.firstSeenMs)],
    [t(key('lastSeen')), 'lastSeenMs' in stats ? f.stamp(stats.lastSeenMs) : '—'],
    [t(key('logins')), f.metric(stats.joins)],
    [t(key('playtime')), f.duration(stats.playSeconds)],
    [t(key('distance')), f.metric(stats.walkedMeters, 'm', 0)],
    [t(key('placed')), f.metric(stats.blocksPlaced)],
    [t(key('broken')), f.metric(stats.blocksBroken)],
    [t(key('kills')), f.metric(stats.creatureKills)],
    [t(key('playerKills')), f.metric(stats.playerKills)],
    [t(key('deaths')), f.metric(stats.deaths)],
  ];
  const present = rows.filter(([, value]) => value !== '—');
  return present.length ? (
    <Metrics items={present} />
  ) : (
    <p className="ow-empty">{t(key('detailedMetricsUnavailable'))}</p>
  );
}
