import { z } from 'zod';
import { fail } from './contracts.js';
import type { CurseForgeProvider } from './curseforge.js';
import {
  type ModpackCatalogPageInput,
  type ModpackCatalogSearchInput,
  type ModpackCatalogVersion,
  modpackCatalogCategoriesSchema,
  modpackCatalogDetailsSchema,
  modpackCatalogProjectsSchema,
  modpackCatalogVersionsSchema,
} from './modpack-catalog.js';
import {
  download,
  ModpackMetadataCache,
  numericId,
  pageInput,
  providerChannel,
  publicUrl,
  published,
  queryInput,
  str,
  strings,
} from './modpack-catalog-common.js';
import type { ModpackCatalog, ModpackRecipe, ModpackRecipeFile } from './modpack-recipes.js';

const projectSchema = z.object({
  id: numericId,
  gameId: z.literal(432),
  classId: numericId,
  name: str,
  slug: str,
  summary: str,
  authors: z.array(z.object({ name: str })).max(100),
  downloadCount: z.number().nonnegative(),
  logo: z.object({ thumbnailUrl: str }).nullable().optional(),
  allowModDistribution: z.boolean().nullable().optional(),
  isAvailable: z.boolean().default(true),
  links: z.object({ websiteUrl: str }).optional(),
});
const fileSchema = z.object({
  id: numericId,
  modId: numericId,
  displayName: str,
  fileName: str,
  fileLength: z.number().int().nonnegative(),
  downloadUrl: str.nullable(),
  isAvailable: z.boolean(),
  gameVersions: strings,
  fileDate: str,
  releaseType: z.number(),
  hashes: z.array(z.object({ algo: z.number(), value: str })).max(8),
  isServerPack: z.boolean().default(false),
  serverPackFileId: numericId.nullable().optional(),
  parentProjectFileId: numericId.nullable().optional(),
});
type File = z.infer<typeof fileSchema>;
function cfId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    fail('modpack_identity');
  return Number(value);
}
function fileDownload(file: File) {
  const sha1 = file.hashes.find((h) => h.algo === 1)?.value.toLowerCase();
  const md5 = file.hashes.find((h) => h.algo === 2)?.value.toLowerCase();
  if (!file.isAvailable || !file.downloadUrl || (!sha1 && !md5)) return undefined;
  return download({
    filename: file.fileName,
    urls: [file.downloadUrl],
    size: file.fileLength,
    hashes: { ...(sha1 ? { sha1 } : {}), ...(md5 ? { md5 } : {}) },
  });
}
function versionItem(file: File, denied = false): ModpackCatalogVersion {
  const loaders = file.gameVersions
    .filter((v) => /^(forge|neoforge|fabric|quilt|vanilla)$/i.test(v))
    .map((v) => v.toLowerCase());
  return {
    id: String(file.id),
    projectId: String(file.modId),
    name: file.displayName,
    version: file.displayName,
    minecraftVersions: file.gameVersions.filter((v) => /^(?:\d+\.|\d+w)/.test(v)),
    loaders,
    channel: providerChannel(file.releaseType),
    publishedAt: published(file.fileDate),
    bytes: file.fileLength,
    available:
      !denied &&
      file.isAvailable &&
      ((file.serverPackFileId !== undefined && file.serverPackFileId !== null) ||
        !!fileDownload(file)),
    ...(denied || !file.isAvailable || (!file.serverPackFileId && !fileDownload(file))
      ? { unavailableReason: 'distribution' as const }
      : {}),
    source: file.isServerPack || file.serverPackFileId ? 'server-archive' : 'curseforge-manifest',
  };
}
/** Resolve the complete pinned manifest in bounded bulk queries; no latest/dependency lookup. */
export async function resolvePinnedCurseForgeFiles(
  provider: CurseForgeProvider,
  refs: readonly { projectId: number; fileId: number }[],
  signal?: AbortSignal,
): Promise<ModpackRecipeFile[]> {
  if (
    refs.length > 10000 ||
    refs.some(
      (r) =>
        !Number.isSafeInteger(r.projectId) ||
        r.projectId < 1 ||
        !Number.isSafeInteger(r.fileId) ||
        r.fileId < 1,
    )
  )
    fail('modpack_pins');
  if (new Set(refs.map((r) => r.fileId)).size !== refs.length) fail('modpack_pins');
  const files = new Map<number, File>();
  const projects = new Map<
    number,
    { id: number; allowModDistribution?: boolean | null; isAvailable?: boolean }
  >();
  const projectIds = [...new Set(refs.map((r) => r.projectId))];
  // Two requests per 50 records, not one request per file. Concurrency stays bounded at two.
  for (let offset = 0; offset < Math.max(refs.length, projectIds.length); offset += 50) {
    signal?.throwIfAborted();
    const fileIds = refs.slice(offset, offset + 50).map((r) => r.fileId);
    const pids = projectIds.slice(offset, offset + 50);
    const [f, p] = await Promise.all([
      fileIds.length ? provider.modpackBulk('files', fileIds, signal) : [],
      pids.length ? provider.modpackBulk('projects', pids, signal) : [],
    ]);
    for (const item of z.array(fileSchema).max(50).parse(f)) files.set(item.id, item);
    for (const item of z
      .array(
        z.object({
          id: numericId,
          allowModDistribution: z.boolean().nullable().optional(),
          isAvailable: z.boolean().optional(),
        }),
      )
      .max(50)
      .parse(p))
      projects.set(item.id, item);
  }
  return refs.map((ref) => {
    const file = files.get(ref.fileId);
    const project = projects.get(ref.projectId);
    if (
      !file ||
      file.modId !== ref.projectId ||
      !project ||
      project.allowModDistribution === false ||
      project.isAvailable === false
    )
      fail('modpack_pinned_file_unavailable');
    const source = fileDownload(file);
    if (!source || !/\.jar$/i.test(source.filename)) fail('modpack_pinned_file_unavailable');
    return { path: `mods/${source.filename}`, download: source, serverSide: 'unknown' as const };
  });
}
export class CurseForgeModpackCatalog implements ModpackCatalog {
  readonly provider = 'curseforge' as const;
  private readonly cache = new ModpackMetadataCache();
  constructor(private readonly api: CurseForgeProvider) {}
  private request(path: string, signal?: AbortSignal) {
    return this.cache.get(path, () => this.api.modpackMetadata(path, signal), signal);
  }
  private async data(path: string, signal?: AbortSignal) {
    return z.object({ data: z.unknown() }).parse(await this.request(path, signal)).data;
  }
  private async classId(signal?: AbortSignal) {
    const classes = z
      .array(z.object({ id: numericId, slug: str }))
      .parse(await this.data('/categories?gameId=432&classesOnly=true', signal));
    const category = classes.find((c) => c.slug === 'modpacks');
    if (!category) fail('modpack_category');
    return category.id;
  }
  private async project(id: string, signal?: AbortSignal) {
    const [raw, category] = await Promise.all([
      this.data(`/mods/${cfId(id)}`, signal),
      this.classId(signal),
    ]);
    const p = projectSchema.parse(raw);
    if (p.id !== cfId(id) || p.classId !== category) fail('modpack_identity');
    return p;
  }
  private publicProject(p: z.infer<typeof projectSchema>) {
    return {
      id: String(p.id),
      provider: this.provider,
      name: p.name,
      summary: p.summary,
      authors: p.authors.map((a) => a.name),
      downloads: p.downloadCount,
      imageUrl: publicUrl(p.logo?.thumbnailUrl),
      websiteUrl:
        publicUrl(p.links?.websiteUrl) ??
        `https://www.curseforge.com/minecraft/modpacks/${encodeURIComponent(p.slug)}`,
    };
  }
  async categories(signal?: AbortSignal) {
    const classId = await this.classId(signal);
    const categories = z
      .array(z.object({ id: numericId, name: str, classId: numericId.nullable().optional() }))
      .max(1000)
      .parse(await this.data(`/categories?gameId=432&classId=${classId}`, signal));
    return modpackCatalogCategoriesSchema.parse({
      items: categories
        .filter(
          (category) =>
            category.id !== classId && (category.classId == null || category.classId === classId),
        )
        .map((category) => ({ id: String(category.id), name: category.name })),
    });
  }
  async search(input: ModpackCatalogSearchInput = {}, signal?: AbortSignal) {
    const { offset, limit } = pageInput(input);
    const params = new URLSearchParams({
      gameId: '432',
      classId: String(await this.classId(signal)),
      searchFilter: queryInput(input.query),
      index: String(offset),
      pageSize: String(limit),
      sortField: '2',
      sortOrder: 'desc',
    });
    if (input.category) params.set('categoryId', String(cfId(input.category)));
    const raw = z
      .object({
        data: z.array(projectSchema).max(50),
        pagination: z.object({ totalCount: z.number().int().nonnegative() }),
      })
      .parse(await this.request(`/mods/search?${params}`, signal));
    return modpackCatalogProjectsSchema.parse({
      offset,
      limit,
      total: raw.pagination.totalCount,
      items: raw.data.map((p) => this.publicProject(p)),
    });
  }
  async details(id: string, signal?: AbortSignal) {
    const [p, description] = await Promise.all([
      this.project(id, signal),
      this.data(`/mods/${cfId(id)}/description`, signal),
    ]);
    return modpackCatalogDetailsSchema.parse({
      ...this.publicProject(p),
      description: str.parse(description),
      descriptionFormat: 'html',
    });
  }
  async versions(id: string, input: ModpackCatalogPageInput = {}, signal?: AbortSignal) {
    const { offset, limit } = pageInput(input);
    const [p, raw] = await Promise.all([
      this.project(id, signal),
      this.request(`/mods/${cfId(id)}/files?index=${offset}&pageSize=${limit}`, signal),
    ]);
    const list = z
      .object({
        data: z.array(fileSchema).max(50),
        pagination: z.object({ totalCount: z.number().int().nonnegative() }),
      })
      .parse(raw);
    if (list.data.some((f) => f.modId !== p.id)) fail('modpack_identity');
    return modpackCatalogVersionsSchema.parse({
      offset,
      limit,
      total: list.pagination.totalCount,
      items: list.data.map((f) =>
        versionItem(f, p.allowModDistribution === false || !p.isAvailable),
      ),
    });
  }
  async resolve(id: string, versionId: string, signal?: AbortSignal): Promise<ModpackRecipe> {
    const [project, p, raw] = await Promise.all([
      this.details(id, signal),
      this.project(id, signal),
      this.data(`/mods/${cfId(id)}/files/${cfId(versionId)}`, signal),
    ]);
    const selected = fileSchema.parse(raw);
    if (selected.id !== cfId(versionId) || selected.modId !== p.id) fail('modpack_identity');
    const version = versionItem(selected, p.allowModDistribution === false || !p.isAvailable);
    if (!version.available)
      return {
        provider: this.provider,
        project,
        version,
        kind: 'unavailable',
        reason: 'distribution',
      };
    let source = selected;
    if (selected.serverPackFileId) {
      source = fileSchema.parse(
        await this.data(`/mods/${p.id}/files/${selected.serverPackFileId}`, signal),
      );
      if (
        source.id !== selected.serverPackFileId ||
        source.modId !== p.id ||
        !source.isServerPack ||
        (source.parentProjectFileId && source.parentProjectFileId !== selected.id)
      )
        fail('modpack_server_pack_identity');
    }
    const artifact = fileDownload(source);
    if (!artifact || !/\.zip$/i.test(artifact.filename))
      return {
        provider: this.provider,
        project,
        version,
        kind: 'unavailable',
        reason: 'distribution',
      };
    let companion = source !== selected ? fileDownload(selected) : undefined;
    if (selected.isServerPack && selected.parentProjectFileId) {
      const parent = fileSchema.parse(
        await this.data(`/mods/${p.id}/files/${selected.parentProjectFileId}`, signal),
      );
      if (
        parent.id !== selected.parentProjectFileId ||
        parent.modId !== p.id ||
        parent.isServerPack ||
        parent.serverPackFileId !== selected.id
      )
        fail('modpack_server_pack_identity');
      companion = fileDownload(parent);
    }
    return {
      provider: this.provider,
      project,
      version,
      kind: 'archive',
      format: source.isServerPack ? 'server-archive' : 'curseforge-manifest',
      download: artifact,
      ...(source.isServerPack && companion && /\.zip$/i.test(companion.filename)
        ? { targetManifest: { format: 'curseforge-manifest' as const, download: companion } }
        : {}),
    };
  }
}
