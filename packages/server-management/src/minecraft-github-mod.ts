import {
  type ContentArtifact,
  type ContentHttp,
  SafeContentHttp,
} from '@nickhosting/content-providers';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { githubReleaseSource } from '../../../games/minecraft/src/mod-contracts.js';

const asset = z.object({
  id: z.number().int().positive().safe(),
  name: z.string(),
  state: z.literal('uploaded'),
  browser_download_url: z.string(),
  size: z.number().int().positive().safe(),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export async function githubModArtifact(
  url: string,
  userAgent: string,
  downloadOrigins: readonly string[],
  override?: ContentHttp,
  signal?: AbortSignal,
) {
  const releaseSource = githubReleaseSource(url);
  if (!releaseSource) throw new DomainError('validation_failed');
  const { repository, tag, asset: filename } = releaseSource;
  const allowedOrigins = [
    'https://github.com',
    'https://release-assets.githubusercontent.com',
  ].filter((origin) => downloadOrigins.includes(origin));
  if (!allowedOrigins.includes('https://github.com'))
    throw new DomainError('validation_failed', 400, { reason: 'download_origin' });
  const metadata =
    override ?? new SafeContentHttp({ allowedOrigins: ['https://api.github.com'], userAgent });
  const http =
    override ??
    new SafeContentHttp({
      allowedOrigins,
      userAgent,
    });
  const release = z
    .object({
      tag_name: z.literal(tag),
      draft: z.literal(false),
      assets: z.array(z.unknown()).max(1000),
    })
    .safeParse(
      await metadata.json(
        `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
        { signal },
      ),
    );
  if (!release.success) throw new DomainError('integration_unavailable');
  const file = release.data.assets
    .map((entry) => asset.safeParse(entry))
    .find(
      (result) =>
        result.success &&
        result.data.name === filename &&
        new URL(url).href === result.data.browser_download_url,
    );
  if (!file?.success) throw new DomainError('validation_failed');
  const artifact = {
    kind: 'mod',
    serverSide: 'unknown',
    projectId: repository,
    versionId: String(file.data.id),
    path: `mods/${filename}`,
    urls: [url],
    size: file.data.size,
    hashes: { sha256: file.data.digest.slice(7) },
  } satisfies ContentArtifact;
  return { http, artifact };
}

export function matchesGithubModLoader(loader: string, descriptors: readonly string[]) {
  switch (loader) {
    case 'fabric':
      return descriptors.includes('fabric.mod.json');
    case 'quilt':
      return descriptors.includes('quilt.mod.json') || descriptors.includes('fabric.mod.json');
    case 'forge':
      return descriptors.includes('META-INF/mods.toml') || descriptors.includes('mcmod.info');
    case 'neoforge':
      return (
        descriptors.includes('META-INF/neoforge.mods.toml') ||
        descriptors.includes('META-INF/mods.toml')
      );
    default:
      return false;
  }
}
