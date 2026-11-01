import { createMinecraftUiController } from '@nickhosting/minecraft/ui';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { ApiError, idempotencyKey } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { Check, ConfirmDialog, ErrorNotice, Input, Select } from '../../components/ui.js';
import {
  IconAction,
  Pagination,
  SearchField,
  Switch,
} from '../../components/workspace-controls.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import { gameUiClient } from '../../features/integrations.js';
import { MinecraftPlayerAvatar } from './player-avatar.js';
import { PlayerCard } from './player-card.js';
import { MinecraftPlayerDetailView } from './player-detail.js';
import { type PlayerActionSelection, PlayerGameplayActionDialog } from './player-detail-actions.js';
import { PlayerIcon as Icon } from './player-icons.js';
import { type MinecraftPlayerRow, mergeMinecraftPlayers } from './players-model.js';
import './players.css';

const controller = createMinecraftUiController(gameUiClient);
const key = (name: string) => `games.minecraft.players.${name}`;
type Snapshot = Awaited<ReturnType<typeof controller.players>>;
type VerifiedPlayer = Awaited<ReturnType<typeof controller.player>>;
type Action =
  | 'op'
  | 'deop'
  | 'whitelist-add'
  | 'whitelist-remove'
  | 'whitelist-on'
  | 'whitelist-off'
  | 'ban'
  | 'pardon'
  | 'kick'
  | 'edit-operator';
type DispatchReceipt = { action: Action; name?: string; uuid?: string };
type Filter = 'all' | 'online' | 'operators' | 'whitelist' | 'banned';
const filters: Filter[] = ['all', 'online', 'operators', 'whitelist', 'banned'];

export function MinecraftPlayersSection(props: GameSectionViewProps) {
  const t = useT();
  const detailUuid = useParams()['*'] ?? '';
  const [gameplaySelection, setGameplaySelection] = useState<PlayerActionSelection>();
  const returnFocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!detailUuid && returnFocus.current) {
      const uuid = returnFocus.current;
      returnFocus.current = undefined;
      requestAnimationFrame(() =>
        document.querySelector<HTMLAnchorElement>(`a[data-player-id="${uuid}"]`)?.focus(),
      );
    }
  }, [detailUuid]);
  const id = useId();
  const snapshot = props.data.metadata?.players as Snapshot | undefined;
  const running = props.runtimeState === 'running';
  const offline = ['offline', 'stopped'].includes(props.runtimeState);
  const supported = Boolean(snapshot?.supported && snapshot.installed);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [uncertainError, setUncertainError] = useState<unknown>();
  const [adding, setAdding] = useState(false);
  const [username, setUsername] = useState('');
  const [verified, setVerified] = useState<VerifiedPlayer>();
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<unknown>();
  const [invalidName, setInvalidName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>();
  const [selection, setSelection] = useState<{
    action: Action;
    player?: MinecraftPlayerRow;
    requestKey: string;
    runtime: string;
  }>();
  const [dispatched, setDispatched] = useState<DispatchReceipt>();
  const currentReceipt = useRef<DispatchReceipt | undefined>(undefined);
  const updateDispatched = useCallback((receipt: DispatchReceipt | undefined) => {
    currentReceipt.current = receipt;
    setDispatched(receipt);
  }, []);
  const [reason, setReason] = useState('');
  const [level, setLevel] = useState(4);
  const [bypass, setBypass] = useState(false);
  const lookupRequest = useRef<AbortController | undefined>(undefined);
  const lookupInput = useRef<HTMLInputElement>(null);
  const mutationLock = useRef(false);
  const can = (action: Action) =>
    props.permissionKeys.includes(
      `game.minecraft.players.${action.startsWith('whitelist-') ? 'whitelist' : ['op', 'deop', 'edit-operator'].includes(action) ? 'op' : ['ban', 'pardon'].includes(action) ? 'ban' : 'kick'}`,
    );
  const disabled =
    !props.canManage ||
    !supported ||
    props.pending ||
    busy ||
    Boolean(uncertainError) ||
    (!running && !offline);
  const online = useQuery({
    queryKey: ['minecraft-online-players', props.serverId],
    queryFn: ({ signal }) => controller.onlinePlayers(props.serverId, signal),
    enabled: supported && running,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const onlineAvailable = running && !online.isError && online.data?.state === 'available';
  const rows = useMemo(
    () =>
      snapshot
        ? mergeMinecraftPlayers(snapshot, onlineAvailable ? (online.data?.players ?? []) : [])
        : [],
    [snapshot, onlineAvailable, online.data],
  );
  const matches = (row: MinecraftPlayerRow, selected: Filter) =>
    selected === 'all' ||
    (selected === 'online'
      ? row.online
      : selected === 'operators'
        ? Boolean(row.operator)
        : selected === 'whitelist'
          ? row.whitelisted
          : Boolean(row.banned));
  const visible = rows.filter(
    (row) => matches(row, filter) && row.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const lastPage = Math.max(0, Math.ceil(visible.length / 50) - 1);
  const currentPage = Math.min(page, lastPage);
  const pageRows = visible.slice(currentPage * 50, currentPage * 50 + 50);

  useEffect(() => () => lookupRequest.current?.abort(), []);
  useEffect(() => {
    if (selection && selection.runtime !== props.runtimeState) setSelection(undefined);
  }, [selection, props.runtimeState]);
  useEffect(() => {
    if (adding) lookupInput.current?.focus();
  }, [adding]);
  // A dispatch receipt is not an acknowledgement. Clear it only when saved server data agrees.
  useEffect(() => {
    if (!dispatched || currentReceipt.current !== dispatched || !snapshot) return;
    const contains = (players: readonly { name: string; uuid?: string }[]) =>
      players.some((player) =>
        dispatched.uuid
          ? player.uuid === dispatched.uuid
          : player.name.toLowerCase() === dispatched.name?.toLowerCase(),
      );
    const confirmed =
      dispatched.action === 'op'
        ? contains(snapshot.operators)
        : dispatched.action === 'deop'
          ? !contains(snapshot.operators)
          : dispatched.action === 'whitelist-add'
            ? contains(snapshot.whitelist)
            : dispatched.action === 'whitelist-remove'
              ? !contains(snapshot.whitelist)
              : dispatched.action === 'whitelist-on'
                ? snapshot.whitelistEnabled
                : dispatched.action === 'whitelist-off'
                  ? !snapshot.whitelistEnabled
                  : dispatched.action === 'ban'
                    ? contains(snapshot.banned)
                    : dispatched.action === 'pardon'
                      ? !contains(snapshot.banned)
                      : false;
    if (confirmed) {
      updateDispatched(undefined);
      setUncertainError(undefined);
    }
  }, [snapshot, dispatched, updateDispatched]);

  async function refresh(refreshOnline = true, receipt = dispatched) {
    setRefreshError(undefined);
    try {
      // Saved membership and the online roster are independent observations.
      const [, next] = await Promise.all([
        props.reload(),
        running && refreshOnline ? online.refetch({ throwOnError: true }) : undefined,
      ]);
      if (next) {
        if (
          receipt?.action === 'kick' &&
          currentReceipt.current === receipt &&
          next.data?.state === 'available' &&
          !next.data.players.some(
            (player) => player.name.toLowerCase() === receipt.name?.toLowerCase(),
          )
        ) {
          setUncertainError(undefined);
          updateDispatched(undefined);
        }
      }
    } catch (error) {
      setRefreshError(error);
    }
  }
  function choose(action: Action, player?: MinecraftPlayerRow) {
    if (disabled || !can(action) || player?.nameKnown === false) return;
    setReason('');
    setLevel(player?.operator?.level ?? 4);
    setBypass(player?.operator?.bypassesPlayerLimit ?? false);
    const target =
      offline && player
        ? {
            ...player,
            name:
              action === 'deop' || action === 'edit-operator'
                ? (player.operator?.name ?? player.name)
                : action === 'whitelist-remove'
                  ? (player.whitelistEntry?.name ?? player.name)
                  : player.name,
          }
        : player;
    setSelection({
      action,
      player: target,
      requestKey: idempotencyKey(),
      runtime: props.runtimeState,
    });
  }
  async function lookup() {
    const name = username.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
      setInvalidName(true);
      return;
    }
    lookupRequest.current?.abort();
    const request = new AbortController();
    lookupRequest.current = request;
    setLookupBusy(true);
    setLookupError(undefined);
    setInvalidName(false);
    setVerified(undefined);
    try {
      const result = await controller.player(name, true, request.signal);
      if (!request.signal.aborted) setVerified(result);
    } catch (error) {
      if (!request.signal.aborted) setLookupError(error);
    } finally {
      if (!request.signal.aborted) setLookupBusy(false);
    }
  }
  async function apply() {
    if (
      !selection ||
      !can(selection.action) ||
      disabled ||
      mutationLock.current ||
      selection.runtime !== props.runtimeState ||
      (offline && ['ban', 'pardon', 'kick'].includes(selection.action)) ||
      (running && selection.action === 'edit-operator')
    )
      return;
    mutationLock.current = true;
    setBusy(true);
    const receipt: DispatchReceipt = {
      action: selection.action,
      ...(selection.player ? { name: selection.player.name, uuid: selection.player.uuid } : {}),
    };
    try {
      const { action, player } = selection;
      if (running && action !== 'edit-operator') {
        await controller.playerAction(props.serverId, {
          action,
          ...(player
            ? { name: player.name, ...(player.uuid ? { expectedUuid: player.uuid } : {}) }
            : {}),
          ...((action === 'ban' || action === 'kick') && reason.trim()
            ? { reason: reason.trim() }
            : {}),
        });
        updateDispatched(receipt);
      } else if (offline) {
        const command =
          action === 'whitelist-on' || action === 'whitelist-off'
            ? { kind: 'properties', changes: { 'white-list': action === 'whitelist-on' } }
            : {
                kind: 'player',
                name: player?.name,
                ...(player?.uuid ? { expectedUuid: player.uuid } : {}),
                list: ['op', 'deop', 'edit-operator'].includes(action) ? 'operators' : 'whitelist',
                action: ['deop', 'whitelist-remove'].includes(action) ? 'remove' : 'add',
                ...(['op', 'edit-operator'].includes(action)
                  ? { operatorLevel: level, bypassesPlayerLimit: bypass }
                  : {}),
              };
        const result = await controller.operate(props.serverId, selection.requestKey, command);
        props.onAccepted(result.jobId, { quickCompletion: true });
      }
      setSelection(undefined);
      setVerified(undefined);
      setUsername('');
      setAdding(false);
      if (running) await refresh(['kick', 'ban'].includes(selection.action), receipt);
    } catch (error) {
      if (
        running &&
        (!(error instanceof ApiError) ||
          error.code === 'operation_uncertain' ||
          error.status >= 500 ||
          error.status === 0)
      ) {
        setUncertainError(error);
        updateDispatched(receipt);
        setSelection(undefined);
      } else throw error;
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  const rowAction = (row: MinecraftPlayerRow, action: Action, detail = false) => {
    if (!can(action) || row.nameKnown === false) return null;
    const unavailable =
      ['kick', 'ban', 'pardon'].includes(action) &&
      (!running || (action === 'kick' && !row.online));
    const labelKey = detail
      ? ((
          { op: 'detailOp', kick: 'detailKick', ban: 'detailBan' } as Partial<
            Record<Action, string>
          >
        )[action] ?? action)
      : action;
    const icon = action.startsWith('whitelist-')
      ? 'whitelist'
      : action === 'edit-operator'
        ? 'edit'
        : ['op', 'deop'].includes(action)
          ? 'op'
          : action === 'kick'
            ? 'kick'
            : 'ban';
    return (
      <button
        type="button"
        className={`secondary${detail ? ' minecraft-player-access-action' : ''}${detail && ['kick', 'ban', 'pardon'].includes(action) ? ' minecraft-player-access-action--danger' : ''}`}
        key={action}
        aria-label={t(key('actionFor'), { action: t(key(labelKey)), name: row.name })}
        disabled={disabled || unavailable}
        onClick={() => {
          if (!unavailable) choose(action, row);
        }}
      >
        {detail && <Icon name={icon} />}
        {t(key(labelKey))}
      </button>
    );
  };
  const playerActions = (row: MinecraftPlayerRow, detail = false) =>
    props.canManage
      ? [
          rowAction(row, row.whitelisted ? 'whitelist-remove' : 'whitelist-add', detail),
          rowAction(row, row.operator ? 'deop' : 'op', detail),
          offline && row.operator && rowAction(row, 'edit-operator', detail),
          (detail || (running && row.online)) && rowAction(row, 'kick', detail),
          (detail || running) && rowAction(row, row.banned ? 'pardon' : 'ban', detail),
        ].filter(Boolean)
      : [];
  const candidate = verified
    ? (rows.find(
        (row) =>
          row.uuid === verified.uuid ||
          (!row.uuid && row.name.toLowerCase() === verified.name.toLowerCase()),
      ) ?? { name: verified.name, uuid: verified.uuid, online: false, whitelisted: false })
    : undefined;
  const status = !running
    ? t(key(offline ? 'offline' : 'transitioning'))
    : online.isPending
      ? t(key('onlineLoading'))
      : !onlineAvailable
        ? t(key('onlineUnavailable'))
        : undefined;

  if (!snapshot?.supported) return <p className="muted">{t(key('unsupported'))}</p>;
  if (!snapshot.installed) return <p className="muted">{t(key('notInstalled'))}</p>;

  return (
    <div
      className={`minecraft-players${detailUuid ? '' : ' workspace-surface'}`}
      aria-busy={props.pending || busy}
    >
      {detailUuid ? (
        <MinecraftPlayerDetailView
          serverId={props.serverId}
          uuid={detailUuid}
          row={rows.find((row) => row.uuid === detailUuid)}
          pending={disabled}
          permissionKeys={props.permissionKeys}
          legacyActions={(row) => playerActions(row, true)}
          onAction={(action, mode) =>
            setGameplaySelection({ uuid: detailUuid, action, ...(mode ? { mode } : {}) })
          }
          onBack={() => {
            returnFocus.current = detailUuid;
          }}
        />
      ) : (
        <>
          <div className="minecraft-players-toolbar">
            <SearchField
              label={t(key('search'))}
              placeholder={t(key('search'))}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
            />
            <div className="minecraft-players-controls">
              <Tooltip content={t(key('whitelistHelp'))}>
                <span>
                  <Switch
                    label={t(key('whitelistEnabled'))}
                    checked={snapshot.whitelistEnabled}
                    disabled={disabled || !can('whitelist-on')}
                    onChange={(checked) => choose(checked ? 'whitelist-on' : 'whitelist-off')}
                    stateLabel={t(key(snapshot.whitelistEnabled ? 'on' : 'off'))}
                  />
                </span>
              </Tooltip>
              <IconAction
                tooltip={t(key('refresh'))}
                label={t(key('refresh'))}
                disabled={busy || online.isFetching}
                onClick={() => void refresh()}
              >
                <Icon name="refresh" />
              </IconAction>
              {(can('whitelist-add') || can('op') || can('ban')) && (
                <button
                  type="button"
                  className="secondary minecraft-players-add"
                  disabled={disabled}
                  aria-expanded={adding}
                  aria-controls={`${id}-add`}
                  onClick={() => setAdding((current) => !current)}
                >
                  <Icon name="plus" />
                  {t(key('add'))}
                </button>
              )}
            </div>
          </div>
          {adding && (
            <div id={`${id}-add`} className="minecraft-players-add-panel">
              <div className="minecraft-players-lookup">
                <label htmlFor={`${id}-username`}>{t(key('username'))}</label>
                <div>
                  <input
                    ref={lookupInput}
                    id={`${id}-username`}
                    value={username}
                    maxLength={16}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    disabled={disabled}
                    aria-invalid={invalidName}
                    aria-describedby={invalidName ? `${id}-invalid-name` : undefined}
                    onChange={(event) => {
                      lookupRequest.current?.abort();
                      setLookupBusy(false);
                      setUsername(event.target.value);
                      setVerified(undefined);
                      setLookupError(undefined);
                      setInvalidName(false);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        if (!lookupBusy && !disabled) void lookup();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="secondary"
                    disabled={disabled || lookupBusy || !username.trim()}
                    onClick={() => void lookup()}
                  >
                    {t(lookupBusy ? 'web.pending' : key('lookup'))}
                  </button>
                </div>
              </div>
              {invalidName && (
                <p id={`${id}-invalid-name`} className="field-error" role="alert">
                  {t(key('invalidName'))}
                </p>
              )}
              {Boolean(lookupError) && <ErrorNotice error={lookupError} />}
              {verified && candidate && (
                <div className="minecraft-players-preview">
                  <MinecraftPlayerAvatar
                    name={verified.name}
                    avatar={verified.avatar}
                    uuid={verified.uuid}
                  />
                  <div className="minecraft-players-preview-name">
                    <strong>{verified.name}</strong>
                    <small>{t(key('verified'))}</small>
                  </div>
                  <div className="minecraft-players-preview-actions">
                    {!candidate.whitelisted && can('whitelist-add') && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={disabled}
                        onClick={() => choose('whitelist-add', candidate)}
                      >
                        {t(key('whitelist-add'))}
                      </button>
                    )}
                    {!candidate.operator && can('op') && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={disabled}
                        onClick={() => choose('op', candidate)}
                      >
                        {t(key('op'))}
                      </button>
                    )}
                    {running && !candidate.banned && can('ban') && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={disabled}
                        onClick={() => choose('ban', candidate)}
                      >
                        {t(key('ban'))}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          <fieldset className="minecraft-players-filters">
            <legend className="visually-hidden">{t(key('filters'))}</legend>
            {filters.map((item) => (
              <label key={item}>
                <input
                  type="radio"
                  name={`${id}-filter`}
                  value={item}
                  checked={filter === item}
                  onChange={() => {
                    setFilter(item);
                    setPage(0);
                  }}
                />
                <span>
                  {t(key(item))}
                  {(item !== 'online' || onlineAvailable) && (
                    <small>{rows.filter((row) => matches(row, item)).length}</small>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
          {!props.canManage && <p className="minecraft-players-status">{t(key('readOnly'))}</p>}
          {snapshot.knownPlayersState === 'unavailable' && (
            <p className="minecraft-players-status">{t(key('knownPlayersUnavailable'))}</p>
          )}
          {status && (
            <p className="minecraft-players-status" role="status">
              {status}
            </p>
          )}
          {dispatched && !uncertainError && (
            <p className="minecraft-players-dispatched" role="status">
              {t(key(dispatched.action === 'kick' ? 'kickDispatched' : 'dispatched'))}
            </p>
          )}
          {Boolean(uncertainError) && <ErrorNotice error={uncertainError} />}
          {Boolean(refreshError) && (
            <ErrorNotice error={refreshError} retry={() => void refresh()} />
          )}
          <ul className="minecraft-players-list" aria-label={t('games.minecraft.sections.players')}>
            {pageRows.map((row) => (
              <PlayerCard
                key={row.uuid ?? row.name.toLowerCase()}
                row={row}
                to={row.uuid ? `/servers/${props.serverId}/game/players/${row.uuid}` : undefined}
                hasActions={
                  row.nameKnown !== false &&
                  (can('op') ||
                    can('whitelist-add') ||
                    (running && (can('ban') || (row.online && can('kick')))))
                }
                actions={playerActions(row)}
                quickActions={
                  row.uuid &&
                  (['heal', 'feed'] as const).map(
                    (action) =>
                      props.permissionKeys.includes(`game.minecraft.players.${action}`) && (
                        <button
                          type="button"
                          className="secondary"
                          key={action}
                          disabled={disabled || !running || !row.online || row.nameKnown === false}
                          onClick={() => {
                            if (row.uuid) setGameplaySelection({ uuid: row.uuid, action });
                          }}
                        >
                          {t(key(action))}
                        </button>
                      ),
                  )
                }
              />
            ))}
            {visible.length === 0 && (
              <li className="minecraft-players-empty">
                {filter === 'online' && !onlineAvailable
                  ? status
                  : t(
                      key(
                        search.trim()
                          ? 'noMatches'
                          : filter === 'online'
                            ? 'onlineEmpty'
                            : filter === 'all'
                              ? 'empty'
                              : 'noMatches',
                      ),
                    )}
              </li>
            )}
          </ul>
          {lastPage > 0 && (
            <Pagination
              label={t(key('pagination'))}
              previousLabel={t(key('previous'))}
              nextLabel={t(key('next'))}
              summary={t(key('page'), { page: currentPage + 1, total: lastPage + 1 })}
              canPrevious={currentPage > 0}
              canNext={currentPage < lastPage}
              onPrevious={() => setPage(currentPage - 1)}
              onNext={() => setPage(currentPage + 1)}
            />
          )}
        </>
      )}
      {detailUuid && (
        <>
          {dispatched && !uncertainError && (
            <p className="minecraft-players-dispatched" role="status">
              {t(key(dispatched.action === 'kick' ? 'kickDispatched' : 'dispatched'))}
            </p>
          )}
          {Boolean(uncertainError) && <ErrorNotice error={uncertainError} />}
          {Boolean(refreshError) && (
            <ErrorNotice error={refreshError} retry={() => void refresh()} />
          )}
        </>
      )}
      <PlayerGameplayActionDialog
        serverId={props.serverId}
        selection={gameplaySelection}
        permissionKeys={props.permissionKeys}
        pending={props.pending || busy}
        onClose={() => setGameplaySelection(undefined)}
        onChanged={() => refresh()}
      />
      <ConfirmDialog
        open={Boolean(selection)}
        title={selection ? t(key(selection.action)) : ''}
        confirmLabel={selection ? t(key(selection.action)) : undefined}
        destructive={Boolean(
          selection &&
            ['ban', 'kick', 'deop', 'whitelist-remove', 'whitelist-off'].includes(selection.action),
        )}
        busy={
          props.pending ||
          busy ||
          !props.canManage ||
          Boolean(selection && !can(selection.action)) ||
          (!running && !offline)
        }
        onClose={() => {
          if (!mutationLock.current) setSelection(undefined);
        }}
        onConfirm={apply}
      >
        {selection && (
          <>
            <p>
              {t(key(`confirm.${selection.action}`), {
                name: selection.player?.name ?? '',
                server: props.serverName,
              })}
            </p>
            {snapshot.enforceWhitelist &&
              ['whitelist-on', 'whitelist-remove'].includes(selection.action) && (
                <p className="muted">{t(key('enforceWarning'))}</p>
              )}
            {['ban', 'kick'].includes(selection.action) && (
              <Input
                label={t(key('reason'))}
                value={reason}
                maxLength={160}
                onChange={(event) => setReason(event.target.value)}
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
              />
            )}
            {offline && ['op', 'edit-operator'].includes(selection.action) && (
              <details
                className="minecraft-player-advanced"
                open={selection.action === 'edit-operator' ? true : undefined}
              >
                <summary>{t(key('advanced'))}</summary>
                <Select
                  label={t(key('level'))}
                  value={level}
                  onChange={(event) => setLevel(Number(event.target.value))}
                >
                  {[1, 2, 3, 4].map((value) => (
                    <option key={value} value={value}>
                      {t(key(`level.${value}`))}
                    </option>
                  ))}
                </Select>
                <Check
                  label={t(key('bypass'))}
                  checked={bypass}
                  onChange={(event) => setBypass(event.target.checked)}
                />
              </details>
            )}
            {offline && <p className="muted">{t(key('offlineEdit'))}</p>}
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
