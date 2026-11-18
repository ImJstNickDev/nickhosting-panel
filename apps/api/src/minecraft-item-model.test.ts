import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { renderMinecraftItemModel } from './minecraft-item-model.js';

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
function png(size = 16) {
  const image = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4;
      image.data.set([128 + (x % 128), 80 + (y % 128), 30, 255], at);
    }
  return PNG.sync.write(image);
}
async function render(id: string, assets: Record<string, Buffer>) {
  const value = await renderMinecraftItemModel(
    id,
    (path) => Object.hasOwn(assets, path),
    async (path) => assets[path],
    new AbortController().signal,
  );
  return value ? PNG.sync.read(Buffer.from(value.split(',')[1] ?? '', 'base64')) : undefined;
}
function bounds(image: PNG | undefined) {
  expect(image).toBeDefined();
  if (!image) throw new Error('Missing icon');
  let left = 32,
    top = 32,
    right = -1,
    bottom = -1;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++)
      if (image.data[(y * image.width + x) * 4 + 3]) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  return [left, top, right, bottom] as const;
}

describe('native GUI model rendering', () => {
  it('renders inherited cube geometry with native GUI framing, without fitting the alpha bounds', async () => {
    const assets = {
      'assets/quark/models/item/diorite_bricks.json': json({
        parent: 'quark:block/diorite_bricks',
      }),
      'assets/quark/models/block/diorite_bricks.json': json({
        parent: 'block/cube_all',
        textures: { all: 'quark:block/diorite_bricks' },
      }),
      'assets/quark/textures/block/diorite_bricks.png': png(),
    };
    const image = await render('quark:diorite_bricks', assets);
    expect([image?.width, image?.height]).toEqual([32, 32]);
    expect(bounds(image)).toEqual([2, 1, 29, 30]);
    assets['assets/quark/models/item/diorite_bricks.json'] = json({
      parent: 'quark:block/diorite_bricks',
      display: { gui: { rotation: [30, 225, 0], scale: [0.3125, 0.3125, 0.3125] } },
    });
    expect(bounds(await render('quark:diorite_bricks', assets))).toEqual([9, 8, 22, 23]);
    assets['assets/quark/models/item/diorite_bricks.json'] = json({
      elements: [
        {
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: { constructor: { texture: '#all' } },
          rotation: { origin: [8, 8, 8], axis: 'x', angle: 0 },
        },
      ],
    });
    expect(await render('quark:diorite_bricks', assets)).toBeUndefined();
  });

  it('uses the declared Mekanism OBJ and MTL inventory groups, preserving the thin cable geometry', async () => {
    const assets = {
      'assets/mekanism/models/item/fixture_cable.json': json({ parent: 'mekanism:block/cable' }),
      'assets/mekanism/models/block/cable.json': json({
        parent: 'block/block',
        loader: 'mekanism:transmitter',
        model: 'mekanism:models/block/cable.obj.mek',
        'flip-v': true,
        textures: { center: 'mekanism:block/cable' },
      }),
      'assets/mekanism/models/block/cable.obj.mek': Buffer.from(
        'mtllib cable.mtl\no northNONE\nv .3125 0 .3125\nv .6875 0 .3125\nv .6875 1 .3125\nv .3125 1 .3125\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nusemtl Surface\nf 1/1 2/2 3/3 4/4\no northPUSH\nf 99/99 99/99 99/99\n',
      ),
      'assets/mekanism/models/block/cable.mtl': Buffer.from('newmtl Surface\nmap_Kd #center\n'),
      'assets/mekanism/textures/block/cable.png': png(),
    };
    const box = bounds(await render('mekanism:fixture_cable', assets));
    expect(box[2] - box[0]).toBeLessThan(8);
    expect(box[3] - box[1]).toBeGreaterThan(16);
    assets['assets/mekanism/models/block/cable.obj.mek'] = Buffer.from('mtllib ../escape.mtl');
    expect(await render('mekanism:fixture_cable', assets)).toBeUndefined();
  });

  it('renders Forge OBJ groups and materials with the declared quaternion GUI transform', async () => {
    const assets = {
      'assets/fixture/models/item/glasshouse.json': json({
        loader: 'forge:obj',
        model: 'fixture:models/block/glasshouse.obj.ie',
        'flip-v': true,
        transform: {
          gui: {
            origin: 'corner',
            translation: [0.125, 0, 0],
            rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
            scale: [0.25, 0.5, 1],
            'post-rotation': [0, 0, 0, 1],
          },
        },
      }),
      'assets/fixture/models/block/glasshouse.obj.ie': Buffer.from(
        'mtllib glasshouse.mtl\no glass\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nusemtl glass\nf 1/1 2/2 3/3 4/4\n',
      ),
      'assets/fixture/models/block/glasshouse.mtl': Buffer.from(
        'newmtl glass\nmap_Kd fixture:block/glass\n',
      ),
      'assets/fixture/textures/block/glass.png': png(),
    };
    expect(bounds(await render('fixture:glasshouse', assets))).toEqual([12, 12, 27, 19]);
  });

  it('admits detailed cuboid models up to the raster face budget', async () => {
    const face = { texture: '#all' };
    const cube = {
      from: [1, 1, 1],
      to: [15, 15, 15],
      faces: { up: face, down: face, north: face, south: face, east: face, west: face },
    };
    const model = (count: number) =>
      json({
        parent: 'block/block',
        textures: { all: 'fixture:block/pillar' },
        elements: Array(count).fill(cube),
      });
    const assets = {
      'assets/fixture/models/item/generator.json': model(83),
      'assets/fixture/textures/block/pillar.png': png(),
    };
    expect(await render('fixture:generator', assets)).toBeDefined();
    assets['assets/fixture/models/item/generator.json'] = model(86);
    expect(await render('fixture:generator', assets)).toBeUndefined();
  });

  it('uses the untrimmed armor model and dyes only the base layer', async () => {
    const base = new PNG({ width: 2, height: 2 });
    base.data.fill(255);
    const overlay = new PNG({ width: 2, height: 2 });
    overlay.data.fill(0);
    overlay.data.fill(255, 4, 8);
    const assets = {
      'assets/minecraft/items/leather_helmet.json': json({
        model: {
          type: 'minecraft:select',
          property: 'minecraft:trim_material',
          fallback: {
            type: 'minecraft:model',
            model: 'minecraft:item/leather_helmet',
            tints: [{ type: 'minecraft:dye', default: -6265536 }],
          },
        },
      }),
      'assets/minecraft/models/item/leather_helmet.json': json({
        parent: 'item/generated',
        textures: { layer0: 'item/leather_helmet', layer1: 'item/leather_helmet_overlay' },
      }),
      'assets/minecraft/textures/item/leather_helmet.png': PNG.sync.write(base),
      'assets/minecraft/textures/item/leather_helmet_overlay.png': PNG.sync.write(overlay),
    };
    const result = await render('minecraft:leather_helmet', assets);
    expect([...(result?.data.subarray(0, 8) ?? [])]).toEqual([
      160, 101, 64, 255, 255, 255, 255, 255,
    ]);
  });

  it('renders the verified closed Cuboid chest family with its skin UVs and rejects unknown entity models', async () => {
    const assets = {
      'assets/cuboidmod/models/item/fixture_chest.json': json({
        parent: 'builtin/entity',
        display: { gui: { rotation: [30, 45, 0], scale: [0.625, 0.625, 0.625] } },
      }),
      'assets/cuboidmod/textures/model/fixture_chest.png': png(64),
      'assets/unknown/models/item/fixture_chest.json': json({ parent: 'builtin/entity' }),
      'assets/unknown/textures/model/fixture_chest.png': png(64),
    };
    const image = await render('cuboidmod:fixture_chest', assets);
    expect(bounds(image)).toEqual([4, 4, 27, 30]);
    expect(await render('unknown:fixture_chest', assets)).toBeUndefined();
    assets['assets/cuboidmod/textures/model/fixture_chest.png'] = png(32);
    expect(await render('cuboidmod:fixture_chest', assets)).toBeUndefined();
  });
});
