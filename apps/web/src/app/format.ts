/** Adaptive binary units preserve meaningful small-file sizes as well as worlds/backups. */
export function formatBytes(
  value: number,
  locale: string,
  number = (n: number, digits: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n),
) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = value === 0 ? 0 : Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${number(value / 1024 ** index, index === 0 ? 0 : 1)} ${units[index]}`;
}
