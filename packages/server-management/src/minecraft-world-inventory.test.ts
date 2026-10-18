import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectMinecraftWorlds } from './minecraft-content.js';
import { inspectMinecraftCombination } from './minecraft-registry.js';

vi.mock('./minecraft-registry.js', () => ({ inspectMinecraftCombination: vi.fn() }));
const inspect = vi.mocked(inspectMinecraftCombination);
function named(type: number, name: string, value: Buffer) {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(Buffer.byteLength(name));
  return Buffer.concat([Buffer.from([type]), length, Buffer.from(name), value]);
}
const version = Buffer.alloc(4);
version.writeInt32BE(169);
const level = Buffer.concat([
  Buffer.from([10, 0, 0]),
  named(
    10,
    'Data',
    Buffer.concat([
      named(3, 'DataVersion', version),
      named(
        10,
        'Version',
        Buffer.concat([
          named(8, 'Name', Buffer.from([0, 3, ...Buffer.from('1.9')])),
          Buffer.from([0]),
        ]),
      ),
      Buffer.from([0]),
    ]),
  ),
  Buffer.from([0]),
]);

function fixture(
  options: { installed?: boolean; missing?: boolean; properties?: string; level?: Buffer } = {},
) {
  const worldLevel = options.level ?? level;
  const profile = options.missing
    ? undefined
    : {
        combination_id: 'choice',
        installed: options.installed ?? true,
      };
  const db = {
    selectFrom: (table: string) => {
      const query = {
        selectAll: () => query,
        where: () => query,
        executeTakeFirst: async () =>
          table === 'minecraft_server_profiles'
            ? profile
            : { pterodactyl_identifier: 'provider', id: 'server' },
      };
      return query;
    },
  } as unknown as Kysely<Database>;
  const readFile = vi.fn(async () => Buffer.from(options.properties ?? 'level-name=Older World\n'));
  const listFiles = vi.fn(async (_identifier: string, directory?: string) =>
    directory
      ? [{ name: 'level.dat', is_file: true, size: worldLevel.length }]
      : [{ name: 'older', is_file: false }],
  );
  const downloadFile = vi.fn(async () => ({
    body: new Response(Uint8Array.from(worldLevel)).body,
  }));
  const adapter = { readFile, listFiles, downloadFile } as unknown as PterodactylAdapter;
  const authorize = vi.fn(async () => {});
  return { db, adapter, authorize, readFile, listFiles, downloadFile };
}

beforeEach(() => {
  inspect.mockResolvedValue({
    combination: { release: '26.1' },
    evidence: [],
    row: { identity_digest: 'choice' },
  } as unknown as Awaited<ReturnType<typeof inspectMinecraftCombination>>);
});

describe('Minecraft world inventory snapshot', () => {
  it('reads live selection once, preserves legacy names and exposes metadata without compatibility evidence', async () => {
    const f = fixture();
    const snapshot = await inspectMinecraftWorlds(f.db, f.adapter, 'server', f.authorize);
    expect(snapshot).toMatchObject({
      installed: true,
      supported: true,
      selectedWorld: 'Older World',
      release: '26.1',
      compatibility: 'available',
      worlds: [
        {
          name: 'older',
          status: 'incompatible',
          validation: { dataVersion: 169, versionName: '1.9' },
        },
      ],
    });
    expect(f.readFile).toHaveBeenCalledExactlyOnceWith('provider', 'server.properties', 1048576);
    expect(f.listFiles).toHaveBeenCalledTimes(2);
    expect(f.downloadFile).toHaveBeenCalledTimes(1);
  });

  it('uses release metadata with no per-server evidence', async () => {
    inspect.mockResolvedValue({
      combination: { release: '1.9' },
      evidence: [],
    } as unknown as Awaited<ReturnType<typeof inspectMinecraftCombination>>);
    const f = fixture();
    expect(await inspectMinecraftWorlds(f.db, f.adapter, 'server', f.authorize)).toMatchObject({
      compatibility: 'available',
      worlds: [{ status: 'verified', validation: { dataVersion: 169, versionName: '1.9' } }],
    });
  });

  it('does not let a report redefine an unknown release or trust the uploaded world', async () => {
    inspect.mockResolvedValue({
      combination: { release: 'future-unknown' },
      evidence: [{ server: { worldDataVersion: 169 }, checks: { installation: true } }],
    } as unknown as Awaited<ReturnType<typeof inspectMinecraftCombination>>);
    const f = fixture();
    expect(await inspectMinecraftWorlds(f.db, f.adapter, 'server', f.authorize)).toMatchObject({
      compatibility: 'unavailable',
      worlds: [{ status: 'unknown', validation: { dataVersion: 169 } }],
    });
  });

  it('keeps a legacy Anvil world visible without inventing a release or repeating reads', async () => {
    const storageVersion = Buffer.alloc(4);
    storageVersion.writeInt32BE(19133);
    const legacy = Buffer.concat([
      Buffer.from([10, 0, 0]),
      named(10, 'Data', Buffer.concat([named(3, 'version', storageVersion), Buffer.from([0])])),
      Buffer.from([0]),
    ]);
    const f = fixture({ level: legacy });
    const snapshot = await inspectMinecraftWorlds(f.db, f.adapter, 'server', f.authorize);
    expect(snapshot.worlds).toMatchObject([
      { name: 'older', status: 'unknown', validation: { storageVersion: 19133 } },
    ]);
    expect(snapshot.worlds[0]?.validation?.dataVersion).toBeUndefined();
    expect(snapshot.worlds[0]?.validation?.versionName).toBeUndefined();
    expect(f.readFile).toHaveBeenCalledTimes(1);
    expect(f.listFiles).toHaveBeenCalledTimes(2);
    expect(f.downloadFile).toHaveBeenCalledTimes(1);
  });

  it('returns installation state without attempting files before installation', async () => {
    const f = fixture({ installed: false });
    expect(await inspectMinecraftWorlds(f.db, f.adapter, 'server', f.authorize)).toMatchObject({
      installed: false,
      selectedWorld: null,
      worlds: [],
    });
    expect(f.readFile).not.toHaveBeenCalled();
    expect(f.listFiles).not.toHaveBeenCalled();
  });

  it('rejects absent profiles and provider property errors instead of inventing an empty world list', async () => {
    const missing = fixture({ missing: true });
    await expect(
      inspectMinecraftWorlds(missing.db, missing.adapter, 'server', missing.authorize),
    ).rejects.toMatchObject({ code: 'not_found' });
    const broken = fixture();
    broken.readFile.mockRejectedValue(new DomainError('integration_unavailable'));
    await expect(
      inspectMinecraftWorlds(broken.db, broken.adapter, 'server', broken.authorize),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(broken.listFiles).not.toHaveBeenCalled();
  });

  it('refuses to return an inventory when final authorization is revoked', async () => {
    const f = fixture();
    f.authorize.mockRejectedValue(new DomainError('forbidden'));
    await expect(
      inspectMinecraftWorlds(f.db, f.adapter, 'server', f.authorize),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.authorize).toHaveBeenCalled();
  });
});
