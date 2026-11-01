import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { type RuntimeMetadataClient, trustedMinecraftArtifactUrl } from './runtime.js';
export const minecraftManifestUrl =
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
/** Metadata v2 is the hash-bearing form of Mojang's launcher manifest. Catalog presence
 * is discovery only, never proof of a dedicated server artifact or tested compatibility. */
export async function minecraftReleaseCatalog(client: RuntimeMetadataClient, all = false) {
  const document = await client.read(minecraftManifestUrl);
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(document.bytes));
  } catch {
    throw new DomainError('integration_unavailable', 503, { reason: 'minecraft_metadata_invalid' });
  }
  const parsed = z
    .object({
      versions: z
        .array(
          z.object({
            id: z.string().min(1).max(128),
            type: z.enum(['release', 'snapshot', 'old_alpha', 'old_beta']),
            url: z.string(),
            sha1: z.string().regex(/^[a-f0-9]{40}$/i),
            releaseTime: z.iso.datetime({ offset: true }).optional(),
          }),
        )
        .max(20000),
    })
    .safeParse(data);
  if (
    !parsed.success ||
    new Set(parsed.data.versions.map((item) => item.id)).size !== parsed.data.versions.length
  )
    throw new DomainError('integration_unavailable', 503, { reason: 'minecraft_metadata_invalid' });
  return parsed.data.versions
    .filter((item) => all || item.type === 'release')
    .sort(
      (left, right) =>
        Date.parse(right.releaseTime ?? '1970-01-01T00:00:00Z') -
        Date.parse(left.releaseTime ?? '1970-01-01T00:00:00Z'),
    )
    .map((item) => ({
      ...item,
      url: trustedMinecraftArtifactUrl(item.url),
    }));
}

/** Stable releases use numeric ordering (26.1 follows 1.21.11). Keep historical
 * families separate; opaque snapshot identifiers have deterministic natural order,
 * not an invented release timestamp. Owner discovery uses Mojang releaseTime above. */
export function compareMinecraftChoices(
  left: {
    version: string;
    releaseType: 'release' | 'snapshot' | 'old_alpha' | 'old_beta';
    runtime: string;
    id: string;
  },
  right: {
    version: string;
    releaseType: 'release' | 'snapshot' | 'old_alpha' | 'old_beta';
    runtime: string;
    id: string;
  },
) {
  const family = { release: 0, snapshot: 1, old_beta: 2, old_alpha: 3 };
  const compare = new Intl.Collator('en', { numeric: true, sensitivity: 'variant' }).compare;
  return (
    family[left.releaseType] - family[right.releaseType] ||
    compare(right.version, left.version) ||
    compare(left.runtime, right.runtime) ||
    compare(left.id, right.id)
  );
}
