import { gzipSync } from 'node:zlib';
import { writeUncompressed } from 'prismarine-nbt';
import { describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { inspectMinecraftDatapackArchive } from './datapack-archive.js';
import {
  inspectMinecraftDatapackMetadata as inspect,
  minecraftDatapackFormat,
  minecraftSupportsDatapacks,
} from './datapacks.js';
import { inspectMinecraftDatapackSelection } from './world.js';

function zip(entries: Record<string, string>) {
  const archive = new ZipFile();
  for (const [name, contents] of Object.entries(entries))
    archive.addBuffer(Buffer.from(contents), name);
  const result = new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    archive.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on('error', reject);
  });
  archive.end();
  return result;
}

describe('Minecraft datapack declarations', () => {
  it('uses pack formats, not world DataVersion, including exact minor versions', () => {
    expect(minecraftDatapackFormat('26.1')).toEqual([101, 1]);
    expect(minecraftDatapackFormat('1.21.9')).toEqual([88, 0]);
    expect(minecraftDatapackFormat('1.20.2')).toEqual([18, 0]);
    expect(minecraftDatapackFormat('99.1')).toBeUndefined();
  });
  it.each(['1.5.2', '1.12.2', '17w42a', 'b1.8.1', 'a1.0.15'])(
    'does not advertise packs for %s',
    (version) => {
      expect(minecraftSupportsDatapacks(version)).toBe(false);
    },
  );
  it.each(['1.13', '1.13.2', '17w43a', '26.1', '26.4-snapshot-4'])(
    'recognizes datapack era %s',
    (version) => {
      expect(minecraftSupportsDatapacks(version)).toBe(true);
    },
  );
  it('reads legacy exact format and declares mismatch honestly', () => {
    expect(
      inspect({ pack: { description: 'Recipes', pack_format: 4 } }, '1.14').compatibility,
    ).toBe('compatible');
    expect(
      inspect({ pack: { description: 'Recipes', pack_format: 4 } }, '26.1').compatibility,
    ).toBe('incompatible');
  });
  it.each([18, [18, 32], { min_inclusive: 18, max_inclusive: 32 }])(
    'accepts supported_formats %j',
    (supported_formats) => {
      expect(
        inspect({ pack: { description: 'Recipes', pack_format: 18, supported_formats } }, '1.20.2')
          .compatibility,
      ).toBe('compatible');
    },
  );
  it('old games ignore supported_formats instead of claiming false compatibility', () => {
    expect(
      inspect(
        { pack: { description: 'Recipes', pack_format: 18, supported_formats: [4, 18] } },
        '1.14',
      ).compatibility,
    ).toBe('incompatible');
  });
  it('interprets a modern integer maximum as all minor versions, not .0', () => {
    const result = inspect(
      { pack: { description: 'Recipes', min_format: [101], max_format: 101 } },
      '26.1',
    );
    expect(result.compatibility).toBe('compatible');
    expect(result.formatMin).toEqual([101, 0]);
    expect(result.formatMax).toEqual([101, 0x7fffffff]);
    expect(
      inspect({ pack: { description: '', min_format: 101, max_format: [101, 0] } }, '26.1')
        .compatibility,
    ).toBe('incompatible');
  });
  it('reads modern/legacy spanning metadata according to the target game', () => {
    const raw = {
      pack: {
        description: 'Cross-version',
        pack_format: 18,
        supported_formats: [18, 101],
        min_format: 18,
        max_format: 101,
      },
    };
    expect(inspect(raw, '1.20.2').compatibility).toBe('compatible');
    expect(inspect(raw, '26.1').compatibility).toBe('compatible');
  });
  it.each([
    {},
    { pack: {} },
    { pack: { description: '', min_format: 101 } },
    { pack: { description: '', min_format: 102, max_format: 101 } },
    { pack: { description: '', pack_format: -1 } },
    { pack: { description: '', pack_format: 101 } },
    { pack: { description: '', min_format: 101, max_format: 101, supported_formats: 101 } },
    { pack: { description: '', min_format: 18, max_format: 101 } },
    { pack: { description: '', pack_format: 18, supported_formats: [32, 18] } },
  ])('rejects malformed or incomplete metadata %j', (raw) => {
    expect(inspect(raw, '26.1').compatibility).toBe('invalid');
  });
  it('does not claim unverified future formats or feature-flag support', () => {
    const pack = { description: '', min_format: 101, max_format: 101 };
    expect(inspect({ pack }, '99.1').compatibility).toBe('unknown');
    expect(
      inspect({ pack, features: { enabled: ['minecraft:experimental'] } }, '26.1').compatibility,
    ).toBe('unknown');
  });
  it('converts bounded descriptions to text without executing component events', () => {
    const result = inspect(
      {
        pack: {
          pack_format: 4,
          description: {
            text: 'Hi',
            extra: [{ text: ' there', clickEvent: { action: 'run_command', value: '/stop' } }],
          },
        },
      },
      '1.14',
    );
    expect(result.description).toBe('Hi there');
  });
});

describe('datapack ZIP preparation', () => {
  it('inspects the root metadata without extracting payload files', async () => {
    const bytes = await zip({
      'pack.mcmeta': JSON.stringify({
        pack: { description: 'Example', min_format: 101, max_format: 101 },
      }),
      'data/example/function/test.mcfunction': 'say Hi',
    });
    expect((await inspectMinecraftDatapackArchive(bytes, '26.1')).compatibility).toBe('compatible');
  });
  it('permits an empty/filter-only pack instead of inventing content requirements', async () => {
    const bytes = await zip({
      'pack.mcmeta': JSON.stringify({ pack: { description: '', pack_format: 4 } }),
    });
    expect((await inspectMinecraftDatapackArchive(bytes, '1.14')).compatibility).toBe('compatible');
  });
  it('rejects a wrapper folder rather than staging a silently undiscoverable ZIP', async () => {
    await expect(
      inspectMinecraftDatapackArchive(await zip({ 'wrapper/pack.mcmeta': '{}' }), '26.1'),
    ).rejects.toThrow();
  });
  it('bounds metadata and rejects malformed JSON during preparation', async () => {
    await expect(
      inspectMinecraftDatapackArchive(await zip({ 'pack.mcmeta': '{' }), '26.1'),
    ).rejects.toThrow();
    await expect(
      inspectMinecraftDatapackArchive(
        await zip({
          'pack.mcmeta': JSON.stringify({ pack: { description: 'Large', pack_format: 4 } }),
        }),
        '1.14',
        { maxMetadataBytes: 4 },
      ),
    ).rejects.toThrow();
  });
});

describe('saved native datapack selection', () => {
  function selection(enabled: string[], disabled: string[]) {
    return writeUncompressed(
      {
        type: 'compound',
        name: '',
        value: {
          Data: {
            type: 'compound',
            value: {
              DataPacks: {
                type: 'compound',
                value: {
                  Enabled: { type: 'list', value: { type: 'string', value: enabled } },
                  Disabled: { type: 'list', value: { type: 'string', value: disabled } },
                },
              },
            },
          },
        },
      },
      'big',
    );
  }
  it('preserves saved order and native disabled IDs using the bounded world decoder', () => {
    const bytes = selection(
      ['vanilla', 'file/second.zip', 'file/first.zip'],
      ['file/disabled.zip'],
    );
    for (const input of [bytes, gzipSync(bytes)]) {
      expect(inspectMinecraftDatapackSelection(input)).toEqual({
        enabled: ['vanilla', 'file/second.zip', 'file/first.zip'],
        disabled: ['file/disabled.zip'],
      });
    }
  });
  it('distinguishes absent saved selection from empty selection', () => {
    expect(inspectMinecraftDatapackSelection(selection([], []))).toEqual({
      enabled: [],
      disabled: [],
    });
    expect(
      inspectMinecraftDatapackSelection(
        writeUncompressed(
          { type: 'compound', name: '', value: { Data: { type: 'compound', value: {} } } },
          'big',
        ),
      ),
    ).toBeUndefined();
  });
  it('rejects broken NBT and command-control characters in saved identifiers', () => {
    expect(() => inspectMinecraftDatapackSelection(new Uint8Array([1, 2, 3, 4]))).toThrow();
    expect(() => inspectMinecraftDatapackSelection(selection([], ['file/no\nstop']))).toThrow();
  });
});
