import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';

/** Metadata revision is explicit and reviewable, never a mutable "latest" codec. */
export const defaultMinecraftProtocolSource = {
  commit: '33a0f3e7323e124a81960a6d6c62df797d69cd85',
  sha256: 'ec1186190718bd975bbe364920a7ca590fbd9de4fba83ffb29c0f098e1ea938f',
};
const protocolRowSchema = z.object({
  minecraftVersion: z.string().min(1).max(128),
  version: z.number().int().nonnegative().max(2147483647),
  usesNetty: z.boolean(),
  releaseType: z.enum(['release', 'snapshot', 'old_alpha', 'old_beta']).optional(),
});

export async function fetchMinecraftProtocols(
  source = defaultMinecraftProtocolSource,
  fetcher: typeof fetch = fetch,
) {
  if (!/^[a-f0-9]{40}$/.test(source.commit) || !/^[a-f0-9]{64}$/.test(source.sha256))
    throw new DomainError('configuration_invalid');
  const url = `https://raw.githubusercontent.com/PrismarineJS/minecraft-data/${source.commit}/data/pc/common/protocolVersions.json`;
  try {
    const response = await fetcher(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok || !response.body) throw new Error('unavailable');
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 4 * 1024 * 1024) throw new Error('oversized');
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel();
    }
    const body = Buffer.concat(chunks);
    if (createHash('sha256').update(body).digest('hex') !== source.sha256)
      throw new Error('integrity');
    const rows = z
      .array(protocolRowSchema)
      .max(10000)
      .parse(JSON.parse(body.toString('utf8')));
    const releases = new Map<
      string,
      {
        release: string;
        protocolId: number;
        family: 'netty' | 'legacy';
        transfer: boolean;
        releaseType: 'release' | 'snapshot' | 'old_alpha' | 'old_beta' | 'unknown';
      }
    >();
    for (const row of rows) {
      if (releases.has(row.minecraftVersion)) throw new Error('duplicate');
      releases.set(row.minecraftVersion, {
        release: row.minecraftVersion,
        protocolId: row.version,
        family: row.usesNetty ? 'netty' : 'legacy',
        // Snapshot IDs are a different namespace, not a high release version.
        transfer: row.releaseType === 'release' && row.version >= 766 && row.version < 1073741824,
        releaseType: row.releaseType ?? 'unknown',
      });
    }
    return { source: { url, sha256: source.sha256 }, releases };
  } catch {
    throw new DomainError('integration_unavailable');
  }
}
