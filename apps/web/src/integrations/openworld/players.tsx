import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { useT } from '../../app/i18n.js';
import { ErrorNotice, Loading } from '../../components/ui.js';
import { Pagination, SearchField } from '../../components/workspace-controls.js';
import { PlayerGallery } from './player-gallery.js';
import {
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
import {
  playerPath,
  playersPath,
  profileFromRoute,
  sessionFromFragment,
} from './player-navigation.js';
import { PlayerProfile } from './player-profile.js';
import { useSavedDirectory } from './saved-players.js';
import {
  key,
  numeric,
  ObservationStamp,
  type TelemetryViewProps,
  useTelemetry,
  withTelemetrySession,
} from './telemetry.js';
import './player-profile.css';

export const OpenworldPlayers = withTelemetrySession(Players);

function Players(props: TelemetryViewProps) {
  const t = useT(),
    f = usePlayerFormat();
  const inspect = props.permissionKeys.includes('game.openworld.players.inspect');
  const moderate = props.permissionKeys.includes('game.openworld.players.moderate');
  const screenshots = props.permissionKeys.includes('game.openworld.players.screenshots');
  const mapAccess = props.permissionKeys.includes('game.openworld.map.read');
  const [filter, setFilter] = useState<'all' | 'online'>('all');
  const location = useLocation();
  const navigate = useNavigate();
  const detailPath = useParams()['*'] ?? '';
  const basePath = playersPath(props.serverId);
  const viewer = JSON.stringify(props.viewerScope);
  const foreignEntry = !!location.state?.owViewer && location.state.owViewer !== viewer;
  const legacySession =
    !detailPath && inspect && mapAccess ? sessionFromFragment(location.hash) : null;
  const legacy =
    legacySession?.processRef && legacySession.joinedAt !== null ? legacySession : null;
  const selected = foreignEntry ? null : profileFromRoute(detailPath, location.hash);
  const hasProfile = !!(detailPath || legacy);
  const lastRow = useRef<string | null>(null);
  const [watchUntil, setWatchUntil] = useState(0);
  const [search, setSearch] = useState('');
  const [q, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const galleryOpen = !detailPath && location.hash === '#screenshots' && screenshots;
  const showHistory = !hasProfile && inspect && filter === 'all';
  const roster = useTelemetry(props, 'players', 'players', !galleryOpen);
  const observation = !roster.error ? roster.data : undefined;
  const current = observation?.source === 'live' && props.runtimeState === 'running';
  const live = observation?.data?.players ?? [];
  const term = q.toLocaleLowerCase();
  const rows = live
    .filter(
      (p) =>
        p.name.toLocaleLowerCase().includes(term) ||
        (inspect && verifiedAccount(p)?.toLocaleLowerCase().includes(term)),
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  const exclude = current ? [...new Set(rows.flatMap((p) => verifiedAccount(p) ?? []))].sort() : [];
  const saved = useSavedDirectory(
    props,
    showHistory && !galleryOpen && (props.runtimeState !== 'running' || !roster.isPending),
    q,
    page,
    exclude,
  );
  useEffect(() => {
    const id = lastRow.current;
    if (hasProfile || !id) return;
    const target = document.querySelector<HTMLAnchorElement>(
      `[data-ow-player="${CSS.escape(id)}"]`,
    );
    if (!target && (roster.isPending || (showHistory && saved.isPending))) return;
    lastRow.current = null;
    target?.focus();
  }, [hasProfile, roster.isPending, showHistory, saved.isPending]);
  const history = showHistory && !saved.error ? saved.data : undefined;
  const pages = Math.max(1, Math.ceil((history?.total ?? 0) / 40));
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (history && page > pages) setPage(pages);
  }, [history, page, pages]);
  const sessionFor = (p: (typeof live)[number]) =>
    connection(
      p,
      observation?.observedAt ?? null,
      observation?.source === 'live' ? observation.processRef : undefined,
    );
  const sessionsByAccount = new Map<string, Player[]>();
  if (inspect && current)
    for (const p of live) {
      const account = verifiedAccount(p);
      if (!account) continue;
      const list = sessionsByAccount.get(account);
      if (list) list.push(p);
      else sessionsByAccount.set(account, [p]);
    }
  const liveProfile = (p: Player): Profile => {
    const account = inspect ? verifiedAccount(p) : null;
    const multiple = account && (sessionsByAccount.get(account)?.length ?? 0) > 1;
    return { name: p.name, account, connection: current && !multiple ? sessionFor(p) : null };
  };
  const entryState = (p: Profile) => ({
    owViewer: viewer,
    owName: p.name,
    owVisit: playerPath(props.serverId, p),
  });
  const pinned = selected?.connection;
  const candidate =
    pinned && current ? live.find((p) => samePlayer(sessionFor(p), pinned)) : undefined;
  // Some server versions verify accounts only in the individual player response.
  // For a pinned account permalink, require that proof before exposing live controls.
  const needsIdentity = !!(
    inspect &&
    selected?.account &&
    candidate &&
    !verifiedAccount(candidate)
  );
  const proof = useTelemetry(
    props,
    'player',
    pinned ? `players/${pinned.id}?${playerParams(pinned)}` : 'players',
    needsIdentity,
  );
  const evidence =
    needsIdentity && !proof.error && proof.data?.source === 'live' ? proof.data : null;
  const detail = evidence?.data;
  const verifiedDetail =
    detail &&
    pinned &&
    samePlayer(
      pinned,
      connection(detail, evidence?.observedAt ?? null, evidence?.processRef ?? pinned.processRef),
    )
      ? verifiedAccount(detail)
      : null;
  const matching =
    candidate &&
    (!selected?.account || (verifiedAccount(candidate) ?? verifiedDetail) === selected.account)
      ? candidate
      : undefined;
  const profile = selected
    ? {
        ...selected,
        name:
          matching?.name ??
          selected.connection?.name ??
          (location.state?.owViewer === viewer && typeof location.state.owName === 'string'
            ? location.state.owName
            : null) ??
          selected.name,
      }
    : null;
  const targets = current
    ? live.flatMap((p) => {
        const session = sessionFor(p);
        return session.joinedAt !== null && p.id !== selected?.connection?.id
          ? [{ id: p.id, name: p.name, joinedAt: session.joinedAt }]
          : [];
      })
    : [];
  const shownSaved = new Set(history?.players.map((p) => p.uuid));
  const groups = new Map<string, Player>();
  for (const p of rows) {
    const account = inspect && verifiedAccount(p);
    if (!current && account && shownSaved.has(account)) continue;
    const identity = account ? `account/${account}` : `session/${p.id}`;
    if (!groups.has(identity)) groups.set(identity, p);
  }
  const explicitOnline = inspect && filter === 'online';
  const includeRoster = (!showHistory || page === 1) && (!explicitOnline || current);
  const rosterRows = includeRoster ? [...groups.values()] : [];
  const offlineRows = history?.players ?? [];
  const completeIdentities = current && live.every((p) => !!verifiedAccount(p));
  const canOpen = inspect || moderate || screenshots;
  const counts = new Map<string, number>();
  for (const row of [...rosterRows, ...offlineRows]) {
    if (row.name) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  if (inspect && galleryOpen) {
    for (const row of offlineRows) if (row.name) names.set(row.uuid, row.name);
    for (const p of live) {
      const account = verifiedAccount(p);
      if (account) names.set(account, p.name);
    }
  }
  const canRefresh = !roster.isFetching && (!showHistory || !saved.isFetching);
  const refresh = () => {
    void roster.refetch();
    if (showHistory) void saved.refetch();
  };
  const replaceProfile = (p: Profile) =>
    void navigate(playerPath(props.serverId, p), {
      replace: true,
      state: { ...entryState(p), owVisit: location.state?.owVisit ?? detailPath },
    });
  if (foreignEntry && detailPath) return <Navigate replace to={basePath} />;
  if (legacy) {
    const target = { name: legacy.name, account: null, connection: legacy };
    return <Navigate replace to={playerPath(props.serverId, target)} state={entryState(target)} />;
  }
  if (detailPath) {
    const allowed = canOpen && (!profile?.account || inspect);
    if (!profile || !allowed)
      return (
        <div className="ow-workspace">
          <Link to={basePath}>← {t(key('players'))}</Link>
          <p role="alert">{t(allowed ? 'web.errors.notFound' : 'errors.forbidden')}</p>
        </div>
      );
    if (profile.account && !profile.connection && !location.state?.owViewer && current) {
      const sessions = sessionsByAccount.get(profile.account);
      const member = sessions?.length === 1 ? sessions[0] : undefined;
      const bound = member
        ? { ...profile, name: member.name, connection: sessionFor(member) }
        : profile;
      return <Navigate replace to={playerPath(props.serverId, bound)} state={entryState(bound)} />;
    }
    return (
      <div className="ow-workspace ow-people">
        <PlayerProfile
          key={location.state?.owVisit ?? detailPath}
          server={props}
          selected={profile}
          connected={matching}
          accountSessions={
            (inspect && profile.account ? sessionsByAccount.get(profile.account) : undefined) ?? []
          }
          onChooseSession={(p) =>
            replaceProfile({ ...profile, name: p.name, connection: sessionFor(p) })
          }
          onIdentify={(id) => {
            if (!profile.account && profile.connection) replaceProfile({ ...profile, account: id });
          }}
          version={observation?.gameVersion}
          pendingRoster={roster.isPending || (needsIdentity && proof.isPending)}
          rosterReason={
            roster.error ? 'unreachable' : !current ? (observation?.reason ?? 'unavailable') : null
          }
          inspect={inspect}
          moderate={moderate}
          screenshots={screenshots}
          mapAccess={mapAccess}
          otherPlayers={targets}
          watchUntil={watchUntil}
          onRequestAccepted={(receipt) => {
            if (receipt.kind === 'screenshot') setWatchUntil(Date.now() + 30000);
            void roster.refetch();
          }}
          onServerGallery={() => void navigate(`${basePath}#screenshots`)}
          backTo={basePath}
        />
      </div>
    );
  }
  return (
    <div className="ow-workspace ow-people">
      {galleryOpen ? (
        <>
          <div>
            <button type="button" className="secondary" onClick={() => void navigate(basePath)}>
              {t('web.back')}
            </button>
          </div>
          <PlayerGallery
            server={props}
            accountNames={names}
            inspect={inspect}
            watchUntil={watchUntil}
          />
        </>
      ) : (
        <section className="ow-panel">
          <header className="ow-heading">
            <h2>{t(key('players'))}</h2>
            <div className="ow-people-commands">
              {screenshots && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void navigate(`${basePath}#screenshots`)}
                >
                  {t(people('serverGallery'))}
                </button>
              )}
              <button type="button" className="secondary" disabled={!canRefresh} onClick={refresh}>
                {t(key('refresh'))}
              </button>
            </div>
          </header>
          <div className="ow-directory-tools">
            {inspect && (
              <fieldset className="ow-switcher">
                <legend className="visually-hidden">{t(people('sessions'))}</legend>
                {(['all', 'online'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={filter === v}
                    onClick={() => {
                      setFilter(v);
                      setPage(1);
                    }}
                  >
                    {t(v === 'all' ? people('all') : key('connected'))}
                  </button>
                ))}
              </fieldset>
            )}
            <SearchField
              label={t(inspect ? people('search') : key('searchPlayers'))}
              maxLength={128}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="ow-directory-summary">
            {observation?.data && (!explicitOnline || current) && (
              <span className="ow-count">
                {t(current ? key('rosterCount') : people('observedCount'), { count: live.length })}
              </span>
            )}
            <ObservationStamp value={observation} />
          </div>
          {observation?.reason && (
            <p className="ow-observation-reason">{t(key(observation.reason))}</p>
          )}
          {roster.error && <ErrorNotice error={roster.error} retry={() => void roster.refetch()} />}
          {showHistory && saved.error && (
            <ErrorNotice error={saved.error} retry={() => void saved.refetch()} />
          )}
          {history?.indexing && (
            <p role="status" className="muted">
              {t(key('indexing'))}
            </p>
          )}
          {history?.stale && (
            <p role="status" className="ow-observation-reason">
              {t(key('directoryStale'), { time: f.stamp(history.indexedAt) })}
            </p>
          )}
          <ul className="ow-roster ow-people-list">
            {rosterRows.map((p) => {
              const session = sessionFor(p);
              const account = inspect ? verifiedAccount(p) : null;
              const sessions = sessionsByAccount.get(account ?? '') ?? [];
              const multiple = sessions.length > 1;
              const alternateNames = multiple
                ? [...new Set(sessions.map((s) => s.name))].filter((n) => n !== p.name)
                : [];
              const admitted = p.admitted === true || p.state === 'playing';
              const state = current
                ? !admitted && (p.admitted === false || p.state)
                  ? 'connecting'
                  : 'connected'
                : 'snapshot';
              const ambiguous = (counts.get(p.name) ?? 0) > 1;
              const identity = (
                <>
                  <PlayerArt
                    name={p.name}
                    serverId={props.serverId}
                    session={current ? session : null}
                    hash={p.skinHash}
                    savedSkin={account ? { account, hash: p.skinHash } : undefined}
                  />
                  <span className="ow-person">
                    <strong>{p.name}</strong>
                    <small>
                      <span className={`ow-presence ${current ? 'is-live' : ''}`}>
                        {t(state === 'snapshot' ? people('observed') : key(state))}
                      </span>
                      {[
                        '',
                        multiple ? t(key('rosterCount'), { count: sessions.length }) : p.world,
                        multiple
                          ? alternateNames.join(', ') || null
                          : p.mode
                            ? f.mode(p.mode)
                            : null,
                        ambiguous ? t(people('sessionId'), { id: p.id }) : null,
                      ]
                        .filter((v) => v != null)
                        .join(' · ')}
                    </small>
                  </span>
                </>
              );
              const target = liveProfile(p);
              return (
                <li key={`session/${p.id}/${p.name}`}>
                  {canOpen && (current || target.account) ? (
                    <Link
                      className="ow-player-link"
                      to={playerPath(props.serverId, target)}
                      state={entryState(target)}
                      data-ow-player={`live-${p.id}`}
                      onClick={() => {
                        lastRow.current = `live-${p.id}`;
                      }}
                    >
                      {identity}
                    </Link>
                  ) : (
                    <div className="ow-player-label">{identity}</div>
                  )}
                  {!multiple && (
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
                  )}
                </li>
              );
            })}
            {offlineRows.map((row) => {
              const alias = sessionsByAccount.get(row.uuid) ?? [];
              // Historical names can match a search even when the current name does not.
              const online = alias.length === 1 ? alias[0] : undefined;
              const canSayOffline =
                props.runtimeState === 'offline' ||
                (current && !alias.length && !row.uuid.startsWith('guest:') && completeIdentities);
              const date = numeric(row.lastSeenMs)
                ? f.stamp(row.lastSeenMs)
                : row.savedAt
                  ? f.stamp(row.savedAt)
                  : null;
              const target = online
                ? liveProfile(online)
                : { name: row.name || row.uuid, account: row.uuid, connection: null };
              return (
                <li key={`account/${row.uuid}`}>
                  <Link
                    className="ow-player-link"
                    to={playerPath(props.serverId, target)}
                    state={entryState(target)}
                    data-ow-player={`saved-${row.uuid}`}
                    onClick={() => {
                      lastRow.current = `saved-${row.uuid}`;
                    }}
                  >
                    <PlayerArt
                      name={row.name ?? row.uuid}
                      serverId={props.serverId}
                      session={online ? sessionFor(online) : null}
                      hash={online?.skinHash}
                      savedSkin={{ account: row.uuid, hash: row.skinHash }}
                    />
                    <span className="ow-person">
                      <strong>{row.name || row.uuid}</strong>
                      <small>
                        <span className={`ow-presence ${alias.length ? 'is-live' : ''}`}>
                          {t(
                            alias.length
                              ? key('connected')
                              : people(canSayOffline ? 'offlinePlayer' : 'saved'),
                          )}
                        </span>
                        {row.uuid.startsWith('guest:') && <> · {t(people('guest'))}</>}
                        {row.name && (counts.get(row.name) ?? 0) > 1 && (
                          <>
                            {' '}
                            · <span className="ow-uuid">{row.uuid}</span>
                          </>
                        )}
                        {online && row.name !== online.name && <> · {online.name}</>}
                      </small>
                    </span>
                  </Link>
                  {date && (
                    <span className="ow-directory-date">
                      {t(people(numeric(row.lastSeenMs) ? 'lastVisitAt' : 'lastSaveAt'), {
                        time: date,
                      })}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {roster.isPending || (showHistory && saved.isPending) ? (
            <Loading />
          ) : (
            (!explicitOnline || current || props.runtimeState === 'offline') &&
            !rosterRows.length &&
            !offlineRows.length &&
            !roster.error &&
            !(showHistory && saved.error) && (
              <p className="ow-empty">
                {t(
                  q
                    ? key('noMatch')
                    : showHistory
                      ? people('noPlayersYet')
                      : key(
                          observation?.source === 'snapshot' && !explicitOnline
                            ? 'noPlayersSnapshot'
                            : 'noPlayers',
                        ),
                )}
              </p>
            )
          )}
          {showHistory && pages > 1 && (
            <Pagination
              label={t(people('all'))}
              previousLabel={t('web.previous')}
              nextLabel={t('web.next')}
              summary={t(key('pageNumber'), { page, total: pages })}
              canPrevious={page > 1}
              canNext={page < pages}
              onPrevious={() => setPage((p) => p - 1)}
              onNext={() => setPage((p) => p + 1)}
            />
          )}
        </section>
      )}
    </div>
  );
}
