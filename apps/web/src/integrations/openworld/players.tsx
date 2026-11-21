import { useState } from 'react';
import type { OpenworldActionPlayer } from '../../../../../games/openworld/src/player-actions.js';
import type { OpenworldTelemetryData } from '../../../../../games/openworld/src/telemetry.js';
import { ApiError } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { Dialog, ErrorNotice, Loading } from '../../components/ui.js';
import { SearchField } from '../../components/workspace-controls.js';
import { type ActionReceipt, PlayerActions } from './player-actions.js';
import { PlayerGallery } from './player-gallery.js';
import { SavedPlayerDialog, SavedPlayers, savedUuid } from './saved-players.js';
import {
  base,
  key,
  Metrics,
  numeric,
  ObservationStamp,
  type ServerView,
  TelemetryPanel,
  type TelemetryViewProps,
  useMetricsFormat,
  useTelemetry,
  withTelemetrySession,
} from './telemetry.js';

type Player = OpenworldTelemetryData['players']['players'][number];
type PlayerDetail = OpenworldTelemetryData['player'];
type Selection = { id: number; name: string; joinedAt: number | null };

function identity(p: Player, stamp: string | null): Selection {
  const time = stamp ? Date.parse(stamp) : NaN;
  return {
    id: p.id,
    name: p.name,
    joinedAt:
      numeric(p.connectedS) && Number.isFinite(time)
        ? Math.round(time - p.connectedS * 1000)
        : null,
  };
}
function playerParams(p: Selection) {
  const params = new URLSearchParams({ name: p.name });
  if (p.joinedAt !== null) params.set('joinedAt', String(p.joinedAt));
  return params;
}
function samePlayer(a: Selection, b: Selection) {
  return (
    a.id === b.id &&
    a.name === b.name &&
    (a.joinedAt === null || b.joinedAt === null || Math.abs(a.joinedAt - b.joinedAt) <= 5000)
  );
}
function Avatar({
  player,
  serverId,
  selection,
  live,
}: {
  player: Player;
  serverId: string;
  selection: Selection;
  live: boolean;
}) {
  const [session] = useState(selection);
  const [failed, setFailed] = useState(false);
  const query = playerParams(session);
  query.set('view', 'head');
  if (player.skinHash) query.set('h', player.skinHash);
  return (
    <span aria-hidden="true" className="ow-avatar">
      {live && player.skinHash && !failed && samePlayer(selection, session) ? (
        <img
          width="36"
          height="36"
          loading="lazy"
          alt=""
          src={`${base(serverId)}/players/${player.id}/skin?${query}`}
          onError={() => setFailed(true)}
        />
      ) : (
        Array.from(player.name.trim())[0]?.toLocaleUpperCase() || '·'
      )}
    </span>
  );
}
function useMode() {
  const t = useT();
  return (mode?: string | null) =>
    mode && ['survival', 'creative', 'spectre', 'spectator'].includes(mode)
      ? t(key(mode === 'spectator' ? 'spectre' : mode))
      : mode || '—';
}

export const OpenworldPlayers = withTelemetrySession(Players);

function Players(props: TelemetryViewProps) {
  const t = useT(),
    f = useMetricsFormat(),
    mode = useMode();
  const [view, setView] = useState<'live' | 'directory' | 'gallery'>('live');
  const [saved, setSaved] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ActionReceipt | null>(null);
  const [watchUntil, setWatchUntil] = useState(0);
  const inspect = props.permissionKeys.includes('game.openworld.players.inspect');
  const moderate = props.permissionKeys.includes('game.openworld.players.moderate');
  const screenshots = props.permissionKeys.includes('game.openworld.players.screenshots');
  const activeView =
    (view === 'gallery' && !screenshots) || (view === 'directory' && !inspect) ? 'live' : view;
  const roster = useTelemetry(props, 'players', 'players', activeView === 'live');
  const [search, setSearch] = useState(''),
    [selection, setSelection] = useState<(Selection & { processRef?: string }) | null>(null);
  const current =
    roster.data?.source === 'live' && !roster.error && props.runtimeState === 'running';
  const liveProcess = roster.data?.source === 'live' ? roster.data.processRef : undefined;
  const stillConnected =
    !!selection &&
    current &&
    selection.processRef === liveProcess &&
    roster.data?.data?.players.some((p) =>
      samePlayer(selection, identity(p, roster.data?.observedAt ?? null)),
    );
  const targets: OpenworldActionPlayer[] = current
    ? (roster.data?.data?.players ?? []).flatMap((p) => {
        const candidate = identity(p, roster.data?.observedAt ?? null);
        return candidate.joinedAt !== null && p.id !== selection?.id
          ? [{ ...candidate, joinedAt: candidate.joinedAt }]
          : [];
      })
    : [];
  const changeView = (next: typeof view) => {
    setSelection(null);
    setSaved(null);
    setView(next);
  };
  return (
    <div className="ow-workspace">
      {(inspect || screenshots) && (
        <fieldset className="ow-switcher">
          <legend className="visually-hidden">{t(key('players'))}</legend>
          {(
            [
              'live',
              ...(inspect ? ['directory' as const] : []),
              ...(screenshots ? ['gallery' as const] : []),
            ] as const
          ).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={v === activeView}
              onClick={() => changeView(v)}
            >
              {t(key(v === 'live' ? 'connected' : v))}
            </button>
          ))}
        </fieldset>
      )}
      {receipt && (
        <div className="ow-receipt" role="status">
          <span className="ow-receipt-label">
            {t(key(receipt.kind === 'screenshot' ? 'screenshotRequested' : 'actionAccepted'), {
              name: receipt.playerName,
              action: t(key(`action.${receipt.kind}`)),
            })}
          </span>
          {receipt.kind === 'screenshot' && screenshots && activeView !== 'gallery' && (
            <button className="secondary" type="button" onClick={() => changeView('gallery')}>
              {t(key('openGallery'))}
            </button>
          )}
          <button
            className="ow-dismiss"
            type="button"
            aria-label={t('web.close')}
            onClick={() => setReceipt(null)}
          >
            ×
          </button>
        </div>
      )}
      {activeView === 'gallery' && screenshots ? (
        <PlayerGallery server={props} watchUntil={watchUntil} />
      ) : activeView === 'directory' ? (
        <SavedPlayers server={props} onOpen={setSaved} />
      ) : (
        <TelemetryPanel title={t(key('players'))} query={roster}>
          {(data, obs) => {
            const sorted = data.players
              .filter((p) => p.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
              .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
            if (!data.players.length)
              return (
                <p className="ow-empty">
                  {t(key(obs.source === 'snapshot' ? 'noPlayersSnapshot' : 'noPlayers'))}
                </p>
              );
            return (
              <>
                <div className="ow-roster-tools">
                  <span className="ow-count">
                    {t(key('rosterCount'), { count: data.players.length })}
                  </span>
                  <SearchField
                    label={t(key('searchPlayers'))}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {!sorted.length ? (
                  <p className="ow-empty">{t(key('noMatch'))}</p>
                ) : (
                  <ul className="ow-roster">
                    {sorted.map((p) => {
                      const sel = identity(p, obs.observedAt);
                      const avatar = (
                        <Avatar
                          key={p.skinHash ?? 'default'}
                          player={p}
                          selection={sel}
                          live={current}
                          serverId={props.serverId}
                        />
                      );
                      const admitted = p.admitted === true || p.state === 'playing';
                      const meta = [
                        p.world,
                        mode(p.mode) !== '—' ? mode(p.mode) : null,
                        admitted
                          ? null
                          : p.admitted === false || p.state
                            ? t(key('connecting'))
                            : null,
                      ]
                        .filter(Boolean)
                        .join(' · ');
                      const title = (
                        <>
                          {avatar}
                          <span className="ow-person">
                            <strong>{p.name}</strong>
                            {meta && <small>{meta}</small>}
                          </span>
                        </>
                      );
                      return (
                        <li key={JSON.stringify([p.id, p.name, p.skinHash])}>
                          {(inspect || moderate || screenshots) && current ? (
                            <button
                              type="button"
                              className="ow-player-link"
                              onClick={() => setSelection({ ...sel, processRef: liveProcess })}
                            >
                              {title}
                            </button>
                          ) : (
                            <div className="ow-player-label">{title}</div>
                          )}
                          <dl className="ow-roster-stats">
                            <div>
                              <dt>{t(key('session'))}</dt>
                              <dd>{f.duration(p.connectedS)}</dd>
                            </div>
                            <div>
                              <dt>{t(key('ping'))}</dt>
                              <dd>{f.metric(p.pingMs, 'ms', 0)}</dd>
                            </div>
                          </dl>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            );
          }}
        </TelemetryPanel>
      )}
      {saved && inspect && (
        <SavedPlayerDialog server={props} uuid={saved} onClose={() => setSaved(null)} />
      )}
      {!saved && (inspect || moderate || screenshots) && selection && (
        <PlayerDialog
          server={props}
          selection={selection}
          inspect={inspect}
          moderate={moderate}
          screenshots={screenshots}
          otherPlayers={targets}
          onOpenSaved={setSaved}
          onAccepted={(accepted) => {
            setReceipt(accepted);
            setSelection(null);
            if (accepted.kind === 'screenshot') setWatchUntil(Date.now() + 30000);
            void roster.refetch();
          }}
          connected={!!stillConnected}
          rosterUnavailable={
            roster.error ? 'unreachable' : !current ? (roster.data?.reason ?? 'unavailable') : null
          }
          onClose={() => setSelection(null)}
        />
      )}
    </div>
  );
}

function PlayerDialog({
  server,
  selection,
  connected,
  rosterUnavailable,
  onClose,
  inspect,
  moderate,
  screenshots,
  otherPlayers,
  onAccepted,
  onOpenSaved,
}: {
  server: ServerView;
  selection: Selection & { processRef?: string };
  connected: boolean;
  rosterUnavailable: string | null;
  inspect: boolean;
  moderate: boolean;
  screenshots: boolean;
  otherPlayers: OpenworldActionPlayer[];
  onAccepted: (receipt: ActionReceipt) => void;
  onOpenSaved: (uuid: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  type Pane = 'character' | 'network' | 'inventory' | 'activity' | 'actions';
  const [requestedTab, setTab] = useState<Pane>(inspect ? 'character' : 'actions');
  const [busy, setBusy] = useState(false);
  const canAct = moderate || screenshots;
  const tab = !inspect
    ? 'actions'
    : requestedTab === 'actions' && !canAct
      ? 'character'
      : requestedTab;
  const detail = useTelemetry(
    server,
    'player',
    `players/${selection.id}?${playerParams(selection)}`,
    connected && inspect && tab !== 'actions',
  );
  const missing = detail.error instanceof ApiError && detail.error.status === 404;
  const data = detail.data?.data;
  const valid = data && samePlayer(selection, identity(data, detail.data?.observedAt ?? null));
  const panes: Pane[] = [
    ...(inspect ? (['character', 'network', 'inventory', 'activity'] as const) : []),
    ...(canAct ? (['actions'] as const) : []),
  ];
  const account =
    valid && data.accountVerified === true && data.account ? savedUuid(data.account) : null;
  return (
    <Dialog
      title={selection.name}
      open
      showClose
      closeIcon
      closeDisabled={busy}
      className="ow-detail"
      onClose={onClose}
    >
      {rosterUnavailable ? (
        <p role="status" className="ow-empty">
          {t(key(rosterUnavailable))}
        </p>
      ) : !connected ? (
        <p role="status" className="ow-empty">
          {t(key('playerGone'))}
        </p>
      ) : (
        <>
          {panes.length > 1 && (
            <fieldset className="ow-filters" disabled={busy}>
              <legend className="visually-hidden">{t(key('details'))}</legend>
              {panes.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={tab === value}
                  onClick={() => setTab(value)}
                >
                  {t(key(value))}
                </button>
              ))}
            </fieldset>
          )}
          {tab === 'actions' ? (
            selection.joinedAt === null || !selection.processRef ? (
              <p>{t(key('unconfirmedSession'))}</p>
            ) : (
              <PlayerActions
                server={server}
                player={{ id: selection.id, name: selection.name, joinedAt: selection.joinedAt }}
                processRef={selection.processRef}
                otherPlayers={otherPlayers}
                moderate={moderate}
                screenshots={screenshots}
                onBusy={setBusy}
                onAccepted={onAccepted}
              />
            )
          ) : missing ? (
            <p role="status" className="ow-empty">
              {t(key('playerGone'))}
            </p>
          ) : detail.error ? (
            <ErrorNotice error={detail.error} retry={() => void detail.refetch()} />
          ) : detail.isPending ? (
            <Loading />
          ) : !data || detail.data?.source !== 'live' ? (
            <p className="ow-empty">{t(key(detail.data?.reason ?? 'unavailable'))}</p>
          ) : !valid ? (
            <p role="status" className="ow-empty">
              {t(key('playerGone'))}
            </p>
          ) : (
            <>
              <div className="ow-detail-header">
                <span>
                  {[data.world, data.role?.name, data.accountVerified ? t(key('verified')) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <ObservationStamp value={detail.data} />
              </div>
              <div className="ow-detail-content">
                {tab === 'inventory' ? (
                  <Inventory p={data} />
                ) : (
                  <PlayerMetrics p={data} tab={tab} />
                )}
              </div>
              {account && (
                <button
                  type="button"
                  className="secondary ow-open-save"
                  onClick={() => onOpenSaved(account)}
                >
                  {t(key('openSave'))}
                </button>
              )}
            </>
          )}
        </>
      )}
    </Dialog>
  );
}
function Inventory({ p }: { p: PlayerDetail }) {
  const t = useT(),
    f = useMetricsFormat(),
    inv = p.inventory;
  if (!inv || p.inventoryKnown === false)
    return <p className="ow-empty">{t(key('inventoryUnknown'))}</p>;
  return (
    <>
      {numeric(inv.reportedAgoS) && (
        <p className="muted">{t(key('inventoryAge'), { age: f.duration(inv.reportedAgoS) })}</p>
      )}
      {(['hotbar', 'bag'] as const).map((group) => (
        <section key={group}>
          <h3>{t(key(group))}</h3>
          <ol className="ow-slots" aria-label={t(key(group))}>
            {inv[group].map((item, i) => {
              const slotNumber = i + 1;
              const selected = group === 'hotbar' && inv.selected === i;
              return (
                <li
                  key={slotNumber}
                  className={selected ? 'ow-selected' : ''}
                  aria-label={`${slotNumber} · ${item?.name ?? t(key('emptySlot'))}${selected ? ` · ${t(key('selected'))}` : ''}`}
                >
                  <small>
                    {slotNumber}
                    {selected && ' ▸'}
                  </small>
                  <span>{item?.name ?? '—'}</span>
                  {item?.count != null && item.count > 1 && <b>×{f.metric(item.count)}</b>}
                  {numeric(item?.wearPct) && (
                    <small>{t(key('wear'), { value: f.metric(item.wearPct, '%') })}</small>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </>
  );
}

function PlayerMetrics({ p, tab }: { p: PlayerDetail; tab: 'character' | 'network' | 'activity' }) {
  const t = useT(),
    f = useMetricsFormat(),
    mode = useMode();
  const pair = (a: unknown, b: unknown) =>
    numeric(a) && numeric(b) ? `${f.metric(a)} / ${f.metric(b)}` : f.metric(a);
  if (tab === 'network')
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
  if (tab === 'activity') {
    const r = p.record;
    if (!r) return <p className="ow-empty">{t(key('detailedMetricsUnavailable'))}</p>;
    return (
      <Metrics
        items={[
          [
            t(key('firstSeen')),
            numeric(r.firstSeenMs) &&
            r.firstSeenMs > 0 &&
            Number.isFinite(new Date(r.firstSeenMs).getTime())
              ? f.date(new Date(r.firstSeenMs))
              : '—',
          ],
          [t(key('logins')), f.metric(r.joins)],
          [t(key('playtime')), f.duration(r.playSeconds)],
          [t(key('distance')), f.metric(r.walkedMeters, 'm', 0)],
          [t(key('placed')), f.metric(r.blocksPlaced)],
          [t(key('broken')), f.metric(r.blocksBroken)],
          [t(key('kills')), f.metric(r.creatureKills)],
          [t(key('deaths')), f.metric(r.deaths)],
        ]}
      />
    );
  }
  return (
    <>
      <Metrics
        items={[
          [t(key('mode')), mode(p.mode)],
          [t(key('session')), f.duration(p.connectedS)],
          [t(key('health')), pair(p.vitals?.health, p.vitals?.maxHealth)],
          [t(key('hunger')), pair(p.vitals?.hunger, p.vitals?.maxHunger)],
          [t(key('air')), pair(p.vitals?.air, p.vitals?.maxAir)],
          [t(key('saturation')), f.metric(p.vitals?.saturation)],
          [t(key('held')), p.heldItem?.name || '—'],
          [t(key('latitude')), f.metric(p.geo?.lat, '°', 4)],
          [t(key('longitude')), f.metric(p.geo?.lon, '°', 4)],
          [t(key('altitude')), f.metric(p.geo?.alt, 'm', 0)],
          ...(p.pos && [p.pos.x, p.pos.y, p.pos.z].some(numeric)
            ? [
                [
                  t(key('localPosition')),
                  [p.pos.x, p.pos.y, p.pos.z].map((v) => f.metric(v, '', 2)).join(', '),
                ] as [string, string],
              ]
            : []),
          ...(p.account ? [[t(key('account')), p.account] as [string, string]] : []),
        ]}
      />
      {p.armor?.some(Boolean) && (
        <section>
          <h3>{t(key('equipment'))}</h3>
          <ul className="ow-armor">
            {p.armor.map(
              (a, i) =>
                a && (
                  <li key={a.slot ?? i}>
                    <strong>{a.name || '—'}</strong>
                    {numeric(a.wearPct) && (
                      <small>{t(key('wear'), { value: f.metric(a.wearPct, '%') })}</small>
                    )}
                  </li>
                ),
            )}
          </ul>
        </section>
      )}
    </>
  );
}
