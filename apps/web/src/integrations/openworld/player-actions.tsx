import { type FormEvent, useRef, useState } from 'react';
import type {
  OpenworldActionPlayer,
  OpenworldPlayerAction,
  OpenworldTeleportDestinations,
} from '../../../../../games/openworld/src/player-actions.js';
import { ApiError, api } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { ErrorNotice, Input, Loading, Select, Textarea } from '../../components/ui.js';
import { playersBase, usePlayerResource } from './player-workspace.js';
import { key, type ServerView } from './telemetry.js';

type Kind = OpenworldPlayerAction['kind'];
export type ActionReceipt = { kind: Kind; playerName: string };
type Props = {
  server: ServerView;
  player: OpenworldActionPlayer;
  processRef: string;
  otherPlayers: OpenworldActionPlayer[];
  moderate: boolean;
  screenshots: boolean;
  onBusy: (value: boolean) => void;
  onAccepted: (receipt: ActionReceipt) => void;
};

const moderationActions: Kind[] = ['message', 'gamemode', 'teleport', 'respawn', 'kick', 'kill'];

export function PlayerActions(props: Props) {
  const t = useT();
  const allowed: Kind[] = [
    ...(props.moderate ? moderationActions : []),
    ...(props.screenshots ? ['screenshot' as const] : []),
  ];
  const [choice, setChoice] = useState<Kind>(allowed[0] ?? 'message');
  const [busy, setBusy] = useState(false);
  const kind = allowed.includes(choice) ? choice : allowed[0];
  if (!kind) return null;
  return (
    <div className="ow-actions">
      <Select
        label={t(key('action'))}
        value={kind}
        onChange={(e) => setChoice(e.target.value as Kind)}
        disabled={busy}
      >
        {allowed.map((k) => (
          <option value={k} key={k}>
            {t(key(`action.${k}`))}
          </option>
        ))}
      </Select>
      <ActionEditor
        {...props}
        key={kind}
        kind={kind}
        onBusy={(value) => {
          setBusy(value);
          props.onBusy(value);
        }}
      />
    </div>
  );
}

function ActionEditor({
  server,
  player,
  processRef,
  otherPlayers,
  kind,
  onBusy,
  onAccepted,
}: Props & { kind: Kind }) {
  const t = useT();
  const [targetType, setTargetType] = useState<'coordinates' | 'player' | 'checkpoint'>('player');
  const [target, setTarget] = useState<OpenworldActionPlayer | null>(null);
  const choices = usePlayerResource<OpenworldTeleportDestinations>(server, 'players/destinations', {
    enabled: kind === 'teleport' && targetType !== 'player',
  });
  const [message, setMessage] = useState('');
  const [prepared, setPrepared] = useState<OpenworldPlayerAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const sending = useRef(false);
  const targetMatches =
    target &&
    otherPlayers.some(
      (p) =>
        p.id === target.id &&
        p.name === target.name &&
        Math.abs(p.joinedAt - target.joinedAt) <= 5000,
    );
  const destinationReady =
    kind !== 'teleport' ||
    (targetType === 'player'
      ? !!targetMatches
      : !choices.error &&
        (targetType === 'coordinates'
          ? !!choices.data?.worlds.length
          : !!choices.data?.checkpoints.length));

  function fromForm(form: FormData): OpenworldPlayerAction | null {
    const field = (name: string) => String(form.get(name) ?? '').trim();
    switch (kind) {
      case 'message':
        return field('text') ? { kind, text: field('text') } : null;
      case 'kick':
        return { kind, ...(field('reason') ? { reason: field('reason') } : {}) };
      case 'gamemode':
        return { kind, mode: field('mode') as 'survival' | 'creative' | 'spectator' };
      case 'teleport':
        if (!destinationReady) return null;
        if (targetType === 'player')
          return targetMatches && target
            ? { kind, destination: { type: 'player', player: target } }
            : null;
        if (targetType === 'checkpoint')
          return field('checkpoint')
            ? { kind, destination: { type: 'checkpoint', id: Number(field('checkpoint')) } }
            : null;
        return {
          kind,
          destination: {
            type: 'coordinates',
            world: field('world'),
            lon: Number(field('lon')),
            lat: Number(field('lat')),
            alt: field('alt') ? Number(field('alt')) : null,
          },
        };
      default:
        return { kind };
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sending.current || !destinationReady || uncertain || wrongSession) return;
    const action = prepared ?? fromForm(new FormData(e.currentTarget));
    if (!action) return;
    if (!prepared && kind !== 'message') {
      setError(null);
      setPrepared(action);
      return;
    }
    sending.current = true;
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      const requestId = crypto.randomUUID();
      const receipt = await api<{ outcome: 'accepted'; requestId: string }>(
        `${playersBase(server.serverId)}/players/actions`,
        {
          method: 'POST',
          body: { requestId, processRef, player, action },
        },
      );
      if (receipt.outcome !== 'accepted' || receipt.requestId !== requestId)
        throw new ApiError('operation_uncertain', 'errors.operation_uncertain');
      onAccepted({ kind, playerName: player.name });
    } catch (e) {
      setError(
        e instanceof ApiError && !(e.code === 'internal_error' && e.status >= 500)
          ? e
          : new ApiError(
              'operation_uncertain',
              'errors.operation_uncertain',
              e instanceof ApiError ? e.requestId : undefined,
            ),
      );
    } finally {
      sending.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  const uncertain = error instanceof ApiError && error.code === 'operation_uncertain';
  const wrongSession =
    error instanceof ApiError &&
    [
      'unauthenticated',
      'forbidden',
      'not_found',
      'conflict',
      'provenance_mismatch',
      'game_request_unsupported',
    ].includes(error.code);
  return (
    <form className="ow-action-editor" onSubmit={submit} aria-busy={busy}>
      {error ? <ErrorNotice error={error} /> : null}
      <fieldset disabled={busy || !!prepared} hidden={!!prepared}>
        {kind === 'message' && (
          <Textarea
            autoComplete="off"
            label={t(key('privateMessage'))}
            name="text"
            required
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={240}
            rows={3}
          />
        )}
        {kind === 'kick' && (
          <Input name="reason" autoComplete="off" label={t(key('kickReason'))} maxLength={120} />
        )}
        {kind === 'gamemode' && (
          <Select label={t(key('mode'))} name="mode" required defaultValue="">
            <option value="" disabled>
              {t(key('chooseMode'))}
            </option>
            {['survival', 'creative', 'spectator'].map((m) => (
              <option key={m} value={m}>
                {t(key(m === 'spectator' ? 'spectre' : m))}
              </option>
            ))}
          </Select>
        )}
        {kind === 'teleport' && (
          <>
            <Select
              label={t(key('destination'))}
              value={targetType}
              onChange={(e) => setTargetType(e.target.value as typeof targetType)}
            >
              {(['player', 'coordinates', 'checkpoint'] as const).map((d) => (
                <option key={d} value={d}>
                  {t(key(`destination.${d}`))}
                </option>
              ))}
            </Select>
            {targetType === 'player' ? (
              otherPlayers.length ? (
                <Select
                  label={t(key('targetPlayer'))}
                  required
                  value={targetMatches && target ? target.id : ''}
                  onChange={(e) =>
                    setTarget(otherPlayers.find((p) => p.id === Number(e.target.value)) ?? null)
                  }
                >
                  <option value="" disabled>
                    {t(key('choosePlayer'))}
                  </option>
                  {otherPlayers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <p>{t(key('noTargetPlayers'))}</p>
              )
            ) : choices.error ? (
              <ErrorNotice error={choices.error} retry={() => void choices.refetch()} />
            ) : !choices.data ? (
              <Loading />
            ) : targetType === 'checkpoint' ? (
              choices.data.checkpoints.length ? (
                <Select label={t(key('checkpoint'))} name="checkpoint" required defaultValue="">
                  <option value="" disabled>
                    {t(key('chooseCheckpoint'))}
                  </option>
                  {choices.data.checkpoints.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.world}
                    </option>
                  ))}
                </Select>
              ) : (
                <p>{t(key('noCheckpoints'))}</p>
              )
            ) : choices.data.worlds.length ? (
              <>
                <Select label={t(key('world'))} name="world" required defaultValue="">
                  <option value="" disabled>
                    {t(key('chooseWorld'))}
                  </option>
                  {choices.data.worlds.map((w) => (
                    <option key={w.key} value={w.key}>
                      {w.name || w.key}
                    </option>
                  ))}
                </Select>
                <div className="ow-coordinates">
                  <Input
                    label={`${t(key('latitude'))} (°)`}
                    name="lat"
                    type="number"
                    step="any"
                    min={-90}
                    max={90}
                    required
                  />
                  <Input
                    label={`${t(key('longitude'))} (°)`}
                    name="lon"
                    type="number"
                    step="any"
                    min={-180}
                    max={180}
                    required
                  />
                  <Input label={t(key('optionalAltitude'))} name="alt" type="number" step="any" />
                </div>
              </>
            ) : (
              <p>{t(key('noWorlds'))}</p>
            )}
          </>
        )}
        {kind === 'screenshot' && <p className="muted">{t(key('screenshotHelp'))}</p>}
      </fieldset>
      {prepared && (
        <div className="ow-action-review">
          <strong>{t(key(`confirm.${kind}`), { name: player.name })}</strong>
          {prepared.kind === 'kick' && prepared.reason && <p>{prepared.reason}</p>}
          {prepared.kind === 'gamemode' && (
            <p>{t(key(prepared.mode === 'spectator' ? 'spectre' : prepared.mode))}</p>
          )}
          {prepared.kind === 'teleport' && (
            <p>
              {prepared.destination.type === 'player'
                ? prepared.destination.player.name
                : prepared.destination.type === 'coordinates'
                  ? [
                      prepared.destination.world,
                      `${prepared.destination.lat}°`,
                      `${prepared.destination.lon}°`,
                      prepared.destination.alt != null
                        ? `${prepared.destination.alt} m`
                        : t(key('ground')),
                    ].join(' · ')
                  : choices.data?.checkpoints.find(
                      (c) =>
                        prepared.destination.type === 'checkpoint' &&
                        c.id === prepared.destination.id,
                    )?.name}
            </p>
          )}
        </div>
      )}
      <div className="ow-action-footer">
        {prepared && !busy && !uncertain && (
          <button
            className="secondary"
            type="button"
            onClick={() => {
              setPrepared(null);
              setError(null);
            }}
          >
            {t('web.back')}
          </button>
        )}
        <button
          className={prepared && (kind === 'kick' || kind === 'kill') ? 'danger' : undefined}
          type="submit"
          disabled={
            busy ||
            !destinationReady ||
            uncertain ||
            wrongSession ||
            (kind === 'message' && !message.trim())
          }
        >
          {t(key(prepared || kind === 'message' ? `action.${kind}` : 'reviewAction'))}
        </button>
      </div>
    </form>
  );
}
