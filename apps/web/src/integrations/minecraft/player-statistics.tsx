import type { MinecraftPlayerDetail } from '@nickhosting/minecraft/ui';
import { useFormat, useT } from '../../app/i18n.js';
import { minecraftItemIcon } from './player-item-assets.js';

const key = (name: string) => `games.minecraft.players.${name}`;
export function readableMinecraftId(value: string) {
  return value.startsWith('minecraft:')
    ? value
        .slice(10)
        .replaceAll('_', ' ')
        .replace(/^./, (first) => first.toUpperCase())
    : value;
}

/** A bounded overview of saved statistics, not a dump of Minecraft's stat registry. */
export function PlayerStatistics({
  statistics,
}: {
  statistics: MinecraftPlayerDetail['statistics'];
}) {
  const t = useT();
  const format = useFormat();
  if (statistics === null) return <p className="muted">{t(key('statisticsUnavailable'))}</p>;
  if (!statistics.length) return <p className="muted">{t(key('statisticsEmpty'))}</p>;
  const custom = new Map(
    statistics
      .filter((stat) => stat.category === 'minecraft:custom')
      .map((stat) => [stat.id, stat.value]),
  );
  const time = custom.get('minecraft:play_time') ?? custom.get('minecraft:play_one_minute');
  const deaths = custom.get('minecraft:deaths');
  const kills = custom.get('minecraft:player_kills');
  const summary = [
    {
      label: t(key('stat.play_time')),
      icon: 'clock',
      value:
        time === undefined
          ? '—'
          : t(key('durationShort'), {
              hours: Math.floor(time / 72000),
              minutes: Math.floor((time % 72000) / 1200),
            }),
    },
    {
      label: t(key('stat.deaths')),
      icon: 'skeleton_skull',
      value: deaths === undefined ? '—' : format.number(deaths, 0),
    },
    {
      label: t(key('stat.player_kills')),
      icon: 'iron_sword',
      value: kills === undefined ? '—' : format.number(kills, 0),
    },
    {
      label: t(key('killDeathRatio')),
      icon: 'target',
      value:
        deaths === undefined || deaths === 0 || kills === undefined
          ? '—'
          : format.number(kills / deaths, 2),
    },
  ];
  const distanceIds = [
    'walk_one_cm',
    'sprint_one_cm',
    'swim_one_cm',
    'aviate_one_cm',
    'fly_one_cm',
    'boat_one_cm',
    'horse_one_cm',
    'climb_one_cm',
    'fall_one_cm',
  ];
  const groups = ['mined', 'used', 'killed', 'distance'].map((category) => ({
    category,
    rows: statistics
      .filter(
        (stat) =>
          stat.value > 0 &&
          (category === 'distance'
            ? stat.category === 'minecraft:custom' &&
              distanceIds.includes(stat.id.replace(/^minecraft:/, ''))
            : stat.category === `minecraft:${category}`),
      )
      .sort((left, right) => right.value - left.value || left.id.localeCompare(right.id))
      .slice(0, 2),
  }));
  return (
    <>
      <dl className="minecraft-statistics-summary">
        {summary.map(({ label, value, icon }) => {
          const image = minecraftItemIcon(`minecraft:${icon}`);
          return (
            <div key={label}>
              <dt>
                {image && <img src={image} alt="" />}
                <span>{label}</span>
              </dt>
              <dd>{value}</dd>
            </div>
          );
        })}
      </dl>
      {groups
        .filter((group) => group.rows.length > 0)
        .map(({ category, rows }) => (
          <section className="minecraft-statistics-group" key={category}>
            <h4>{t(key(category === 'distance' ? 'distance' : `statCategory.${category}`))}</h4>
            <dl className="minecraft-statistics-list">
              {rows.map((stat) => {
                const icon = ['mined', 'used'].includes(category)
                  ? minecraftItemIcon(stat.id)
                  : undefined;
                return (
                  <div key={stat.id}>
                    <dt>
                      {icon && <img src={icon} alt="" />}
                      <span>
                        {category === 'distance'
                          ? t(key(`stat.${stat.id.slice(10)}`))
                          : readableMinecraftId(stat.id)}
                      </span>
                    </dt>
                    <dd>
                      {category === 'distance'
                        ? t(key('distanceValue'), { value: format.number(stat.value / 100, 2) })
                        : format.number(stat.value, 0)}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ))}
    </>
  );
}
