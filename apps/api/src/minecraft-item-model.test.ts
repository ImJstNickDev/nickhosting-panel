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
