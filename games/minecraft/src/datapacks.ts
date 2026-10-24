import { z } from 'zod';
import formats from './datapack-formats.json' with { type: 'json' };

const integer = z.number().int().min(0).max(0x7fffffff);
const format = z.tuple([integer, integer]);
export const minecraftDatapackMetadataSchema = z.object({
  description: z.string().max(4096),
  formatMin: format.nullable(),
  formatMax: format.nullable(),
  compatibility: z.enum(['compatible', 'incompatible', 'unknown', 'invalid']),
  features: z.array(z.string().max(256)).max(128),
});
export type MinecraftDatapackMetadata = z.infer<typeof minecraftDatapackMetadataSchema>;
type Format = [number, number];
const catalogue = new Map(Object.entries(formats.versions));
const modernFormat = z.union([integer, z.tuple([integer]), format]);
const legacyRange = z.union([
  integer,
  z.tuple([integer, integer]),
  z.object({ min_inclusive: integer, max_inclusive: integer }),
]);
const metadata = z.object({
  pack: z.object({
    description: z.unknown(),
    pack_format: integer.optional(),
    supported_formats: legacyRange.optional(),
    min_format: modernFormat.optional(),
    max_format: modernFormat.optional(),
  }),
  features: z.object({ enabled: z.array(z.string().max(256)).max(128) }).optional(),
});

/** No metadata requests during Apply. Unknown/new releases remain unknown rather
 * than borrowing the unrelated level.dat DataVersion or a nearby release. */
export function minecraftDatapackFormat(release: string): Format | undefined {
  const value = catalogue.get(release);
  return value ? [value[0] as number, value[1] as number] : undefined;
}

export function minecraftSupportsDatapacks(release: string): boolean {
  if (catalogue.has(release)) return true;
  const stable = /^(\d+)\.(\d+)(?:\.\d+)?(?:-(?:pre|rc)-?\d+)?$/.exec(release);
  if (stable) return Number(stable[1]) > 1 || Number(stable[2]) >= 13;
  const snapshot = /^(\d{2})w(\d{2})[a-z]$/.exec(release);
  return Boolean(
    snapshot &&
      (Number(snapshot[1]) > 17 || (Number(snapshot[1]) === 17 && Number(snapshot[2]) >= 43)),
  );
}

function compare(a: Format, b: Format) {
  return a[0] - b[0] || a[1] - b[1];
}
function endpoint(value: z.infer<typeof modernFormat>, maximum: boolean): Format {
  const parts = typeof value === 'number' ? [value] : value;
  return [parts[0] as number, parts[1] ?? (maximum ? 0x7fffffff : 0)];
}
function text(value: unknown, depth = 0): string {
  if (depth > 12) return '';
  if (typeof value === 'string') return value.slice(0, 4096);
  if (Array.isArray(value))
    return value
      .slice(0, 128)
      .map((v) => text(v, depth + 1))
      .join('')
      .slice(0, 4096);
  if (!value || typeof value !== 'object') return '';
  const component = value as Record<string, unknown>;
  return `${text(component.text ?? component.translate, depth + 1)}${text(component.extra, depth + 1)}`.slice(
    0,
    4096,
  );
}

/** Declared format compatibility, never a guarantee that commands, functions,
 * world generation or feature flags work. JSON text components become plain
 * text; click events/URLs and arbitrary components are never executed. */
export function inspectMinecraftDatapackMetadata(
  raw: unknown,
  release: string,
): MinecraftDatapackMetadata {
  const invalid: MinecraftDatapackMetadata = {
    description: '',
    formatMin: null,
    formatMax: null,
    compatibility: 'invalid',
    features: [],
  };
  const parsed = metadata.safeParse(raw);
  if (!parsed.success) return invalid;
  const { pack, features } = parsed.data;
  invalid.description = text(pack.description);
  invalid.features = features?.enabled ?? [];
  if (pack.description === undefined || pack.description === null) return invalid;
  const target = minecraftDatapackFormat(release);
  let min: Format;
  let max: Format;
  if (pack.min_format !== undefined || pack.max_format !== undefined) {
    if (pack.min_format === undefined || pack.max_format === undefined) return invalid;
    min = endpoint(pack.min_format, false);
    max = endpoint(pack.max_format, true);
    if (compare(min, max) > 0) return invalid;
    // New metadata still needs the legacy declaration when spanning pre-82 packs.
    if (min[0] < 82 && (pack.pack_format === undefined || pack.supported_formats === undefined))
      return invalid;
    if (min[0] >= 82 && pack.supported_formats !== undefined) return invalid;
    if (target && target[0] < 82) {
      // Old Minecraft ignores the new fields; it reads its legacy declaration.
      if (pack.pack_format === undefined)
        return { ...invalid, formatMin: min, formatMax: max, compatibility: 'incompatible' };
      [min, max] = oldRange(pack, target[0]);
    }
  } else {
    if (pack.pack_format === undefined) return invalid;
    [min, max] = oldRange(pack, target?.[0]);
    if (target && target[0] >= 82 && max[0] >= 82) return invalid;
  }
  if (compare(min, max) > 0) return invalid;
  const compatible = target && compare(target, min) >= 0 && compare(target, max) <= 0;
  return {
    ...invalid,
    formatMin: min,
    formatMax: max,
    compatibility: !minecraftSupportsDatapacks(release)
      ? 'incompatible'
      : !target
        ? 'unknown'
        : !compatible
          ? 'incompatible'
          : invalid.features.some((feature) => feature !== 'minecraft:vanilla')
            ? 'unknown'
            : 'compatible',
  };
}

function oldRange(pack: z.infer<typeof metadata>['pack'], target?: number): [Format, Format] {
  const supported = target !== undefined && target < 18 ? undefined : pack.supported_formats;
  let min: number;
  let max: number;
  if (typeof supported === 'number') min = max = supported;
  else if (Array.isArray(supported)) [min, max] = supported;
  else if (supported) {
    min = supported.min_inclusive;
    max = supported.max_inclusive;
  } else min = max = pack.pack_format as number;
  return [
    [min, 0],
    [max, 0],
  ];
}
