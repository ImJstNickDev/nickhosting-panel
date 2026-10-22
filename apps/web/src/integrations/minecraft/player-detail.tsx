import { createMinecraftUiController, type MinecraftPlayerDetail } from '@nickhosting/minecraft/ui';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useFormat, useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { ErrorNotice, Loading, Select } from '../../components/ui.js';
import { gameUiClient } from '../../features/integrations.js';
import { MinecraftPlayerAvatar } from './player-avatar.js';
import { MinecraftPlayerBody } from './player-body.js';
import { PlayerRoles } from './player-card.js';
import type { PlayerGameMode, PlayerGameplayAction } from './player-detail-actions.js';
import { PlayerIcon } from './player-icons.js';
import { minecraftItemIcon, minecraftPlayerHudAsset } from './player-item-assets.js';
import { PlayerStatistics, readableMinecraftId } from './player-statistics.js';
import { PlayerUuid } from './player-uuid.js';
import { PlayerXpBar } from './player-xp-bar.js';
import type { MinecraftPlayerRow } from './players-model.js';
import './player-detail.css';

const controller = createMinecraftUiController(gameUiClient);
const key = (name: string) => `games.minecraft.players.${name}`;
type Item = NonNullable<MinecraftPlayerDetail['inventory']>[number];

const equipmentPaths: Record<number, string> = {
  103: 'M4 13V4h8v9H9V9H7v4Z',
  102: 'M5 3H3L1 7l3 2v5h8V9l3-2-2-4h-2v3H5Z',
  101: 'M4 2h8v12H9V7H7v7H4Z',
  100: 'M3 3h4v11H1v-4h2Zm6 0h4v7h2v4H9Z',
  150: 'M3 2h10v8l-5 4-5-4Z',
};
function ItemSlot({
  slot,
  item,
  selected,
  equipment,
}: {
  slot: number;
  item?: Item;
  selected?: boolean;
  equipment?: boolean;
}) {
  const t = useT();
  const description = item
    ? `${item.name ?? readableMinecraftId(item.id)} × ${item.count}`
    : equipment
      ? t(key(`equipment.${slot === 150 ? -106 : slot}`))
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
        aria-label={
          equipment
            ? `${t(key(`equipment.${slot === 150 ? -106 : slot}`))}: ${item ? description : t(key('slotEmpty'), { slot })}`
            : t(key(item ? 'slotItem' : 'slotEmpty'), { slot, item: description })
        }
      >
        {!item && equipment && (
          <svg className="minecraft-equipment-placeholder" viewBox="0 0 16 16" aria-hidden="true">
            <path d={equipmentPaths[slot]} />
          </svg>
        )}
        {item && (
          <>
            <span className="minecraft-item-id" aria-hidden="true">
              {icon ? <img src={icon} alt="" /> : readableMinecraftId(item.id)}
            </span>
            {item.count > 1 && (
              <span className="minecraft-item-count" aria-hidden="true">
                {item.count}
              </span>
            )}
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
    <div
      className={`minecraft-inventory-surface${ender ? ' minecraft-inventory-surface--ender' : ''}`}
    >
      {ender && <h4 className="minecraft-inventory-title">{t(key('enderChest'))}</h4>}
      {!ender && (
        <div
          className="minecraft-equipment-stage"
          onPointerEnter={() => setActive(true)}
          onPointerLeave={() => setActive(false)}
        >
          <fieldset className="minecraft-equipment-grid" aria-label={t(key('equipment'))}>
            {[103, 102, 101, 100].map((slot) => (
              <ItemSlot key={slot} slot={slot} item={bySlot.get(slot)} equipment />
            ))}
          </fieldset>
          <div className="minecraft-equipment-preview">
            {player && (
              <MinecraftPlayerBody
                name={player.name}
                uuid={player.uuid}
                active={active}
                className="minecraft-player-inventory-body"
              />
            )}
          </div>
          <div className="minecraft-equipment-offhand">
            <ItemSlot slot={150} item={bySlot.get(150)} equipment />
          </div>
          <div
            className="minecraft-crafting-preview"
            role="img"
            aria-label={t(key('craftingNotSaved'))}
          >
            <span className="minecraft-crafting-title">{t(key('crafting'))}</span>
            <div className="minecraft-crafting-slots" aria-hidden="true">
              <div className="minecraft-crafting-inputs">
                {[0, 1, 2, 3].map((slot) => (
                  <span key={slot}>—</span>
                ))}
              </div>
              <span className="minecraft-crafting-arrow">→</span>
              <span className="minecraft-crafting-output">—</span>
            </div>
            <span className="minecraft-crafting-note">{t(key('notSaved'))}</span>
          </div>
        </div>
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
      {extra.filter((item) => ender || ![103, 102, 101, 100, 150].includes(item.slot)).length >
        0 && (
        <div className="minecraft-inventory-extra">
          {extra
            .filter((item) => ender || ![103, 102, 101, 100, 150].includes(item.slot))
            .map((item) => (
              <ItemSlot key={item.slot} slot={item.slot} item={item} />
            ))}
        </div>
      )}
    </div>
  );
}
function PlayerVitalsHud({ vitals }: { vitals: MinecraftPlayerDetail['vitals'] }) {
  const t = useT();
  if (!vitals) return null;
  const icons = (kind: 'heart' | 'food', value: number, maximum: number) => (
    <span className="minecraft-player-hud-icons" aria-hidden="true">
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
    </span>
  );
  const levelDigits = String(vitals.experienceLevel ?? '')
    .split('')
    .map((digit, index) => ({
      key: `${index}-${digit}`,
      image: minecraftPlayerHudAsset(`experience_digit_${digit}`),
    }));
  const xpBackground = minecraftPlayerHudAsset('experience_bar_background');
  const xpProgress = minecraftPlayerHudAsset('experience_bar_progress');
  return (
    <div className="minecraft-player-hud">
      <div className="minecraft-player-hud-row">
        {vitals.health !== null && (
          <span
            role="img"
            aria-label={`${t(key('health'))}: ${vitals.health}${vitals.maxHealth === null ? '' : ` / ${vitals.maxHealth}`}`}
          >
            {icons('heart', vitals.health, vitals.maxHealth ?? Math.max(20, vitals.health))}
          </span>
        )}
        {vitals.food !== null && (
          <span role="img" aria-label={`${t(key('food'))}: ${vitals.food} / 20`}>
            {icons('food', vitals.food, 20)}
          </span>
        )}
      </div>
      {(vitals.experienceLevel !== null || vitals.experienceProgress !== null) && (
        <div className="minecraft-player-xp">
          {vitals.experienceLevel !== null && (
            <span
              className="minecraft-player-level"
              role="img"
              aria-label={`${t(key('experienceLevel'))}: ${vitals.experienceLevel}`}
            >
              {levelDigits.every((digit) => digit.image)
                ? levelDigits.map((digit) => (
                    <img
                      className="minecraft-player-level-digit"
                      key={digit.key}
                      src={digit.image}
                      alt=""
                    />
                  ))
                : vitals.experienceLevel}
            </span>
          )}
          {vitals.experienceProgress !== null && (
            <>
              <meter
                className="sr-only"
                aria-label={t(key('experienceProgress'))}
                min={0}
                max={1}
                value={Math.max(0, Math.min(1, vitals.experienceProgress))}
              />
              <PlayerXpBar
                progress={vitals.experienceProgress}
                background={xpBackground}
                foreground={xpProgress}
              />
            </>
          )}
        </div>
      )}
      {vitals.experienceTotal !== null && (
        <p className="minecraft-player-xp-total">
          {t(key('experienceTotalShort'), { value: vitals.experienceTotal })}
        </p>
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
  onAction(action: PlayerGameplayAction, mode?: PlayerGameMode): void;
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
    const icon =
      action === 'heal'
        ? minecraftPlayerHudAsset('heart_full')
        : action === 'feed'
          ? minecraftPlayerHudAsset('food_full')
          : action === 'starve'
            ? minecraftPlayerHudAsset('food_empty')
            : action === 'kill'
              ? minecraftItemIcon('minecraft:skeleton_skull')
              : action === 'teleport'
                ? minecraftItemIcon('minecraft:ender_pearl')
                : undefined;
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
          {icon && <img className="minecraft-player-action-icon" src={icon} alt="" />}
          {t(key(action))}
        </button>
      </Tooltip>
    );
  };
  return (
    <div className="minecraft-player-detail">
      <div className="minecraft-player-detail-toolbar">
        {back}
        <button
          type="button"
          className="secondary minecraft-player-refresh"
          disabled={detail.isFetching || pending}
          aria-busy={detail.isFetching}
          onClick={() => void detail.refetch()}
        >
          <PlayerIcon name="refresh" />
          {t(key('refreshDetail'))}
        </button>
      </div>
      <header className="minecraft-player-detail-header">
        <MinecraftPlayerAvatar name={name} uuid={uuid} />
        <div className="minecraft-player-detail-identity">
          <div className="minecraft-player-identity-line">
            <h2 tabIndex={-1} ref={heading}>
              {name}
            </h2>
            <PlayerUuid uuid={uuid} />
          </div>
          <div className="minecraft-player-detail-meta">
            <span className="minecraft-player-presence">{t(key(`presence.${data.online}`))}</span>
            {row && <PlayerRoles row={{ ...row, online: false }} />}
            <span className="minecraft-player-saved-time">
              {data.snapshot.savedAt
                ? t(key('savedAt'), { date: format.date(data.snapshot.savedAt) })
                : t(key('saveTimeUnknown'))}
            </span>
          </div>
          {data.snapshot.state !== 'available' && (
            <p className="minecraft-player-snapshot-state" role="status">
              {t(key(`snapshot.${data.snapshot.state}`))}
            </p>
          )}
        </div>
      </header>
      <div className="minecraft-player-detail-columns">
        <div className="minecraft-player-detail-main">
          <section className="minecraft-player-panel minecraft-player-inventory-panel">
            <h3>{t(key('inventory'))}</h3>
            <PlayerVitalsHud vitals={data.vitals} />
            <Inventory
              items={data.inventory}
              selected={data.selectedSlot}
              player={{ name, uuid }}
            />
            <div className="minecraft-player-ender-section">
              {data.enderChest === null && <h4>{t(key('enderChest'))}</h4>}
              <Inventory items={data.enderChest} ender selected={null} />
            </div>
            {permissionKeys.includes('game.minecraft.players.reset') && (
              <div className="minecraft-player-reset-section">
                <p className="muted">{t(key('resetHelp'))}</p>
                {actionButton('reset')}
              </div>
            )}
          </section>
        </div>
        <aside className="minecraft-player-detail-aside">
          <section className="minecraft-player-panel">
            <h3>{t(key('playerActions'))}</h3>
            <div className="minecraft-player-action-group">
              {data.online !== 'online' && (
                <p className="minecraft-player-online-notice">{t(key('onlineActionsNotice'))}</p>
              )}
              <Select
                label={t(key('gamemode'))}
                value={
                  ['survival', 'creative', 'adventure', 'spectator'][data.vitals?.gameMode ?? -1] ??
                  ''
                }
                disabled={
                  pending ||
                  !permissionKeys.includes('game.minecraft.players.gamemode') ||
                  !data.capabilities.some((value) => value.action === 'gamemode' && value.available)
                }
                onChange={(event) => onAction('gamemode', event.target.value as PlayerGameMode)}
              >
                <option value="" disabled>
                  —
                </option>
                {(['survival', 'creative', 'adventure', 'spectator'] as const).map((mode) => (
                  <option key={mode} value={mode}>
                    {t(key(`mode.${mode}`))}
                  </option>
                ))}
              </Select>
              <div className="minecraft-player-detail-actions minecraft-player-gameplay-actions">
                {(['heal', 'feed', 'starve', 'kill'] as const).map(actionButton)}
              </div>
            </div>
            <div className="minecraft-player-action-group">
              <h4>{t(key('position'))}</h4>
              {data.position ? (
                <>
                  <p className="minecraft-player-dimension">
                    {typeof data.position.dimension === 'string'
                      ? readableMinecraftId(data.position.dimension)
                      : String(data.position.dimension ?? '—')}
                  </p>
                  <dl className="minecraft-player-coordinates">
                    {(['x', 'y', 'z'] as const).map((axis) => (
                      <div key={axis}>
                        <dt>{axis.toUpperCase()}</dt>
                        <dd>{data.position ? format.number(data.position[axis], 2) : '—'}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : (
                <p className="muted">{t(key('positionUnavailable'))}</p>
              )}
              <div className="minecraft-player-detail-actions minecraft-player-full-actions">
                {actionButton('teleport')}
              </div>
            </div>
            {moderationActions.length > 0 && (
              <div className="minecraft-player-action-group">
                <h4>{t(key('accessActions'))}</h4>
                <div className="minecraft-player-detail-actions minecraft-player-full-actions">
                  {moderationActions}
                </div>
              </div>
            )}
          </section>
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
