import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { stageMinecraftWorld } from '../../../games/minecraft/src/world.js';

function named(type: number, name: string, value: Buffer) {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(Buffer.byteLength(name));
  return Buffer.concat([Buffer.from([type]), length, Buffer.from(name), value]);
}
function level() {
  const integer = Buffer.alloc(4);
  integer.writeInt32BE(5000);
  return Buffer.concat([
    Buffer.from([10, 0, 0]),
    named(10, 'Data', Buffer.concat([named(3, 'DataVersion', integer), Buffer.from([0])])),
    Buffer.from([0]),
  ]);
}
/** Minimal stored ZIP fixture; production parsing remains delegated to yauzl. */
function zip(name: string, content: Buffer) {
  const file = Buffer.from(name),
    local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(content), 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(file.length, 26);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(content), 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(file.length, 28);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + file.length, 12);
  end.writeUInt32LE(local.length + file.length + content.length, 16);
  return Buffer.concat([local, file, content, central, file, end]);
}
describe('Minecraft source/staging root separation', () => {
  it('accepts an explicitly scoped sibling source store and rejects aliases or an undeclared root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'nh-minecraft-world-source-'));
    try {
      const sourceRoot = join(parent, 'mountdata', 'sources'),
        mountdataRoot = join(parent, 'mountdata', 'content');
      await mkdir(sourceRoot, { recursive: true });
      const archive = zip('world/level.dat', level()),
        path = join(sourceRoot, 'archive.bin');
      await writeFile(path, archive);
      const options = {
        mountdataRoot,
        sourceRoot,
        jobId: 'fixture',
        targetWorld: 'imported',
        release: '26.1',
        expectedDataVersion: 5000,
        archiveSha256: createHash('sha256').update(archive).digest('hex'),
        diskPolicy: { minimumFreeBytes: 0, minimumFreePercent: 0 },
      };
      const staged = await stageMinecraftWorld(path, options);
      expect(await readFile(join(staged.directory, 'imported', 'level.dat'))).toEqual(level());
      await expect(
        stageMinecraftWorld(path, { ...options, sourceRoot: undefined, jobId: 'unscoped' }),
      ).rejects.toThrow();
      const alias = join(parent, 'mountdata', 'alias');
      await symlink(sourceRoot, alias);
      await expect(
        stageMinecraftWorld(join(alias, 'archive.bin'), {
          ...options,
          sourceRoot: alias,
          jobId: 'aliased',
        }),
      ).rejects.toThrow();
      await expect(
        stageMinecraftWorld(path, { ...options, sourceRoot: '/', jobId: 'broad' }),
      ).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
