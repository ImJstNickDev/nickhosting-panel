import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import {
  type BannedPlayer,
  type BannedPlayersView,
  type ModerationChange,
  moderationPlayerName,
  moderationReason,
  type PlayerMembershipView,
  type PlayerRoleView,
} from '../../../../../games/openworld/src/player-moderation.js';
import { ApiError, api } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { Dialog, ErrorNotice, Input, Loading, Select } from '../../components/ui.js';
import { Pagination } from '../../components/workspace-controls.js';
import { PlayerActionToast } from './player-action-toast.js';
import type { ActionReceipt } from './player-actions.js';
import { PlayerArt, people } from './player-identity.js';
import { playerPath } from './player-navigation.js';
import { playersBase, usePlayerResource } from './player-workspace.js';
import { key, type ServerView } from './telemetry.js';
import './player-moderation.css';

type Mode = 'ban' | 'role' | 'member';
type Subject = { account: string; name: string; online: boolean };
type Server = ServerView & { permissionKeys: readonly string[] };
const base = 'players/moderation';
const banKey = 'game.openworld.bans.manage';
const groupKey = 'game.openworld.roles.manage';
const territoryKey = 'game.openworld.territory.manage';
export const canManagePlayerAccess = (keys: readonly string[]) =>
  [banKey, groupKey, territoryKey].some((k) => keys.includes(k));

function AccessEditor({
  server,
  subject,
  mode,
  onClose,
  onMode,
  onAccepted,
}: {
  server: Server;
  subject: Subject;
  mode: Mode;
  onClose: () => void;
  onMode?: (mode: Mode) => void;
  onAccepted: (r: ActionReceipt) => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [role, setRole] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dispatching = useRef(false);
  const { name, account } = subject;
  const bans = usePlayerResource<BannedPlayersView>(server, `${base}/bans`, {
    enabled: mode === 'ban',
  });
  const groups = usePlayerResource<PlayerRoleView>(
    server,
    `${base}/roles/${encodeURIComponent(account)}`,
    { enabled: mode === 'role' },
  );
  const zones = usePlayerResource<PlayerMembershipView>(
    server,
    `${base}/zones/${encodeURIComponent(account)}`,
    { enabled: mode === 'member' },
  );
  const resource = mode === 'ban' ? bans : mode === 'role' ? groups : zones;
  const data = resource.error ? undefined : resource.data;
  const match = bans.data?.bans.find((b) => b.uuid.toLowerCase() === account.toLowerCase());
  const selectedZone = zones.data?.zones.find((z) => String(z.id) === zoneId);
  const canCreate =
    server.permissionKeys.includes('game.openworld.players.moderate') &&
    server.permissionKeys.includes(banKey);
  const canName = moderationPlayerName.safeParse(name).success;
  const command: ModerationChange | null =
    mode === 'ban'
      ? match
        ? { kind: 'unban', account }
        : { kind: 'ban', account, name, reason: reason.trim() }
      : mode === 'role' && groups.data && role && role !== groups.data.current
        ? { kind: 'role', account, name, role, previous: groups.data.current }
        : mode === 'member' && selectedZone
          ? {
              kind: 'member',
              account,
              name,
              zone: selectedZone.name,
              zoneId: selectedZone.id,
              member: !selectedZone.member,
            }
          : null;
  const allowed =
    !!command &&
    (command.kind === 'ban'
      ? subject.online &&
        canName &&
        canCreate &&
        bans.data?.onlineBan &&
        moderationReason.safeParse(reason).success
      : data?.mutable && (command.kind === 'unban' || canName));
  const title = t(people(mode === 'ban' ? (match ? 'liftBan' : 'accountBan') : 'serverAccess'));
  const locked =
    error instanceof ApiError &&
    ['operation_uncertain', 'conflict', 'forbidden', 'not_found', 'game_not_ready'].includes(
      error.code,
    );
  async function submit() {
    if (!allowed || !data || !command || dispatching.current || locked) return;
    setBusy(true);
    dispatching.current = true;
    setError(null);
    try {
      const requestId = crypto.randomUUID();
      const receipt = await api<{ outcome: string; requestId: string }>(
        `${playersBase(server.serverId)}/${base}`,
        { body: { requestId, processRef: data.processRef, action: command } },
      );
      if (receipt.outcome !== 'accepted' || receipt.requestId !== requestId)
        throw new ApiError('operation_uncertain', 'errors.operation_uncertain');
      onAccepted({ kind: command.kind, requestId, playerName: name });
    } catch (e) {
      setError(
        e instanceof ApiError && e.status < 500
          ? e
          : new ApiError(
              'operation_uncertain',
              'errors.operation_uncertain',
              e instanceof ApiError ? e.requestId : undefined,
            ),
      );
    } finally {
      dispatching.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      closeIcon
      className="ow-player-command-dialog ow-access-dialog"
      title={title}
      onClose={onClose}
      closeDisabled={busy}
      initialFocusSelector=".dialog-close-icon"
    >
      <form
        className="ow-access-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="ow-access-person">
          <PlayerArt name={name} serverId={server.serverId} session={null} />
          <div>
            <strong>{name}</strong>
            <small>{account}</small>
          </div>
        </div>
        {mode !== 'ban' &&
          onMode &&
          server.permissionKeys.includes(groupKey) &&
          server.permissionKeys.includes(territoryKey) && (
            <fieldset className="ow-switcher">
              <legend className="visually-hidden">{t(people('serverAccess'))}</legend>
              {(['role', 'member'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={busy}
                  aria-pressed={mode === value}
                  onClick={() => onMode(value)}
                >
                  {t(people(value === 'role' ? 'assignGroup' : 'zoneAccess'))}
                </button>
              ))}
            </fieldset>
          )}
        {resource.error ? (
          <ErrorNotice error={resource.error} retry={() => void resource.refetch()} />
        ) : !data ? (
          <Loading />
        ) : (
          <>
            {mode === 'ban' &&
              (match ? (
                <p>{match.reason || t(people('noBanReason'))}</p>
              ) : !canCreate ? (
                <p>{t(people('notBanned'))}</p>
              ) : !subject.online ? (
                <p>{t(people('banNeedsOnline'))}</p>
              ) : (
                <Input
                  label={t(people('banReason'))}
                  value={reason}
                  maxLength={120}
                  aria-invalid={!moderationReason.safeParse(reason).success}
                  hint={
                    moderationReason.safeParse(reason).success
                      ? undefined
                      : t(people('reasonFormat'))
                  }
                  onChange={(e) => setReason(e.target.value)}
                />
              ))}
            {mode === 'role' && groups.data && (
              <Select
                label={t(people('assignedGroup'))}
                value={role || groups.data.current}
                onChange={(e) => setRole(e.target.value)}
              >
                {groups.data.roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </Select>
            )}
            {mode === 'member' &&
              zones.data &&
              (zones.data.zones.length ? (
                <Select
                  label={t(people('zone'))}
                  value={zoneId}
                  onChange={(e) => setZoneId(e.target.value)}
                >
                  <option value="">{t(people('pickZone'))}</option>
                  {zones.data.zones.map((z) => (
                    <option key={z.id} value={String(z.id)}>
                      {z.name} · {z.world}
                      {z.member ? ` · ${t(people('member'))}` : ''}
                    </option>
                  ))}
                </Select>
              ) : (
                <p>{t(people('noZones'))}</p>
              ))}
            {!(mode === 'ban' && !match ? bans.data?.onlineBan : data.mutable) && (
              <p className="muted">{t(people('unsupported'))}</p>
            )}
          </>
        )}
        {error != null && <ErrorNotice error={error} />}
        {data && (mode !== 'ban' || match || canCreate) && (
          <div className="ow-access-footer">
            <button
              type="submit"
              className={command?.kind === 'ban' ? 'danger' : undefined}
              disabled={!allowed || busy || locked}
            >
              {t(
                people(
                  mode === 'member'
                    ? selectedZone?.member
                      ? 'removeMembership'
                      : 'addMembership'
                    : mode === 'role'
                      ? 'saveGroup'
                      : match
                        ? 'liftBan'
                        : 'banPlayer',
                ),
              )}
            </button>
          </div>
        )}
      </form>
    </Dialog>
  );
}

export function ProfileAccess({
  server,
  subject,
  onAccepted,
}: {
  server: Server;
  subject: Subject;
  onAccepted: (r: ActionReceipt) => void;
}) {
  const t = useT(),
    [open, setOpen] = useState<Mode | null>(null);
  const groups = server.permissionKeys.includes(groupKey),
    zones = server.permissionKeys.includes(territoryKey),
    bans = server.permissionKeys.includes(banKey);
  const allowed = open === 'role' ? groups : open === 'member' ? zones : open === 'ban' && bans;
  const controls: [Mode, string, string][] = [];
  if (groups || zones)
    controls.push([
      groups ? 'role' : 'member',
      'serverAccess',
      'M4 6l8-3 8 3-8 3z M4 11l8 3 8-3 M4 16l8 3 8-3',
    ]);
  if (bans) controls.push(['ban', 'accountBan', 'M5 5l14 14 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0']);
  return (
    <>
      {controls.map(([mode, label, path]) => (
        <button
          type="button"
          className="secondary"
          key={mode}
          disabled={server.runtimeState !== 'running'}
          aria-haspopup="dialog"
          data-destructive={mode === 'ban' || undefined}
          onClick={() => setOpen(mode)}
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          >
            <path d={path} />
          </svg>
          {t(people(label))}
        </button>
      ))}
      {open && allowed && server.runtimeState === 'running' && (
        <AccessEditor
          key={open + subject.account}
          server={server}
          subject={subject}
          mode={open}
          onMode={setOpen}
          onClose={() => setOpen(null)}
          onAccepted={(r) => {
            setOpen(null);
            onAccepted(r);
          }}
        />
      )}
    </>
  );
}

export function BannedPlayers({
  server,
  q,
  inspect,
  page,
  setPage,
}: {
  server: Server;
  q: string;
  inspect: boolean;
  page: number;
  setPage: (p: number) => void;
}) {
  const t = useT();
  const list = usePlayerResource<BannedPlayersView>(server, `${base}/bans`, {
    enabled: server.runtimeState === 'running',
  });
  const [selected, setSelected] = useState<BannedPlayer | null>(null);
  const [receipt, setReceipt] = useState<ActionReceipt | null>(null);
  const dismiss = useCallback(() => setReceipt(null), []);
  if (server.runtimeState !== 'running')
    return <p className="ow-empty">{t(people('banListServerOff'))}</p>;
  if (list.error) return <ErrorNotice error={list.error} retry={() => void list.refetch()} />;
  if (!list.data) return <Loading />;
  const term = q.toLowerCase();
  const rows = list.data.bans
    .filter((b) => [b.uuid, b.name].some((s) => s.toLowerCase().includes(term)))
    .sort((a, b) => a.name.localeCompare(b.name) || a.uuid.localeCompare(b.uuid));
  const counts = new Map<string, number>();
  for (const { name } of list.data.bans)
    counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
  const pages = Math.max(1, Math.ceil(rows.length / 40)),
    current = Math.min(pages, page);
  return (
    <>
      <ul className="ow-roster ow-people-list ow-banned-list">
        {rows.slice((current - 1) * 40, current * 40).map((b) => {
          const person = (
            <>
              <PlayerArt name={b.name} serverId={server.serverId} session={null} />
              <span className="ow-person">
                <strong>{b.name}</strong>
                <small>{b.reason || t(people('noBanReason'))}</small>
                {(counts.get(b.name.toLowerCase()) ?? 0) > 1 && (
                  <small className="ow-uuid">{b.uuid}</small>
                )}
              </span>
            </>
          );
          return (
            <li key={b.uuid}>
              {inspect ? (
                <Link
                  className="ow-player-link"
                  to={playerPath(server.serverId, {
                    name: b.name,
                    account: b.uuid,
                    connection: null,
                  })}
                  state={{ owViewer: JSON.stringify(server.viewerScope), owName: b.name }}
                >
                  {person}
                </Link>
              ) : (
                <div className="ow-player-label">{person}</div>
              )}
              {list.data?.mutable && z.uuid().safeParse(b.uuid).success && (
                <button className="secondary" type="button" onClick={() => setSelected(b)}>
                  {t(people('liftBan'))}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {!rows.length && <p className="ow-empty">{t(q ? key('noMatch') : people('noBans'))}</p>}
      {pages > 1 && (
        <Pagination
          label={t(people('banned'))}
          previousLabel={t('web.previous')}
          nextLabel={t('web.next')}
          summary={t(key('pageNumber'), { page: current, total: pages })}
          canPrevious={current > 1}
          canNext={current < pages}
          onPrevious={() => setPage(current - 1)}
          onNext={() => setPage(current + 1)}
        />
      )}
      {selected && (
        <AccessEditor
          mode="ban"
          server={server}
          subject={{ account: selected.uuid, name: selected.name, online: false }}
          onClose={() => setSelected(null)}
          onAccepted={(r) => {
            setSelected(null);
            setReceipt(r);
            void list.refetch();
          }}
        />
      )}
      <PlayerActionToast receipt={receipt} onDismiss={dismiss} />
    </>
  );
}
