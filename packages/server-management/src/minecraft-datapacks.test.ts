import type { FilemanReadService } from '@nickhosting/game-sdk';
import { describe, expect, it, vi } from 'vitest';
import { datapacksSupported, verifyDatapackMoves } from './minecraft-datapacks.js';

const file = (name: string, size = 12) => ({ name, size, kind: 'file' as const });
function scope(entries: Record<string, ReturnType<typeof file>[]>) {
  const listMany = vi.fn(async (directories: readonly string[]) =>
    directories.map((directory) => ({ directory, files: entries[directory] ?? [] })),
  );
  return { files: { listMany } as unknown as FilemanReadService, listMany };
}
describe('datapack batch publication receipts', () => {
  it('uses one deduplicated directory batch for all moves', async () => {
    const f = scope({ 'world/datapacks': [file('one.zip'), file('two.zip')] });
    await verifyDatapackMoves(f.files, [
      {
        from: 'world/datapacks/one.zip.pending',
        to: 'world/datapacks/one.zip',
        kind: 'zip',
        size: 12,
      },
      {
        from: 'world/datapacks/two.zip.pending',
        to: 'world/datapacks/two.zip',
        kind: 'zip',
        size: 12,
      },
    ]);
    expect(f.listMany).toHaveBeenCalledExactlyOnceWith(['world/datapacks']);
  });
  it('rejects Wings missing-source 204 rather than declaring installation complete', async () => {
    const f = scope({ 'world/datapacks': [] });
    await expect(
      verifyDatapackMoves(f.files, [
        {
          from: 'world/datapacks/one.zip.pending',
          to: 'world/datapacks/one.zip',
          kind: 'zip',
          size: 12,
        },
      ]),
    ).rejects.toMatchObject({ code: 'operation_uncertain' });
  });
  it('rejects incomplete batches, source leftovers, symlinks and mismatching bytes', async () => {
    for (const entries of [
      [file('one.zip.pending'), file('one.zip')],
      [file('one.zip', 11)],
      [{ ...file('one.zip'), kind: 'symlink' }],
    ]) {
      const files = {
        listMany: async () => [{ directory: 'world/datapacks', files: entries }],
      } as unknown as FilemanReadService;
      await expect(
        verifyDatapackMoves(files, [
          {
            from: 'world/datapacks/one.zip.pending',
            to: 'world/datapacks/one.zip',
            kind: 'zip',
            size: 12,
          },
        ]),
      ).rejects.toMatchObject({ code: 'operation_uncertain' });
    }
  });
  it('verifies ordered replacements after the original destination is reused', async () => {
    const f = scope({
      'world/datapacks': [file('one.zip', 20)],
      '.nickhosting-datapacks/world/retired': [file('old.zip', 12)],
    });
    await verifyDatapackMoves(f.files, [
      {
        from: 'world/datapacks/one.zip',
        to: '.nickhosting-datapacks/world/retired/old.zip',
        kind: 'zip',
        size: 12,
      },
      {
        from: 'world/datapacks/one.zip.pending',
        to: 'world/datapacks/one.zip',
        kind: 'zip',
        size: 20,
      },
    ]);
    expect(f.listMany).toHaveBeenCalledTimes(1);
  });
  it('fails unavailable directory receipts without silently treating them as empty', async () => {
    const files = {
      listMany: async () => [{ directory: 'world/datapacks', error: 'unavailable' }],
    } as unknown as FilemanReadService;
    await expect(
      verifyDatapackMoves(files, [
        {
          from: 'world/datapacks/one.zip.pending',
          to: 'world/datapacks/one.zip',
          kind: 'zip',
          size: 12,
        },
      ]),
    ).rejects.toMatchObject({ code: 'operation_uncertain' });
  });
  it('uses integration version capability rather than enabling historical servers', () => {
    expect(datapacksSupported('1.12.2')).toBe(false);
    expect(datapacksSupported('1.13')).toBe(true);
    expect(datapacksSupported('26.1')).toBe(true);
  });
});
