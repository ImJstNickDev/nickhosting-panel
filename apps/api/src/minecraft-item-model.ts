import { PNG } from 'pngjs';
import { forgeGuiTransform } from './minecraft-item-forge-transform.js';
import {
  blockGuiTransform,
  cuboidPoints,
  type ItemFace,
  type ItemTransform,
  identityGuiTransform,
  maxItemFaces,
  type Point3,
  point3,
  rasterizeItem,
  rectangleUv,
  rotate,
  type Uv,
} from './minecraft-item-raster.js';
import { ViewerFormatError } from './viewer-cache.js';

const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
export function itemResource(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 256) return;
  const id = value.includes(':') ? value : `minecraft:${value}`;
  if (
    !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id) ||
    id.split(/[/:]/).some((p) => !p || p === '.' || p === '..')
  )
    return;
  return id;
}
const pathFor = (id: string, kind: string, ext: string) =>
  `assets/${id.replace(':', `/${kind}/`)}.${ext}`;
const resourcePath = (id: string) => `assets/${id.replace(':', '/')}`;
type Read = (path: string, maximum: number) => Promise<Uint8Array | undefined>;
export function decodeItemPng(bytes: Uint8Array | undefined, animation = true): PNG | undefined {
  if (!bytes || bytes.length < 33 || bytes.length > 512 * 1024) return;
  const header = Buffer.from(bytes);
  if (
    !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    header.readUInt32BE(8) !== 13 ||
    header.toString('ascii', 12, 16) !== 'IHDR' ||
    header[28] !== 0
  )
    return;
  const width = header.readUInt32BE(16),
    height = header.readUInt32BE(20);
  if (!width || width > 256 || !height || height > 4096 || (animation && height % width)) return;
  try {
    const image = PNG.sync.read(header, { checkCRC: true });
    if (!animation) return image;
    const frame = new PNG({ width, height: width });
    image.data.copy(frame.data, 0, 0, width * width * 4);
    return frame;
  } catch {
    return;
  }
}
function transformOf(value: unknown, fallback: ItemTransform): ItemTransform | undefined {
  if (value === undefined) return fallback;
  const v = object(value);
  if (!v) return;
  const rotation = v.rotation === undefined ? ([0, 0, 0] as Point3) : point3(v.rotation, 360);
  const translation =
    v.translation === undefined ? ([0, 0, 0] as Point3) : point3(v.translation, 80);
  const scale = v.scale === undefined ? ([1, 1, 1] as Point3) : point3(v.scale, 4);
  return rotation && translation && scale ? { rotation, translation, scale } : undefined;
}
function standardParent(id: string): Record<string, unknown> | undefined {
  if (id === 'minecraft:block/block') return { display: { gui: blockGuiTransform } };
  if (id === 'minecraft:block/cube_all')
    return {
      parent: 'minecraft:block/cube',
      textures: {
        down: '#all',
        up: '#all',
        north: '#all',
        south: '#all',
        west: '#all',
        east: '#all',
      },
    };
  if (id === 'minecraft:block/cube')
    return {
      parent: 'minecraft:block/block',
      elements: [
        {
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: Object.fromEntries(
            ['down', 'up', 'north', 'south', 'west', 'east'].map((n) => [n, { texture: `#${n}` }]),
          ),
        },
      ],
    };
  return;
}
function elementsToFaces(elements: unknown): ItemFace[] | undefined {
  if (!Array.isArray(elements) || elements.length > maxItemFaces) return;
  const result: ItemFace[] = [];
  for (const raw of elements) {
    const e = object(raw),
      from = point3(e?.from, 32),
      to = point3(e?.to, 32),
      faces = object(e?.faces);
    if (!e || !from || !to || !faces || from.some((v, i) => v > (to[i] ?? 0))) return;
    const positions = cuboidPoints(from, to);
    const [x, y, z] = from,
      [X, Y, Z] = to;
    const defaults: Record<string, number[]> = {
      down: [x, 16 - Z, X, 16 - z],
      up: [x, z, X, Z],
      north: [16 - X, 16 - Y, 16 - x, 16 - y],
      south: [x, 16 - Y, X, 16 - y],
      west: [z, 16 - Y, Z, 16 - y],
      east: [16 - Z, 16 - Y, 16 - z, 16 - y],
    };
    for (const [direction, rawFace] of Object.entries(faces)) {
      if (result.length >= maxItemFaces || !Object.hasOwn(positions, direction)) return;
      const f = object(rawFace),
        points = positions[direction];
      if (!f || !points || typeof f.texture !== 'string' || f.tintindex !== undefined) return;
      const uv = f.uv ?? defaults[direction],
        rotation = f.rotation ?? 0;
      if (
        !Array.isArray(uv) ||
        uv.length !== 4 ||
        !uv.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 256) ||
        ![0, 90, 180, 270].includes(rotation as number)
      )
        return;
      let transformed = points;
      if (e.rotation !== undefined) {
        const r = object(e.rotation),
          origin = point3(r?.origin, 32);
        if (
          !r ||
          !origin ||
          !['x', 'y', 'z'].includes(String(r.axis)) ||
          ![-45, -22.5, 0, 22.5, 45].includes(r.angle as number)
        )
          return;
        const axis = ['x', 'y', 'z'].indexOf(String(r.axis)),
          angles: Point3 = [0, 0, 0];
        angles[axis] = r.angle as number;
        const compensation =
          r.rescale === true ? 1 / Math.cos(((r.angle as number) * Math.PI) / 180) : 1;
        transformed = points.map((p) => {
          const local = rotate(p.map((n, i) => n - (origin[i] ?? 0)) as Point3, angles);
          return local.map(
            (n, i) => (origin[i] ?? 0) + n * (i === axis ? 1 : compensation),
          ) as Point3;
        });
      }
      result.push({
        points: transformed,
        uv: rectangleUv(uv, rotation as number),
        texture: f.texture,
        shade: e.shade !== false,
      });
    }
  }
  return result;
}

/** Verified Cuboid chest renderer family; unknown builtin/entity models remain unsupported. */
function chestFaces(): ItemFace[] {
  const result: ItemFace[] = [];
  for (const [from, size, offset] of [
    [
      [1, 0, 1],
      [14, 10, 14],
      [0, 19],
    ],
    [
      [1, 9, 1],
      [14, 5, 14],
      [0, 0],
    ],
    [
      [7, 7, 15],
      [2, 4, 1],
      [0, 0],
    ],
  ] as [Point3, Point3, [number, number]][]) {
    const [x, y, z] = from,
      [w, h, d] = size,
      [u, v] = offset,
      X = x + w,
      Y = y + h,
      Z = z + d;
    const A: Point3 = [x, y, z],
      B: Point3 = [X, y, z],
      C: Point3 = [X, Y, z],
      D: Point3 = [x, Y, z],
      E: Point3 = [x, y, Z],
      F: Point3 = [X, y, Z],
      G: Point3 = [X, Y, Z],
      H: Point3 = [x, Y, Z];
    const faces: [Point3[], number[]][] = [
      [
        [F, E, A, B],
        [u + d, v, u + d + w, v + d],
      ],
      [
        [C, D, H, G],
        [u + d + w, v + d, u + d + 2 * w, v],
      ],
      [
        [A, E, H, D],
        [u, v + d, u + d, v + d + h],
      ],
      [
        [B, A, D, C],
        [u + d, v + d, u + d + w, v + d + h],
      ],
      [
        [F, B, C, G],
        [u + d + w, v + d, u + 2 * d + w, v + d + h],
      ],
      [
        [E, F, G, H],
        [u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h],
      ],
    ];
    for (const [points, rect] of faces) {
      const [U, V, R, S] = rect as [number, number, number, number];
      result.push({
        points,
        uv: [
          [R / 64, V / 64],
          [U / 64, V / 64],
          [U / 64, S / 64],
          [R / 64, S / 64],
        ],
        texture: '#skin',
      });
    }
  }
  return result;
}

async function objFaces(
  model: Record<string, unknown>,
  read: Read,
): Promise<ItemFace[] | undefined> {
  const id = itemResource(model.model);
  const transmitter = model.loader === 'mekanism:transmitter';
  const validPath = transmitter
    ? /^mekanism:models\/[a-z0-9_./-]+\.obj(?:\.mek)?$/
    : /^[a-z0-9_.-]+:models\/[a-z0-9_./-]+\.obj(?:\.ie)?$/;
  if (!id || !validPath.test(id)) return;
  const path = resourcePath(id),
    bytes = await read(path, 256 * 1024);
  if (!bytes) return;
  const text = Buffer.from(bytes).toString('utf8');
  if (text.length > 256 * 1024) return;
  const libraries = [...text.matchAll(/^mtllib\s+([^\r\n]+)$/gm)].map((m) => m[1]?.trim());
  if (libraries.length !== 1 || !libraries[0] || !/^[a-z0-9_.-]+\.mtl$/.test(libraries[0])) return;
  const mtl = await read(path.slice(0, path.lastIndexOf('/') + 1) + libraries[0], 64 * 1024);
  if (!mtl) return;
  const materials = new Map<string, string>();
  let material = '';
  for (const line of Buffer.from(mtl).toString('utf8').split(/\r?\n/)) {
    const [kind, ...values] = line.trim().split(/\s+/);
    if (kind === 'newmtl') material = values.join(' ');
    else if (kind === 'map_Kd' && material && values.length === 1)
      materials.set(material, values[0] as string);
  }
  const vertices: Point3[] = [],
    uvs: Uv[] = [],
    faces: ItemFace[] = [];
  let group = '';
  material = '';
  for (const line of text.split(/\r?\n/)) {
    const [kind, ...values] = line.trim().split(/\s+/);
    if (kind === 'v') {
      const p = point3(values.map(Number), 4);
      if (!p || vertices.length >= 4096) return;
      vertices.push(p.map((n) => n * 16) as Point3);
    } else if (kind === 'vt') {
      const p = values.map(Number);
      if (
        p.length < 2 ||
        p.length > 3 ||
        p.some((n) => !Number.isFinite(n) || Math.abs(n) > 16) ||
        uvs.length >= 4096
      )
        return;
      uvs.push([
        p[0] as number,
        model['flip-v'] === true ? 1 - (p[1] as number) : (p[1] as number),
      ]);
    } else if (kind === 'o' || kind === 'g') group = values.join(' ');
    else if (kind === 'usemtl') material = values.join(' ');
    else if (
      kind === 'f' &&
      (!transmitter ||
        /^(?:upNORMAL|downNORMAL|northNONE|southNONE|eastNONE|westNONE)$/.test(group))
    ) {
      if (values.length < 3 || values.length > 4 || faces.length >= maxItemFaces) return;
      const texture = materials.get(material);
      if (!texture) return;
      const points: Point3[] = [],
        uv: Uv[] = [];
      for (const value of values) {
        const parts = value.split('/');
        if (parts.length < 2 || !parts.slice(0, 2).every((p) => /^\d+$/.test(p))) return;
        const p = vertices[Number(parts[0]) - 1],
          t = uvs[Number(parts[1]) - 1];
        if (!p || !t) return;
        points.push(p);
        uv.push(t);
      }
      faces.push({ points, uv, texture, shade: model['diffuse-lighting'] !== false });
    }
  }
  return faces.length ? faces : undefined;
}

/** Apply the default dye to layer zero, then composite the untinted overlay. */
function colorGeneratedSprite(image: PNG, color: number, overlay?: PNG) {
  const tint = [(color >>> 16) & 255, (color >>> 8) & 255, color & 255];
  for (let at = 0; at < image.data.length; at += 4) {
    const a = (image.data[at + 3] ?? 0) / 255;
    const b = (overlay?.data[at + 3] ?? 0) / 255;
    const combined = b + a * (1 - b);
    if (!combined) continue;
    for (let channel = 0; channel < 3; channel++) {
      const dyed = ((image.data[at + channel] ?? 0) * (tint[channel] ?? 0)) / 255;
      image.data[at + channel] = Math.round(
        ((overlay?.data[at + channel] ?? 0) * b + dyed * a * (1 - b)) / combined,
      );
    }
    image.data[at + 3] = Math.round(combined * 255);
  }
}

export async function renderMinecraftItemModel(
  id: string,
  has: (path: string) => boolean,
  read: Read,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const json = async (path: string) => {
      const bytes = await read(path, 64 * 1024);
      if (!bytes) return;
      try {
        return object(JSON.parse(Buffer.from(bytes).toString('utf8')));
      } catch {
        return;
      }
    };
    let modelId = `${id.slice(0, id.indexOf(':'))}:item/${id.slice(id.indexOf(':') + 1)}`;
    const definition = pathFor(id, 'items', 'json');
    let baseColor: number | undefined;
    if (has(definition)) {
      let value = object((await json(definition))?.model);
      // Inventory IDs carry no trim or dye components. Use the declared untrimmed default.
      if (value?.type === 'minecraft:select' && value.property === 'minecraft:trim_material')
        value = object(value.fallback);
      if (value?.type !== 'minecraft:model' || !itemResource(value.model)) return;
      if (value.tints !== undefined) {
        const tints = value.tints;
        const dye = Array.isArray(tints) && tints.length === 1 ? object(tints[0]) : undefined;
        if (
          dye?.type !== 'minecraft:dye' ||
          typeof dye.default !== 'number' ||
          !Number.isInteger(dye.default)
        )
          return;
        baseColor = dye.default;
      }
      modelId = itemResource(value.model) as string;
    } else if (/^minecraft:leather_(helmet|chestplate|leggings|boots)$/.test(id)) {
      baseColor = 0xa06540;
    }
    let model: Record<string, unknown> = {},
      textures: Record<string, unknown> = {},
      display: Record<string, unknown> = {};
    const seen = new Set<string>();
    let generated = false,
      entity = false;
    while (seen.size < 32) {
      signal.throwIfAborted();
      if (seen.has(modelId)) return;
      seen.add(modelId);
      if (
        [
          'minecraft:item/generated',
          'minecraft:item/handheld',
          'minecraft:item/handheld_rod',
          'minecraft:builtin/generated',
        ].includes(modelId)
      ) {
        generated = true;
        break;
      }
      if (modelId === 'minecraft:builtin/entity') {
        entity = true;
        break;
      }
      const path = pathFor(modelId, 'models', 'json');
      const own = has(path) ? await json(path) : standardParent(modelId);
      if (!own) return;
      model = { ...own, ...model };
      textures = { ...object(own.textures), ...textures };
      display = { ...object(own.display), ...display };
      if (own.parent === undefined) break;
      const parent = itemResource(own.parent);
      if (!parent) return;
      modelId = parent;
    }
    if (seen.size >= 32 || model.overrides !== undefined) return;
    const resolveTexture = (reference: string) => {
      const refs = new Set<string>();
      let value: unknown = reference;
      while (typeof value === 'string' && value.startsWith('#')) {
        if (refs.has(value) || refs.size >= 32) return;
        refs.add(value);
        value = textures[value.slice(1)];
      }
      return itemResource(value);
    };
    let output: PNG | undefined;
    if (generated && model.elements === undefined && model.loader === undefined) {
      if (
        Object.keys(textures).some(
          (k) => /^layer[1-9]/.test(k) && (k !== 'layer1' || baseColor === undefined),
        )
      )
        return;
      const texture = resolveTexture('#layer0');
      if (!texture) return;
      output = decodeItemPng(await read(pathFor(texture, 'textures', 'png'), 512 * 1024));
      if (output && baseColor !== undefined) {
        const overlay = resolveTexture('#layer1');
        const layer = overlay
          ? decodeItemPng(await read(pathFor(overlay, 'textures', 'png'), 512 * 1024))
          : undefined;
        if (textures.layer1 !== undefined && (!layer || layer.width !== output.width)) return;
        colorGeneratedSprite(output, baseColor, layer);
      }
    } else {
      let faces: ItemFace[] | undefined;
      let fullSkin = false;
      if (entity) {
        if (!/^cuboidmod:[a-z0-9_]+_chest$/.test(id) || model.loader !== undefined) return;
        textures.skin = `cuboidmod:model/${id.split(':')[1]}`;
        faces = chestFaces();
        fullSkin = true;
      } else if (model.loader === 'mekanism:transmitter' || model.loader === 'forge:obj')
        faces = await objFaces(model, read);
      else if (model.loader === undefined) faces = elementsToFaces(model.elements);
      if (!faces?.length) return;
      const forge = object(model.transform);
      const transform =
        forge?.gui === undefined
          ? transformOf(display.gui, identityGuiTransform)
          : forgeGuiTransform(forge.gui);
      if (!transform) return;
      const images = new Map<string, PNG>();
      for (const face of faces) {
        signal.throwIfAborted();
        if (images.has(face.texture)) continue;
        if (images.size >= 32) return;
        const resource = resolveTexture(face.texture);
        if (!resource) return;
        const image = decodeItemPng(
          await read(pathFor(resource, 'textures', 'png'), 512 * 1024),
          !fullSkin,
        );
        if (!image) return;
        if (fullSkin && (image.width !== 64 || image.height !== 64)) return;
        images.set(face.texture, image);
      }
      output = rasterizeItem(faces, images, transform, model.gui_light === 'front', signal);
    }
    if (!output) return;
    const encoded = PNG.sync.write(output);
    if (encoded.length > 512 * 1024) return;
    return `data:image/png;base64,${encoded.toString('base64')}`;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ViewerFormatError || error instanceof SyntaxError) return;
    throw error;
  }
}
