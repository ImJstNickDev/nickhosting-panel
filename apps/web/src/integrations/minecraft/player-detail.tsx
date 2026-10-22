import { createMinecraftUiController, type MinecraftPlayerDetail } from '@nickhosting/minecraft/ui';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useFormat, useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { ErrorNotice, Loading } from '../../components/ui.js';
import { gameUiClient } from '../../features/integrations.js';
import { MinecraftPlayerBody } from './player-body.js';
import { PlayerRoles } from './player-card.js';
import type { PlayerGameplayAction } from './player-detail-actions.js';
import { minecraftItemIcon, minecraftPlayerHudAsset } from './player-item-assets.js';
import { PlayerStatistics, readableMinecraftId } from './player-statistics.js';
import type { MinecraftPlayerRow } from './players-model.js';
import './player-detail.css';

const controller = createMinecraftUiController(gameUiClient);
const key = (name: string) => `games.minecraft.players.${name}`;
type Item = NonNullable<MinecraftPlayerDetail['inventory']>[number];

function ItemSlot({ slot, item, selected }: { slot: number; item?: Item; selected?: boolean }) {
  const t = useT();
  const description = item
    ? `${item.name ?? readableMinecraftId(item.id)} × ${item.count}`
    : t(key('slotEmpty'), { slot });
  const icon = item ? minecraftItemIcon(item.id) : undefined;
  const tooltip = [
    description,
    ...(item
      ? [
          item.id,
          ...(item.damage !== null ? [t(key('itemDamage'), { value: item.damage })] : []),
          ...item.enchantments.map((value) => `${value.id} ${value.level}`),
          ...(item.hasUnknownComponents ? [t(key('itemComponents'))] : []),
        ]
      : []),
  ].join(' · ');
  return (
    <Tooltip content={tooltip}>
      <span
        role="img"
        tabIndex={item ? 0 : undefined}
        className={`minecraft-item-slot${selected ? ' minecraft-item-slot--selected' : ''}${item ? ' minecraft-item-slot--filled' : ''}`}
        aria-label={t(key(item ? 'slotItem' : 'slotEmpty'), { slot, item: description })}
      >
        {item && (
          <>
            <span className="minecraft-item-id" aria-hidden="true">
              {icon ? <img src={icon} alt="" /> : readableMinecraftId(item.id)}
            </span>
            <span className="minecraft-item-count" aria-hidden="true">
              {item.count}
            </span>
          </>
        )}
      </span>
    </Tooltip>
  );
}
function Inventory({
  items,
  ender,
  selected,
  player,
}: {
  items: Item[] | null;
  ender?: boolean;
  selected: number | null;
  player?: { name: string; uuid: string };
}) {
  const t = useT();
  const [active, setActive] = useState(false);
  if (items === null) return <p className="muted">{t(key('inventoryUnavailable'))}</p>;
  const slots = ender
    ? Array.from({ length: 27 }, (_, index) => index)
    : [
        ...Array.from({ length: 27 }, (_, index) => index + 9),
        ...Array.from({ length: 9 }, (_, index) => index),
      ];
  const bySlot = new Map(items.map((item) => [item.slot, item]));
  const extra = items.filter((item) => !slots.includes(item.slot));
  return (
    <>
      {!ender && (
        <>
          <h4>{t(key('equipment'))}</h4>
          <div
            className="minecraft-equipment-stage"
            onPointerEnter={() => setActive(true)}
            onPointerLeave={() => setActive(false)}
          >
            <div className="minecraft-equipment-grid">
              {[103, 102, 101, 100, 150].map((slot) => (
                <div key={slot}>
                  <span className="minecraft-equipment-label">
                    {t(key(`equipment.${slot === 150 ? -106 : slot}`))}
                  </span>
                  <ItemSlot slot={slot} item={bySlot.get(slot)} />
                </div>
              ))}
            </div>
            {player && (
              <MinecraftPlayerBody
                name={player.name}
                uuid={player.uuid}
                active={active}
                className="minecraft-player-inventory-body"
              />
            )}
          </div>
        </>
      )}
      <fieldset
        className="minecraft-inventory-grid"
        aria-label={t(key(ender ? 'enderChest' : 'inventory'))}
      >
        {slots.map((slot, index) => (
          <div
            key={slot}
            className={!ender && index >= 27 ? 'minecraft-inventory-hotbar' : undefined}
          >
            <ItemSlot slot={slot} item={bySlot.get(slot)} selected={!ender && slot === selected} />
          </div>
        ))}
      </fieldset>
      {extra
        .filter((item) => ender || ![103, 102, 101, 100, 150].includes(item.slot))
        .map((item) => (
          <ItemSlot key={item.slot} slot={item.slot} item={item} />
        ))}
    </>
  );
}
function PlayerVitalsHud({ vitals }: { vitals: MinecraftPlayerDetail['vitals'] }) {
  const t = useT();
  if (!vitals) return null;
  const icons = (kind: 'heart' | 'food', value: number, maximum: number) => (
    <div className="minecraft-player-hud-icons" aria-hidden="true">
      {Array.from({ length: Math.min(20, Math.ceil(maximum / 2)) }, (_, index) => index * 2).map(
        (threshold) => {
          const filled = Math.max(0, Math.min(2, value - threshold));
          const empty = minecraftPlayerHudAsset(
            kind === 'heart' ? 'heart_container' : 'food_empty',
          );
          const full = filled
            ? minecraftPlayerHudAsset(`${kind}_${filled >= 2 ? 'full' : 'half'}`)
            : undefined;
          return (
            <span key={`${kind}-${threshold}`}>
              {empty ? (
                <img src={empty} alt="" />
              ) : (
                <span className={`minecraft-player-hud-dot minecraft-player-hud-dot--${kind}`} />
              )}
              {full && <img src={full} alt="" />}
              {!empty && (
                <span
                  className={`minecraft-player-hud-fill minecraft-player-hud-fill--${kind}`}
                  style={{ width: `${filled * 50}%` }}
                />
              )}
            </span>
          );
        },
      )}
    </div>
  );
  return (
    <div className="minecraft-player-hud">
      {vitals.health !== null && icons('heart', vitals.health, vitals.maxHealth ?? vitals.health)}
      {vitals.food !== null && icons('food', vitals.food, 20)}
      {vitals.experienceProgress !== null && (
        <label className="minecraft-player-xp">
          <span>{t(key('experienceProgress'))}</span>
          <meter min={0} max={1} value={Math.max(0, Math.min(1, vitals.experienceProgress))}>
            {Math.round(vitals.experienceProgress * 100)}%
          </meter>
          <small>{Math.round(vitals.experienceProgress * 100)}%</small>
        </label>
      )}
    </div>
  );
}
export function MinecraftPlayerDetailView({
  serverId,
  uuid,
  row,
  pending,
  permissionKeys,
  legacyActions,
  onAction,
  onBack,
}: {
  serverId: string;
  uuid: string;
  row?: MinecraftPlayerRow;
  pending: boolean;
  permissionKeys: readonly string[];
  legacyActions: (row: MinecraftPlayerRow) => ReactNode[];
  onAction(action: PlayerGameplayAction): void;
  onBack(): void;
}) {
  const t = useT();
  const format = useFormat();
  const heading = useRef<HTMLHeadingElement>(null);
  const focusedUuid = useRef<string | undefined>(undefined);

  const validUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uuid);
  const detail = useQuery({
    queryKey: ['minecraft-player-detail', serverId, uuid],
    queryFn: ({ signal }) => controller.playerDetails(serverId, uuid, signal),
    enabled: validUuid,
    retry: false,
  });
  useEffect(() => {
    if (detail.data?.player.uuid === uuid && focusedUuid.current !== uuid && heading.current) {
      heading.current.focus({ preventScroll: true });
      focusedUuid.current = uuid;
    }
  }, [uuid, detail.data]);
  const back = (
    <Link
      className="minecraft-player-back"
      to={`/servers/${serverId}/game/players`}
      onClick={onBack}
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
  if (detail.isPending)
    return (
      <>
        {back}
        <Loading />
      </>
    );
  if (detail.isError)
    return (
      <>
        {back}
        <ErrorNotice error={detail.error} retry={() => void detail.refetch()} />
      </>
    );
  const data = detail.data;
  if (!data) return null;
  const name = data.player.name ?? data.player.uuid;
  const moderationActions = data.player.name
    ? legacyActions({
        whitelisted: false,
        ...row,
        name: data.player.name,
        uuid,
        online: data.online === 'online',
      })
    : [];
  const actionButton = (action: PlayerGameplayAction) => {
    if (!permissionKeys.includes(`game.minecraft.players.${action}`)) return null;
    const capability = data.capabilities.find((value) => value.action === action);
    const reason = capability?.reason ? t(key(`blocked.${capability.reason}`)) : undefined;
    return (
      <Tooltip key={action} content={reason ?? t(key(action))}>
        <button
          type="button"
          className={
            ['kill', 'starve', 'reset'].includes(action)
              ? 'secondary minecraft-player-destructive'
              : 'secondary'
          }
          aria-disabled={pending || !capability?.available}
          onClick={() => {
            if (!pending && capability?.available) onAction(action);
          }}
        >
          {t(key(action))}
        </button>
      </Tooltip>
    );
  };
  return (
    <div className="minecraft-player-detail">
      {back}
      <header className="minecraft-player-detail-header">
        <div className="minecraft-player-detail-identity">
          <h2 tabIndex={-1} ref={heading}>
            {name}
          </h2>
          <code>{uuid}</code>
          {row && <PlayerRoles row={{ ...row, online: false }} />}
          <p className="muted">{t(key(`presence.${data.online}`))}</p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={detail.isFetching || pending}
          onClick={() => void detail.refetch()}
        >
          {t(key('refreshDetail'))}
        </button>
      </header>
      <div className="minecraft-player-snapshot-note">
        <p>{t(key('savedSnapshot'))}</p>
        <span>
          {data.snapshot.savedAt
            ? t(key('savedAt'), { date: format.date(data.snapshot.savedAt) })
            : t(key('saveTimeUnknown'))}
        </span>
        {data.snapshot.state !== 'available' && (
          <p role="status">{t(key(`snapshot.${data.snapshot.state}`))}</p>
        )}
      </div>
      <div className="minecraft-player-detail-columns">
        <div className="minecraft-player-detail-main">
          <section className="minecraft-player-panel">
            <h3>{t(key('inventory'))}</h3>
            <Inventory
              items={data.inventory}
              selected={data.selectedSlot}
              player={{ name, uuid }}
            />
          </section>
          <section className="minecraft-player-panel">
            <h3>{t(key('enderChest'))}</h3>
            <Inventory items={data.enderChest} ender selected={null} />
          </section>
        </div>
        <aside className="minecraft-player-detail-aside">
          <section className="minecraft-player-panel">
            <h3>{t(key('savedStatus'))}</h3>
            <PlayerVitalsHud vitals={data.vitals} />
            <dl className="minecraft-player-values">
              {(['health', 'food', 'experienceLevel', 'experienceTotal'] as const).map((field) => (
                <div key={field}>
                  <dt>{t(key(field))}</dt>
                  <dd>
                    {data.vitals?.[field] == null ? '—' : format.number(data.vitals[field] ?? 0, 2)}
                    {field === 'health' && data.vitals?.maxHealth != null
                      ? ` / ${format.number(data.vitals.maxHealth)}`
                      : field === 'food' && data.vitals?.food != null
                        ? ' / 20'
                        : ''}
                  </dd>
                </div>
              ))}
              <div>
                <dt>{t(key('gamemode'))}</dt>
                <dd>
                  {data.vitals?.gameMode == null
                    ? '—'
                    : t(
                        key(
                          `mode.${['survival', 'creative', 'adventure', 'spectator'][data.vitals.gameMode] ?? 'unknown'}`,
                        ),
                      )}
                </dd>
              </div>
            </dl>
            <div className="minecraft-player-detail-actions">
              {(['gamemode', 'heal', 'feed', 'starve', 'kill'] as const).map(actionButton)}
            </div>
          </section>
          <section className="minecraft-player-panel">
            <h3>{t(key('position'))}</h3>
            {data.position ? (
              <>
                <dl className="minecraft-player-values">
                  {(['x', 'y', 'z'] as const).map((axis) => (
                    <div key={axis}>
                      <dt>{axis.toUpperCase()}</dt>
                      <dd>{data.position ? format.number(data.position[axis], 2) : '—'}</dd>
                    </div>
                  ))}
                </dl>
                <p className="minecraft-player-dimension">
                  {String(data.position.dimension ?? '—')}
                </p>
              </>
            ) : (
              <p className="muted">{t(key('positionUnavailable'))}</p>
            )}
            {actionButton('teleport')}
          </section>
          {moderationActions.length > 0 && (
            <section className="minecraft-player-panel">
              <h3>{t(key('accessActions'))}</h3>
              <div className="minecraft-player-detail-actions">{moderationActions}</div>
            </section>
          )}
          {permissionKeys.includes('game.minecraft.players.reset') && (
            <section className="minecraft-player-panel">
              <h3>{t(key('reset'))}</h3>
              <p className="muted">{t(key('resetHelp'))}</p>
              {actionButton('reset')}
            </section>
          )}
        </aside>
        <div className="minecraft-player-detail-statistics">
          <section className="minecraft-player-panel">
            <h3>{t(key('statistics'))}</h3>
            <PlayerStatistics statistics={data.statistics} />
          </section>
        </div>
      </div>
    </div>
  );
}
