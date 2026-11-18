import { type Point3, point3, rotate } from './minecraft-item-raster.js';

function rotation(value: unknown): ((p: Point3) => Point3) | undefined {
  if (value === undefined) return (p) => p;
  const degrees = point3(value, 360);
  if (degrees) return (p) => rotate(p, degrees);
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
    return;
  const length = Math.hypot(...value);
  if (Math.abs(length - 1) > 0.01) return;
  const [x, y, z, w] = value.map((n) => n / length) as [number, number, number, number];
  return ([a, b, c]) => {
    const tx = 2 * (y * c - z * b),
      ty = 2 * (z * a - x * c),
      tz = 2 * (x * b - y * a);
    return [
      a + w * tx + y * tz - z * ty,
      b + w * ty + z * tx - x * tz,
      c + w * tz + x * ty - y * tx,
    ];
  };
}

/** Forge 1.16 camera TRSR. ModelLoaderRegistry's center-to-corner conversion
 * composes with TransformationHelper's declared origin in centered model units. */
export function forgeGuiTransform(value: unknown): ((point: Point3) => Point3) | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const t = value as Record<string, unknown>;
  if (
    Object.keys(t).some(
      (k) => !['translation', 'rotation', 'scale', 'post-rotation', 'origin'].includes(k),
    )
  )
    return;
  const origin =
    t.origin === 'corner'
      ? [0, 0, 0]
      : t.origin === 'center'
        ? [0.5, 0.5, 0.5]
        : t.origin === 'opposing-corner' || t.origin === undefined
          ? [1, 1, 1]
          : point3(t.origin, 4);
  const translation = point3(t.translation ?? [0, 0, 0], 5);
  const scale = point3(
    typeof t.scale === 'number' ? [t.scale, t.scale, t.scale] : (t.scale ?? [1, 1, 1]),
    4,
  );
  const left = rotation(t.rotation),
    right = rotation(t['post-rotation']);
  if (!origin || !translation || !scale || !left || !right) return;
  return (point) => {
    const centered = point.map((n, i) => n / 16 - 0.5 - (origin[i] ?? 0)) as Point3;
    const scaled = right(centered).map((n, i) => n * (scale[i] ?? 1)) as Point3;
    return left(scaled).map((n, i) => n + (origin[i] ?? 0) + (translation[i] ?? 0)) as Point3;
  };
}
