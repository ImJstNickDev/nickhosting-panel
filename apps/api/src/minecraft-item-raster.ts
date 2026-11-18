import { PNG } from 'pngjs';

export type Point3 = [number, number, number];
export type Uv = [number, number];
export type ItemFace = { points: Point3[]; uv: Uv[]; texture: string; shade?: boolean };
export type ItemTransform = { rotation: Point3; translation: Point3; scale: Point3 };
export const blockGuiTransform: ItemTransform = {
  rotation: [30, 225, 0],
  translation: [0, 0, 0],
  scale: [0.625, 0.625, 0.625],
};
export const identityGuiTransform: ItemTransform = {
  rotation: [0, 0, 0],
  translation: [0, 0, 0],
  scale: [1, 1, 1],
};
const finite = (value: unknown, bound: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= bound;
export function point3(value: unknown, bound = 80): Point3 | undefined {
  return Array.isArray(value) && value.length === 3 && value.every((n) => finite(n, bound))
    ? (value as Point3)
    : undefined;
}
export function rotate(point: Point3, degrees: Point3): Point3 {
  // Minecraft's quaternion rotationXYZ: the rightmost Z rotation acts first.
  let [x, y, z] = point;
  const [rx, ry, rz] = degrees.map((n) => (n * Math.PI) / 180) as Point3;
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  return [x, y, z];
}
export function cuboidPoints(from: Point3, to: Point3): Record<string, Point3[]> {
  const [x, y, z] = from,
    [X, Y, Z] = to;
  return {
    down: [
      [x, y, Z],
      [x, y, z],
      [X, y, z],
      [X, y, Z],
    ],
    up: [
      [x, Y, z],
      [x, Y, Z],
      [X, Y, Z],
      [X, Y, z],
    ],
    north: [
      [X, Y, z],
      [X, y, z],
      [x, y, z],
      [x, Y, z],
    ],
    south: [
      [x, Y, Z],
      [x, y, Z],
      [X, y, Z],
      [X, Y, Z],
    ],
    west: [
      [x, Y, z],
      [x, y, z],
      [x, y, Z],
      [x, Y, Z],
    ],
    east: [
      [X, Y, Z],
      [X, y, Z],
      [X, y, z],
      [X, Y, z],
    ],
  };
}
export function rectangleUv(rect: number[], rotation = 0): Uv[] {
  const [u = 0, v = 0, U = 16, V = 16] = rect;
  const corners: Uv[] = [
    [u / 16, v / 16],
    [u / 16, V / 16],
    [U / 16, V / 16],
    [U / 16, v / 16],
  ];
  const steps = rotation / 90;
  return corners.map((_, index) => corners[(index + steps) % 4] as Uv);
}

/** Bounded, nearest-sampled orthographic item rendering; no WebGL or mod execution. */
export function rasterizeItem(
  faces: readonly ItemFace[],
  textures: ReadonlyMap<string, PNG>,
  transform: ItemTransform,
  frontLight: boolean,
  signal: AbortSignal,
): PNG | undefined {
  if (!faces.length || faces.length > 512) return;
  const size = 32,
    result = new PNG({ width: size, height: size });
  const depth = new Float64Array(size * size).fill(-Infinity);
  const mapped = (p: Point3): Point3 => {
    const centered = p.map((n, i) => (n / 16 - 0.5) * (transform.scale[i] ?? 1)) as Point3;
    const rotated = rotate(centered, transform.rotation);
    return [
      (rotated[0] + transform.translation[0] / 16 + 0.5) * size,
      (0.5 - rotated[1] - transform.translation[1] / 16) * size,
      rotated[2] + transform.translation[2] / 16,
    ];
  };
  const triangles: { p: Point3[]; uv: Uv[]; texture: PNG; light: number }[] = [];
  for (const face of faces) {
    signal.throwIfAborted();
    const texture = textures.get(face.texture);
    if (
      !texture ||
      face.points.length < 3 ||
      face.points.length > 4 ||
      face.uv.length !== face.points.length
    )
      return;
    const points = face.points.map(mapped);
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[0] as Point3,
        b = points[i] as Point3,
        c = points[i + 1] as Point3;
      const ab = b.map((v, j) => v - (a[j] ?? 0)) as Point3,
        ac = c.map((v, j) => v - (a[j] ?? 0)) as Point3;
      // Cross product in GUI coordinates; winding determines the visible side.
      const nz = ab[0] * ac[1] - ab[1] * ac[0];
      if (Math.abs(nz) < 1e-8) continue;
      // Two-sided rasterization is useful for thin OBJ geometry; depth resolves occlusion.
      // Native GUI lighting uses the reflected normal space (screen Y points down).
      const nx = -(ab[1] * ac[2] - ab[2] * ac[1]) * size;
      const ny = -(ab[2] * ac[0] - ab[0] * ac[2]) * size;
      const normal: Point3 = [nx, ny, -nz];
      const length = Math.hypot(...normal);
      const lights: Point3[] = frontLight
        ? [
            [-0.222519, -0.171499, 0.959726],
            [-0.215012, -0.971825, 0.096568],
          ]
        : [
            [-0.933439, -0.262695, -0.2443],
            [-0.103571, -0.976607, 0.188446],
          ];
      const diffuse = lights.reduce(
        (sum, light) =>
          sum +
          Math.max(
            0,
            (light[0] * normal[0] + light[1] * normal[1] + light[2] * normal[2]) / length,
          ),
        0,
      );
      const light = face.shade === false ? 1 : Math.min(1, 0.4 + 0.6 * diffuse);
      triangles.push({
        p: [a, b, c],
        uv: [face.uv[0] as Uv, face.uv[i] as Uv, face.uv[i + 1] as Uv],
        texture,
        light,
      });
    }
  }
  // Back-to-front preserves translucent material layers; depth still rejects hidden pixels.
  triangles.sort((a, b) => a.p.reduce((n, p) => n + p[2], 0) - b.p.reduce((n, p) => n + p[2], 0));
  for (const { p, uv, texture, light } of triangles) {
    signal.throwIfAborted();
    const [a, b, c] = p as [Point3, Point3, Point3];
    const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    const xmin = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))),
      xmax = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const ymin = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))),
      ymax = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = ymin; y <= ymax; y++)
      for (let x = xmin; x <= xmax; x++) {
        const w0 =
          ((b[1] - c[1]) * (x + 0.5 - c[0]) + (c[0] - b[0]) * (y + 0.5 - c[1])) / denominator;
        const w1 =
          ((c[1] - a[1]) * (x + 0.5 - c[0]) + (a[0] - c[0]) * (y + 0.5 - c[1])) / denominator;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-8 || w1 < -1e-8 || w2 < -1e-8) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2],
          pixel = y * size + x;
        if (z <= (depth[pixel] ?? -Infinity) + 1e-9) continue;
        const u = w0 * (uv[0] as Uv)[0] + w1 * (uv[1] as Uv)[0] + w2 * (uv[2] as Uv)[0],
          v = w0 * (uv[0] as Uv)[1] + w1 * (uv[1] as Uv)[1] + w2 * (uv[2] as Uv)[1];
        const tx = Math.max(0, Math.min(texture.width - 1, Math.floor(u * texture.width)));
        const ty = Math.max(0, Math.min(texture.height - 1, Math.floor(v * texture.height)));
        const at = (ty * texture.width + tx) * 4,
          dest = pixel * 4,
          alpha = (texture.data[at + 3] ?? 0) / 255;
        if (!alpha) continue;
        const old = (result.data[dest + 3] ?? 0) / 255,
          combined = alpha + old * (1 - alpha);
        for (let channel = 0; channel < 3; channel++)
          result.data[dest + channel] = Math.round(
            ((texture.data[at + channel] ?? 0) * light * alpha +
              (result.data[dest + channel] ?? 0) * old * (1 - alpha)) /
              combined,
          );
        result.data[dest + 3] = Math.round(combined * 255);
        depth[pixel] = z;
      }
  }
  return result.data.some((value, index) => index % 4 === 3 && value > 0) ? result : undefined;
}
