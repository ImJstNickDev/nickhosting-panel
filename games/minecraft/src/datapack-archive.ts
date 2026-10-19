import {
  type ContentLimits,
  fail,
  readArchiveFile,
  visitArchive,
} from '@nickhosting/content-providers';
import { inspectMinecraftDatapackMetadata, type MinecraftDatapackMetadata } from './datapacks.js';

/** Inspect metadata once during preparation. ZIPs remain ZIPs: no full extraction,
 * per-file provider call or repeated hashing at publication. Shared archive checks
 * bound central-directory entries, metadata, traversal and compression ratios. */
export async function inspectMinecraftDatapackArchive(
  path: string | Uint8Array,
  release: string,
  limits: Partial<ContentLimits> = {},
): Promise<MinecraftDatapackMetadata> {
  let raw: unknown;
  await visitArchive(
    path,
    async (file) => {
      if (file.path !== 'pack.mcmeta') return;
      try {
        raw = JSON.parse(
          (
            await readArchiveFile(file, Math.min(limits.maxMetadataBytes ?? 1024 ** 2, 1024 ** 2))
          ).toString('utf8'),
        );
      } catch {
        fail('datapack_metadata');
      }
    },
    limits,
  );
  // Empty/filter-only packs can be valid. The game's loader, not a fabricated
  // mandatory data/ entry, decides which resources this pack contributes.
  if (!raw) fail('datapack_structure');
  const result = inspectMinecraftDatapackMetadata(raw, release);
  if (result.compatibility === 'invalid') fail('datapack_metadata');
  return result;
}
