/** Coffee Stain save timestamps without an offset use Unreal's UTC dotted
 * representation. Do not let the browser/host locale reinterpret that time. */
export function satisfactorySaveTime(value: string): number {
  const dotted = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})$/.exec(value);
  const iso = dotted
    ? `${dotted[1]}-${dotted[2]}-${dotted[3]}T${dotted[4]}:${dotted[5]}:${dotted[6]}.000Z`
    : value;
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
    iso,
  );
  if (!parts || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59)
    return Number.NaN;
  const date = new Date(`${parts[1]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== parts[1])
    return Number.NaN;
  return Date.parse(iso);
}
