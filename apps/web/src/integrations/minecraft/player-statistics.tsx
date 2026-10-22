import type { MinecraftPlayerDetail } from '@nickhosting/minecraft/ui';
import { useMemo, useState } from 'react';
import { useFormat, useT } from '../../app/i18n.js';
import { Select } from '../../components/ui.js';
import { Pagination, SearchField } from '../../components/workspace-controls.js';

const key = (name: string) => `games.minecraft.players.${name}`;
const categoriesWithLabels = new Set([
  'custom',
  'mined',
  'crafted',
  'used',
  'broken',
  'picked_up',
  'dropped',
  'killed',
  'killed_by',
]);
const timeStats = new Set([
  'play_time',
  'play_one_minute',
  'total_world_time',
  'time_since_death',
  'time_since_rest',
  'sneak_time',
]);
const damageStats = new Set([
  'damage_dealt',
  'damage_dealt_absorbed',
  'damage_dealt_resisted',
  'damage_taken',
  'damage_blocked_by_shield',
  'damage_absorbed',
  'damage_resisted',
]);
const labeledStats = new Set([
  'play_time',
  'play_one_minute',
  'total_world_time',
  'time_since_death',
  'time_since_rest',
  'sneak_time',
  'deaths',
  'player_kills',
  'mob_kills',
  'jump',
  'leave_game',
  'damage_dealt',
  'damage_taken',
  'walk_one_cm',
  'sprint_one_cm',
  'swim_one_cm',
  'fly_one_cm',
  'fall_one_cm',
  'climb_one_cm',
  'boat_one_cm',
  'horse_one_cm',
  'aviate_one_cm',
]);
export function readableMinecraftId(value: string) {
  return value.startsWith('minecraft:')
    ? value
        .slice(10)
        .replaceAll('_', ' ')
        .replace(/^./, (first) => first.toUpperCase())
    : value;
}
export function PlayerStatistics({
  statistics,
}: {
  statistics: MinecraftPlayerDetail['statistics'];
}) {
  const t = useT();
  const format = useFormat();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [page, setPage] = useState(0);
  const categories = useMemo(
    () => [...new Set(statistics?.map((stat) => stat.category) ?? [])].sort(),
    [statistics],
  );
  const categoryLabel = (value: string) =>
    categoriesWithLabels.has(value.replace(/^minecraft:/, ''))
      ? t(key(`statCategory.${value.replace(/^minecraft:/, '')}`))
      : value;
  const statLabel = (id: string) =>
    id.startsWith('minecraft:') && labeledStats.has(id.slice(10))
      ? t(key(`stat.${id.slice(10)}`))
      : readableMinecraftId(id);
  const duration = (ticks: number) => {
    const seconds = Math.floor(ticks / 20);
    return t(key('duration'), {
      hours: Math.floor(seconds / 3600),
      minutes: Math.floor((seconds % 3600) / 60),
      seconds: seconds % 60,
    });
  };
  const statValue = (stat: NonNullable<typeof statistics>[number]) =>
    stat.category === 'minecraft:custom' && timeStats.has(stat.id.replace(/^minecraft:/, ''))
      ? duration(stat.value)
      : stat.category === 'minecraft:custom' && stat.id.endsWith('_one_cm')
        ? t(key('distanceValue'), { value: format.number(stat.value / 100, 2) })
        : stat.category === 'minecraft:custom' &&
            damageStats.has(stat.id.replace(/^minecraft:/, ''))
          ? format.number(stat.value / 10, 2)
          : format.number(stat.value, 2);
  const rows =
    statistics?.filter(
      (stat) =>
        (category === 'all' ||
          stat.category === category ||
          (category === 'distance' &&
            stat.category === 'minecraft:custom' &&
            stat.id.endsWith('_one_cm'))) &&
        `${stat.id} ${statLabel(stat.id)}`.toLowerCase().includes(search.trim().toLowerCase()),
    ) ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / 50));
  const current = Math.min(page, pages - 1);
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
    [t(key('stat.play_time')), time === undefined ? '—' : duration(time)],
    [t(key('stat.deaths')), deaths === undefined ? '—' : format.number(deaths, 0)],
    [t(key('stat.player_kills')), kills === undefined ? '—' : format.number(kills, 0)],
    [
      t(key('killDeathRatio')),
      deaths === undefined || deaths === 0 || kills === undefined
        ? '—'
        : format.number(kills / deaths, 2),
    ],
  ];
  return (
    <>
      <dl className="minecraft-statistics-summary">
        {summary.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="minecraft-statistics-toolbar">
        <SearchField
          label={t(key('searchStatistics'))}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
        />
        <Select
          label={t(key('statisticsCategory'))}
          value={category}
          onChange={(event) => {
            setCategory(event.target.value);
            setPage(0);
          }}
        >
          <option value="all">{t(key('all'))}</option>
          {categories.map((value) => (
            <option key={value} value={value}>
              {categoryLabel(value)}
            </option>
          ))}
          {statistics.some(
            (stat) => stat.category === 'minecraft:custom' && stat.id.endsWith('_one_cm'),
          ) && <option value="distance">{t(key('distance'))}</option>}
        </Select>
      </div>
      <dl className="minecraft-statistics-list">
        {rows.slice(current * 50, current * 50 + 50).map((stat) => (
          <div key={`${stat.category}:${stat.id}`}>
            <dt>
              <span>{statLabel(stat.id)}</span>
              <small>
                {categoryLabel(stat.category)} · {stat.id}
              </small>
            </dt>
            <dd>{statValue(stat)}</dd>
          </div>
        ))}
      </dl>
      {!rows.length && <p className="muted">{t(key('noStatisticsMatches'))}</p>}
      {pages > 1 && (
        <Pagination
          label={t(key('statistics'))}
          previousLabel={t(key('previous'))}
          nextLabel={t(key('next'))}
          summary={t(key('page'), { page: current + 1, total: pages })}
          canPrevious={current > 0}
          canNext={current + 1 < pages}
          onPrevious={() => setPage(current - 1)}
          onNext={() => setPage(current + 1)}
        />
      )}
    </>
  );
}
