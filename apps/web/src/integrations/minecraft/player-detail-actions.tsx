import {
  createMinecraftUiController,
  type MinecraftPlayerDetailAction,
} from '@nickhosting/minecraft/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { useUnsavedChanges } from '../../components/navigation-guard.js';
import { Check, ConfirmDialog, ErrorNotice, Input, Loading, Select } from '../../components/ui.js';
import { gameUiClient } from '../../features/integrations.js';

const controller = createMinecraftUiController(gameUiClient);
export type PlayerGameplayAction = MinecraftPlayerDetailAction['action'];
export type PlayerGameMode = Extract<MinecraftPlayerDetailAction, { action: 'gamemode' }>['mode'];
export type PlayerActionSelection = {
  uuid: string;
  action: PlayerGameplayAction;
  mode?: PlayerGameMode;
};
export function PlayerGameplayActionDialog({
  serverId,
  selection,
  permissionKeys,
  pending,
  onClose,
  onChanged,
}: {
  serverId: string;
  selection?: PlayerActionSelection;
  permissionKeys: readonly string[];
  pending: boolean;
  onClose(): void;
  onChanged(): Promise<unknown>;
}) {
  const t = useT();
  const k = (name: string) => `games.minecraft.players.${name}`;
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState<{
    uuid: string;
    name: string;
    action: PlayerGameplayAction;
    error: unknown;
  }>();
  const [refreshError, setRefreshError] = useState<unknown>();
  const [receipt, setReceipt] = useState<{
    uuid: string;
    name: string;
    action: PlayerGameplayAction;
    outcome: 'dispatched' | 'confirmed';
    operationId: string;
  }>();
  const [mode, setMode] = useState<'survival' | 'creative' | 'adventure' | 'spectator'>('survival');
  const [coordinates, setCoordinates] = useState({ x: '', y: '', z: '' });
  const [scopes, setScopes] = useState<('playerdata' | 'stats' | 'advancements')[]>([]);
  const lock = useRef(false);
  useUnsavedChanges(busy, busy);
  const detail = useQuery({
    queryKey: ['minecraft-player-detail', serverId, selection?.uuid],
    queryFn: ({ signal }) => controller.playerDetails(serverId, selection?.uuid ?? '', signal),
    enabled: Boolean(selection),
    retry: false,
    staleTime: 0,
  });
  useEffect(() => {
    if (!selection) return;
    setScopes([]);
    setCoordinates({ x: '', y: '', z: '' });
    setMode(selection.mode ?? 'survival');
  }, [selection]);
  const capability = detail.data?.capabilities.find((value) => value.action === selection?.action);
  const allowed = Boolean(
    selection &&
      permissionKeys.includes(`game.minecraft.players.${selection.action}`) &&
      capability?.available &&
      !detail.isError,
  );
  const invalidCoordinates = Object.entries(coordinates).some(
    ([axis, value]) =>
      !value.trim() ||
      !Number.isFinite(Number(value)) ||
      Math.abs(Number(value)) > (axis === 'y' ? 2048 : 29999984),
  );
  async function apply() {
    if (!selection || !allowed || !detail.data || pending || lock.current || uncertain) return;
    const { action, uuid } = selection;
    let input: MinecraftPlayerDetailAction;
    if (action === 'reset')
      input = { action, scopes, revision: detail.data.snapshot.revision, confirm: true };
    else if (action === 'teleport')
      input = {
        action,
        x: Number(coordinates.x),
        y: Number(coordinates.y),
        z: Number(coordinates.z),
      };
    else if (action === 'gamemode') input = { action, mode };
    else input = { action };
    const name = detail.data.player.name ?? uuid;
    lock.current = true;
    setBusy(true);
    try {
      const result = await controller.playerDetailAction(serverId, uuid, input);
      setReceipt({ uuid, name, action, outcome: result.outcome, operationId: result.operationId });
      onClose();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['minecraft-player-detail', serverId, uuid] }),
        onChanged(),
      ]).catch(setRefreshError);
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.code === 'operation_uncertain' ||
        error.status >= 500 ||
        error.status === 0
      ) {
        setUncertain({ uuid, name, action, error });
        onClose();
      } else throw error;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      {receipt && (
        <p role="status" className="minecraft-players-dispatched">
          <strong>{t(k('actionFor'), { action: t(k(receipt.action)), name: receipt.name })}</strong>{' '}
          <span>
            {t(k(receipt.outcome === 'confirmed' ? 'resetConfirmed' : 'gameplayDispatched'))}
          </span>{' '}
          {permissionKeys.includes('activity.read') && (
            <Link to={`/servers/${serverId}/activity`}>{t('web.viewActivity')}</Link>
          )}{' '}
          <small>{t(k('operationReference'), { id: receipt.operationId })}</small>
        </p>
      )}
      {uncertain && (
        <div>
          <p className="minecraft-players-dispatched">
            {t(k('uncertainAction'), { action: t(k(uncertain.action)), name: uncertain.name })}
          </p>
          <ErrorNotice error={uncertain.error} />
        </div>
      )}
      {Boolean(refreshError) && <ErrorNotice error={refreshError} />}
      <ConfirmDialog
        open={Boolean(selection)}
        title={selection ? t(k(selection.action)) : ''}
        confirmLabel={selection ? t(k(selection.action)) : undefined}
        destructive={Boolean(selection && ['starve', 'kill', 'reset'].includes(selection.action))}
        busy={busy}
        submitDisabled={
          pending ||
          !allowed ||
          Boolean(uncertain) ||
          Boolean(selection?.action === 'reset' && scopes.length === 0) ||
          Boolean(selection?.action === 'teleport' && invalidCoordinates)
        }
        onClose={() => {
          if (!lock.current) onClose();
        }}
        onConfirm={apply}
      >
        {detail.isPending && <Loading />}
        {detail.isError && <ErrorNotice error={detail.error} retry={() => void detail.refetch()} />}
        {selection && detail.data && (
          <>
            <p>
              {t(k(`confirm.${selection.action}`), {
                name: detail.data.player.name ?? detail.data.player.uuid,
              })}
            </p>
            {!allowed && capability?.reason && (
              <p className="muted">{t(k(`blocked.${capability.reason}`))}</p>
            )}
            {selection.action === 'gamemode' && selection.mode && (
              <p>{t(k(`mode.${selection.mode}`))}</p>
            )}
            {selection.action === 'gamemode' && !selection.mode && (
              <Select
                label={t(k('gamemode'))}
                value={mode}
                onChange={(event) => setMode(event.target.value as typeof mode)}
              >
                {(['survival', 'creative', 'adventure', 'spectator'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(k(`mode.${value}`))}
                  </option>
                ))}
              </Select>
            )}
            {selection.action === 'teleport' && (
              <div className="minecraft-player-coordinates">
                {(['x', 'y', 'z'] as const).map((axis) => (
                  <Input
                    key={axis}
                    label={axis.toUpperCase()}
                    type="number"
                    step="any"
                    min={axis === 'y' ? -2048 : -29999984}
                    max={axis === 'y' ? 2048 : 29999984}
                    value={coordinates[axis]}
                    onChange={(event) =>
                      setCoordinates({ ...coordinates, [axis]: event.target.value })
                    }
                  />
                ))}
              </div>
            )}
            {selection.action === 'reset' && (
              <div className="minecraft-player-reset-scopes">
                {(['playerdata', 'stats', 'advancements'] as const).map((scope) => (
                  <Check
                    key={scope}
                    label={t(k(`reset.${scope}`))}
                    checked={scopes.includes(scope)}
                    onChange={(event) =>
                      setScopes(
                        event.target.checked
                          ? [...scopes, scope]
                          : scopes.filter((value) => value !== scope),
                      )
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
