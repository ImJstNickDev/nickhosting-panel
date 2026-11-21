import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';

const mirrorBase = 'https://metiva.imjstnick.com/p/pascard-openworld/r/dedicated-linux-server-x64';
const upstreamOrigin = 'https://core.openworld.pascard.com';
const officialFiles = 'https://ow-bucket.s3.eu-west-par.io.cloud.ovh.net';
const archiveLimit = 128 * 1024 * 1024;
const manifestLimit = 8 * 1024 * 1024;
export const openworldReleaseSchema = z.object({
  version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(archiveLimit),
});
export type OpenworldRelease = z.infer<typeof openworldReleaseSchema>;
interface Artifact extends OpenworldRelease {
  url: string;
}

const file = openworldReleaseSchema.omit({ version: true }).extend({ url: z.url() });
const mirror = z.object({
  schema_version: z.literal(1),
  project: z.literal('pascard-openworld'),
  runtime: z.literal('dedicated-linux-server-x64'),
  releases: z
    .array(
      z.object({
        version: openworldReleaseSchema.shape.version,
        artifacts: z
          .array(file.extend({ filename: z.string(), logical_path: z.string().optional() }))
          .max(256),
      }),
    )
    .max(10000),
});
const officialRelease = z.object({
  version: openworldReleaseSchema.shape.version,
  hidden: z.boolean().optional(),
  below_floor: z.boolean().optional(),
  server: z.object({ 'linux-x64': file.optional() }).nullish(),
});
const officialPage = z.object({
  channel: z.string(),
  page: z.int().positive(),
  pages: z.int().positive().max(64),
  versions: z.array(officialRelease).max(1000),
});
const channel = z.object({ pages: z.int().nonnegative().max(64) });
const official = z.object({
  client: z.object({
    channels: z.object({ alpha: channel, snapshot: channel.optional() }),
    recent: z.array(officialRelease).max(1000).optional(),
  }),
});
const unavailable = () => new DomainError('integration_unavailable');

async function readBytes(
  http: typeof fetch,
  url: string,
  limit: number,
  token?: string,
  exact?: number,
) {
  const response = await http(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(exact ? 90_000 : 8_000),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const length = response.headers.get('content-length');
  if (
    !response.ok ||
    !response.body ||
    (length !== null &&
      (Number(length) > limit || (exact !== undefined && Number(length) !== exact)))
  ) {
    await response.body?.cancel();
    throw unavailable();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const output = exact === undefined ? undefined : Buffer.allocUnsafe(exact);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > limit) throw unavailable();
      if (output) output.set(value, offset);
      else chunks.push(value);
      offset += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (exact !== undefined && offset !== exact) throw unavailable();
  return output ?? Buffer.concat(chunks, offset);
}

function safeArchiveUrl(url: string, prefix: string) {
  const parsed = new URL(url);
  if (
    !url.startsWith(prefix) ||
    !parsed.href.startsWith(prefix) ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  )
    throw unavailable();
  return parsed.href;
}

async function mirrorCatalog(http: typeof fetch, token: string) {
  const body = await readBytes(http, `${mirrorBase}/manifest.json`, manifestLimit, token);
  const manifest = mirror.parse(JSON.parse(body.toString()));
  return manifest.releases.flatMap(({ version, artifacts }): Artifact[] => {
    const filename = `openworld-server-${version}-linux-x64.zip`;
    const matching = artifacts.filter(
      (asset) => asset.logical_path?.split('/').at(-1) === filename || asset.filename === filename,
    );
    if (matching.length > 1) throw unavailable();
    const asset = matching[0];
    if (!asset) return [];
    const prefix = `${mirrorBase}/files/${version}/`;
    return [
      { version, sha256: asset.sha256, size: asset.size, url: safeArchiveUrl(asset.url, prefix) },
    ];
  });
}

function officialArtifact(release: z.infer<typeof officialRelease>): Artifact | undefined {
  const asset = release.server?.['linux-x64'];
  if (!asset) return;
  const url = safeArchiveUrl(asset.url, `${officialFiles}/releases/`);
  if (
    new URL(url).pathname.split('/').at(-1) !== `openworld-server-${release.version}-linux-x64.zip`
  )
    throw unavailable();
  return { version: release.version, size: asset.size, sha256: asset.sha256, url };
}

async function officialCatalog(http: typeof fetch, pinnedVersion?: string) {
  const body = await readBytes(http, `${upstreamOrigin}/manifest.json`, manifestLimit);
  const { channels, recent } = official.parse(JSON.parse(body.toString())).client;
  if (pinnedVersion) {
    const release = recent?.find((item) => item.version === pinnedVersion);
    const artifact = release && officialArtifact(release);
    if (artifact) return [artifact];
  }
  const result: Artifact[] = [];
  for (const name of ['alpha', 'snapshot'] as const) {
    const pages = channels[name]?.pages ?? 0;
    for (let page = 1; page <= pages; page++) {
      const raw = await readBytes(
        http,
        `${upstreamOrigin}/c/manifest/client/${name}-${page}.json`,
        manifestLimit,
      );
      const listing = officialPage.parse(JSON.parse(raw.toString()));
      if (listing.page !== page || listing.channel !== name || listing.pages !== pages)
        throw unavailable();
      for (const release of listing.versions) {
        if (
          pinnedVersion ? release.version !== pinnedVersion : release.hidden || release.below_floor
        )
          continue;
        const asset = officialArtifact(release);
        if (!asset) continue;
        if (pinnedVersion) return [asset];
        result.push(asset);
      }
    }
  }
  return result;
}

function publicReleases(artifacts: Artifact[]): OpenworldRelease[] {
  const versions = new Map<string, OpenworldRelease>();
  for (const { version, size, sha256 } of artifacts) {
    if (versions.has(version)) throw unavailable();
    versions.set(version, { version, size, sha256 });
  }
  if (!versions.size) throw unavailable();
  return [...versions.values()].sort(
    (a, b) =>
      Number(a.version.startsWith('pre-')) - Number(b.version.startsWith('pre-')) ||
      b.version.localeCompare(a.version, 'en', { numeric: true }),
  );
}

export async function readOpenworldCatalog(
  token?: string,
  http: typeof fetch = fetch,
): Promise<OpenworldRelease[]> {
  if (token) {
    try {
      return publicReleases(await mirrorCatalog(http, token));
    } catch {
      /* Try the publisher's catalogue. */
    }
  }
  try {
    return publicReleases(await officialCatalog(http));
  } catch {
    throw unavailable();
  }
}

export async function readOpenworldArchive(
  release: OpenworldRelease,
  token?: string,
  http: typeof fetch = fetch,
) {
  const pin = openworldReleaseSchema.parse(release);
  async function download(artifacts: Artifact[], bearer?: string) {
    const matches = artifacts.filter((a) => a.version === pin.version);
    if (matches.length !== 1 || matches[0]?.sha256 !== pin.sha256 || matches[0].size !== pin.size)
      throw new DomainError('provenance_mismatch');
    const bytes = await readBytes(http, matches[0].url, pin.size, bearer, pin.size);
    if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256)
      throw new DomainError('provenance_mismatch');
    return bytes;
  }
  let mismatch = false;
  if (token) {
    try {
      return await download(await mirrorCatalog(http, token), token);
    } catch (error) {
      mismatch = error instanceof DomainError && error.code === 'provenance_mismatch';
    }
  }
  try {
    return await download(await officialCatalog(http, pin.version));
  } catch (error) {
    if (mismatch || (error instanceof DomainError && error.code === 'provenance_mismatch'))
      throw new DomainError('provenance_mismatch');
    throw unavailable();
  }
}
