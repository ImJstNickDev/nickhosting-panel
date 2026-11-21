import { useEffect, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { ErrorNotice, Loading } from '../../components/ui.js';
import { Pagination, SearchField } from '../../components/workspace-controls.js';
import { playerSelectionFromMap } from './map-players.js';
import { PlayerGallery } from './player-gallery.js';
import {
  connection,
  type Player,
  PlayerArt,
  type Profile,
  people,
  samePlayer,
  usePlayerFormat,
  verifiedAccount,
} from './player-identity.js';
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
  const [gallery, setGallery] = useState(false);
  const [watchUntil, setWatchUntil] = useState(0);
  const [search, setSearch] = useState('');
  const [q, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Profile | null>(() => {
    const session = inspect && mapAccess ? playerSelectionFromMap() : null;
    return session ? { connection: session, name: session.name, account: null } : null;
  });
  const galleryOpen = gallery && screenshots;
  const showHistory = inspect && filter === 'all';
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
  const openLive = (p: Player) => {
    const account = inspect ? verifiedAccount(p) : null;
    const multiple = account && (sessionsByAccount.get(account)?.length ?? 0) > 1;
    setSelected({ name: p.name, account, connection: multiple ? null : sessionFor(p) });
  };
  const pinned = selected?.connection;
  const matching =
    pinned && current
      ? live.find(
          (p) =>
            samePlayer(sessionFor(p), pinned) &&
            (!selected.account || !verifiedAccount(p) || verifiedAccount(p) === selected.account),
        )
      : undefined;
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
  return (
    <div className="ow-workspace ow-people">
      {galleryOpen ? (
        <>
          <div>
            <button type="button" className="secondary" onClick={() => setGallery(false)}>
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
                <button type="button" className="secondary" onClick={() => setGallery(true)}>
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
              const sessions = sessionsByAccount.get(verifiedAccount(p) ?? '') ?? [];
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
              return (
                <li key={`session/${p.id}/${p.name}`}>
                  {canOpen && current ? (
                    <button type="button" className="ow-player-link" onClick={() => openLive(p)}>
                      {identity}
                    </button>
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
              return (
                <li key={`account/${row.uuid}`}>
                  <button
                    className="ow-player-link"
                    type="button"
                    onClick={() =>
                      online
                        ? openLive(online)
                        : setSelected({
                            name: row.name || row.uuid,
                            account: row.uuid,
                            connection: null,
                          })
                    }
                  >
                    <PlayerArt
                      name={row.name ?? row.uuid}
                      serverId={props.serverId}
                      session={online ? sessionFor(online) : null}
                      hash={online?.skinHash}
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
                  </button>
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
      {!galleryOpen && selected && canOpen && (inspect || selected.connection) && (
        <PlayerProfile
          server={props}
          selected={selected}
          connected={matching}
          accountSessions={
            (inspect && selected.account ? sessionsByAccount.get(selected.account) : undefined) ??
            []
          }
          onChooseSession={(p) =>
            setSelected({ ...selected, name: p.name, connection: sessionFor(p) })
          }
          onIdentify={(id) =>
            setSelected((previous) =>
              previous && !previous.account ? { ...previous, account: id } : previous,
            )
          }
          version={observation?.gameVersion}
          pendingRoster={roster.isPending}
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
          onServerGallery={() => {
            setSelected(null);
            setGallery(true);
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
