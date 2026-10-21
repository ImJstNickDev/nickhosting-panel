import { z } from 'zod';
import { type ContentHttp, type ContentTarget, fail, safeArchivePath } from './contracts.js';
import {
  type ModpackCatalogPageInput,
  type ModpackCatalogSearchInput,
  type ModpackCatalogVersion,
  type ModpackUnavailableReason,
  modpackCatalogDetailsSchema,
  modpackCatalogProjectsSchema,
  modpackCatalogVersionsSchema,
} from './modpack-catalog.js';
import {
  download,
  identifier,
  ModpackMetadataClient,
  publicUrl,
  published,
  queryInput,
  slicePage,
  str,
} from './modpack-catalog-common.js';
import { assertModpackPaths, modpackDataPath } from './modpack-paths.js';
import type { ModpackCatalog, ModpackRecipe, ModpackRecipeFile } from './modpack-recipes.js';

// Official ATLauncher source: Constants.DOWNLOAD_SERVER and Pack.getJsonDownloadUrl.
const cdn = 'https://download.nodecdn.net/containers/atl';
const versionSchema = z.object({
  version: str,
  minecraft: str.optional(),
  minecraftVersion: str.optional(),
  published: z.number().optional(),
  recommended: z.boolean().optional(),
  serverZipURL: str.nullable().optional(),
});
const projectSchema = z.object({
  id: z.number().int().positive(),
  name: str,
  safeName: str,
  description: str.default(''),
  type: str.default('public'),
  versions: z.array(versionSchema).max(10000).default([]),
  authors: z.array(str).default([]),
  image: str.optional(),
});
const modSchema = z.object({
  file: str,
  url: str,
  type: str,
  download: str,
  server: z.boolean().optional(),
  serverUrl: str.nullable().optional(),
  serverFile: str.nullable().optional(),
  serverType: str.nullable().optional(),
  serverDownload: str.nullable().optional(),
  serverMD5: str.nullable().optional(),
  serverSeparate: z.boolean().default(false),
  serverOptional: z.boolean().nullable().optional(),
  optional: z.boolean().default(false),
  selected: z.boolean().default(false),
  path: str.nullable().optional(),
  filePrefix: str.nullable().optional(),
  filePattern: z.boolean().default(false),
  md5: str.nullable().optional(),
  sha1: str.nullable().optional(),
  sha512: str.nullable().optional(),
  filesize: z.number().int().nonnegative().optional(),
  depends: z.array(str).nullable().optional(),
  linked: str.nullable().optional(),
  group: str.nullable().optional(),
});
const manifestSchema = z.object({
  version: str,
  minecraft: str,
  loader: z
    .object({
      type: str,
      choose: z.boolean().default(false),
      metadata: z.object({
        minecraft: str.optional(),
        version: str.optional(),
        loader: str.optional(),
      }),
    })
    .nullable()
    .optional(),
  mods: z.array(modSchema).max(20000),
  noConfigs: z.boolean().default(false),
  configs: z.object({ filesize: z.number().int().nonnegative(), sha1: str }).nullable().optional(),
  actions: z.array(z.unknown()).max(1000).default([]),
  libraries: z.array(z.unknown()).max(1000).default([]),
  serverArguments: str.default(''),
  caseAllFiles: z.enum(['lower', 'upper']).nullable().optional(),
  memory: z.number().int().positive().optional(),
  java: z.object({ min: z.number().int().positive().optional() }).optional(),
});
type Project = z.infer<typeof projectSchema>;
type Version = z.infer<typeof versionSchema>;
type Manifest = z.infer<typeof manifestSchema>;

function targetOf(manifest: Manifest): ContentTarget | undefined {
  const loader = manifest.loader;
  if (
    !loader ||
    loader.choose ||
    (loader.metadata.minecraft && loader.metadata.minecraft !== manifest.minecraft) ||
    !['forge', 'fabric', 'neoforge', 'quilt'].includes(loader.type)
  )
    return undefined;
  const version =
    loader.type === 'fabric' || loader.type === 'quilt'
      ? loader.metadata.loader
      : loader.metadata.version;
  if (!version || /^(?:latest|recommended)$/i.test(version)) return undefined;
  return {
    minecraftVersion: manifest.minecraft,
    loader: loader.type as ContentTarget['loader'],
    loaderVersion: version,
  };
}
function manifestUrl(id: string, version: string, filename: string): string {
  return `${cdn}/packs/${identifier(id)}/versions/${identifier(version)}/${filename}`;
}
function fileUrl(url: string, type: string): string {
  if (type !== 'server') return url.replaceAll('&amp;', '&');
  // CDN-relative paths cannot redirect outside ATLauncher's published container.
  const path = safeArchivePath(decodeURIComponent(url.replaceAll('&amp;', '&')));
  if (!path.startsWith('packs/') || /[?#]/.test(path)) fail('modpack_download_url');
  return `${cdn}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
function recipeFiles(manifest: Manifest): ModpackRecipeFile[] | ModpackUnavailableReason {
  if (manifest.actions.length || manifest.libraries.length || manifest.serverArguments)
    return 'unresolved';
  if (manifest.mods.length && manifest.mods.every((mod) => mod.server === false))
    return 'client-only';
  const files: ModpackRecipeFile[] = [];
  for (const mod of manifest.mods) {
    if (mod.server === false) continue;
    if (mod.server !== true) return 'unresolved';
    const optional = mod.serverOptional ?? mod.optional;
    if (optional && !mod.selected) continue;
    if (mod.filePattern || mod.depends?.length || mod.linked || mod.group) return 'unresolved';
    const separate = mod.serverUrl !== undefined && mod.serverUrl !== null;
    if (mod.serverSeparate && !separate) return 'unresolved';
    const type = separate ? mod.serverType : mod.type;
    const method = separate ? mod.serverDownload : mod.download;
    const name = separate ? mod.serverFile : `${mod.filePrefix ?? ''}${mod.file}`;
    const url = separate ? mod.serverUrl : mod.url;
    if (method === 'browser') return 'distribution';
    if (!name || !url || !type || !method || !['server', 'direct'].includes(method))
      return 'unresolved';
    const directories: Record<string, string> = {
      mods: mod.path ?? 'mods',
      coremods: 'coremods',
      plugins: 'plugins',
      ic2lib: 'mods/ic2',
      denlib: 'mods/denlib',
      dependency: `mods/${manifest.minecraft}`,
      depandency: `mods/${manifest.minecraft}`,
      flan: 'Flan',
      datapack: 'datapacks',
      resourcepack: 'resourcepacks',
      texturepack: 'texturepacks',
      shaderpack: 'shaderpacks',
    };
    const directory = directories[type];
    // Extraction, patched jars, legacy loader installation and arbitrary actions need
    // semantics the shared server installer does not implement; never omit them silently.
    if (!directory) return 'unresolved';
    const filename = download({
      filename: name,
      urls: [fileUrl(url, method)],
      hashes: {},
    }).filename;
    const dot = filename.lastIndexOf('.');
    const stem = filename.slice(0, dot < 0 ? filename.length : dot);
    const extension = dot < 0 ? '' : filename.slice(dot);
    const installedName =
      type === 'mods' && manifest.caseAllFiles
        ? `${manifest.caseAllFiles === 'lower' ? stem.toLowerCase() : stem.toUpperCase()}${extension}`
        : filename;
    const path = safeArchivePath(`${directory.replace(/\/$/, '')}/${installedName}`);
    if (modpackDataPath(path) !== path) return 'unresolved';
    const hashes = separate
      ? { ...(mod.serverMD5 ? { md5: mod.serverMD5.toLowerCase() } : {}) }
      : {
          ...(mod.md5 ? { md5: mod.md5.toLowerCase() } : {}),
          ...(mod.sha1 ? { sha1: mod.sha1.toLowerCase() } : {}),
          ...(mod.sha512 ? { sha512: mod.sha512.toLowerCase() } : {}),
        };
    files.push({
      path,
      download: download({
        filename,
        urls: [fileUrl(url, method)],
        ...(!separate && mod.filesize !== undefined ? { size: mod.filesize } : {}),
        hashes,
      }),
      serverSide: optional ? 'optional' : 'required',
      ...(optional ? { optional: true } : {}),
    });
  }
  assertModpackPaths(files.map((file) => file.path));
  return files;
}

export class AtLauncherModpackCatalog implements ModpackCatalog {
  readonly provider = 'atlauncher' as const;
  private readonly client: ModpackMetadataClient;
  constructor(http: ContentHttp) {
    this.client = new ModpackMetadataClient(http);
  }
  private async data(path: string, signal?: AbortSignal) {
    const result = z
      .object({ error: z.boolean(), data: z.unknown() })
      .parse(await this.client.json(`https://api.atlauncher.com/v1${path}`, signal));
    if (result.error) fail('modpack_metadata');
    return result.data;
  }
  private publicProject(p: Project) {
    return {
      id: p.safeName,
      provider: this.provider,
      name: p.name,
      summary: p.description.slice(0, 4096),
      websiteUrl: `https://atlauncher.com/pack/${encodeURIComponent(p.safeName)}`,
      authors: p.authors,
      imageUrl: publicUrl(p.image),
    };
  }
  private detailsOf(p: Project) {
    return modpackCatalogDetailsSchema.parse({
      ...this.publicProject(p),
      description: p.description,
      descriptionFormat: 'html',
    });
  }
  private async project(id: string, signal?: AbortSignal) {
    identifier(id);
    // Reuse the public catalog's descriptions and identity, never private pack metadata.
    const packs = z
      .array(projectSchema)
      .max(5000)
      .parse(await this.data('/packs/full/public', signal));
    const p = packs.find((p) => p.safeName === id && p.type === 'public');
    if (!p) fail('modpack_identity');
    return p;
  }
  async search(input: ModpackCatalogSearchInput = {}, signal?: AbortSignal) {
    const query = queryInput(input.query).toLocaleLowerCase();
    const packs = z
      .array(projectSchema)
      .max(5000)
      .parse(await this.data('/packs/full/public', signal));
    return modpackCatalogProjectsSchema.parse(
      slicePage(
        packs
          .filter(
            (p) =>
              p.type === 'public' &&
              `${p.name} ${p.description}`.toLocaleLowerCase().includes(query),
          )
          .map((p) => this.publicProject(p)),
        input,
      ),
    );
  }
  async details(id: string, signal?: AbortSignal) {
    return this.detailsOf(await this.project(id, signal));
  }
  private async recipe(p: Project, listed: Version, signal?: AbortSignal): Promise<ModpackRecipe> {
    const metadata = versionSchema.parse(
      await this.data(`/pack/${identifier(p.safeName)}/${identifier(listed.version)}`, signal),
    );
    const minecraft = listed.minecraft ?? listed.minecraftVersion;
    if (
      metadata.version !== listed.version ||
      (minecraft && metadata.minecraftVersion && minecraft !== metadata.minecraftVersion)
    )
      fail('modpack_identity');
    const project = this.detailsOf(p);
    const version: ModpackCatalogVersion = {
      id: listed.version,
      projectId: p.safeName,
      name: listed.version,
      version: listed.version,
      minecraftVersions: minecraft ? [minecraft] : [],
      loaders: [],
      channel: metadata.recommended ? 'release' : 'unknown',
      publishedAt: published(metadata.published ?? listed.published),
      available: true,
      source: metadata.serverZipURL ? 'server-archive' : 'atlauncher-recipe',
    };
    const unavailable = (reason: ModpackUnavailableReason): ModpackRecipe => ({
      provider: this.provider,
      project,
      version: { ...version, available: false, unavailableReason: reason },
      kind: 'unavailable',
      reason,
    });
    if (metadata.serverZipURL) {
      // A documented exact server ZIP is authoritative. Its runtime must still be
      // proven by an archive manifest before the shared staging plan can succeed.
      return {
        provider: this.provider,
        project,
        version,
        kind: 'archive',
        format: 'server-archive',
        download: download({ filename: 'server.zip', urls: [metadata.serverZipURL], hashes: {} }),
      };
    }
    const manifest = manifestSchema.parse(
      await this.client.json(manifestUrl(p.safeName, listed.version, 'Configs.json'), signal),
    );
    if (
      manifest.version !== listed.version ||
      (minecraft && manifest.minecraft !== minecraft) ||
      (metadata.minecraftVersion && manifest.minecraft !== metadata.minecraftVersion)
    )
      fail('modpack_identity');
    const target = targetOf(manifest);
    if (!target) return unavailable('runtime');
    version.minecraftVersions = [target.minecraftVersion];
    version.loaders = [target.loader];
    version.target = target;
    const files = recipeFiles(manifest);
    if (typeof files === 'string') return unavailable(files);
    if (manifest.noConfigs || manifest.configs?.filesize === 0)
      return {
        provider: this.provider,
        project,
        version,
        kind: 'files',
        target,
        files,
        warnings: [],
        memoryMiB: manifest.memory,
        javaVersion: manifest.java?.min?.toString(),
      };
    if (!manifest.configs) return unavailable('unresolved');
    return {
      provider: this.provider,
      project,
      version,
      kind: 'archive',
      format: 'server-archive',
      preserveRoot: true,
      target,
      files,
      download: download({
        filename: 'Configs.zip',
        urls: [manifestUrl(p.safeName, listed.version, 'Configs.zip')],
        size: manifest.configs.filesize,
        hashes: { sha1: manifest.configs.sha1.toLowerCase() },
      }),
    };
  }
  async versions(id: string, input: ModpackCatalogPageInput = {}, signal?: AbortSignal) {
    const p = await this.project(id, signal);
    const page = slicePage(
      [...p.versions].sort((a, b) => (b.published ?? 0) - (a.published ?? 0)),
      input,
    );
    const items: ModpackCatalogVersion[] = [];
    // Hydrate only visible versions; bounded concurrency and the shared cache keep
    // catalog browsing from downloading every manifest or any game artifact.
    for (let index = 0; index < page.items.length; index += 4) {
      signal?.throwIfAborted();
      items.push(
        ...(await Promise.all(
          page.items
            .slice(index, index + 4)
            .map(async (v) => (await this.recipe(p, v, signal)).version),
        )),
      );
    }
    return modpackCatalogVersionsSchema.parse({ ...page, items });
  }
  async resolve(id: string, versionId: string, signal?: AbortSignal): Promise<ModpackRecipe> {
    identifier(versionId);
    const p = await this.project(id, signal);
    const version = p.versions.find((v) => v.version === versionId);
    if (!version) fail('modpack_identity');
    return this.recipe(p, version, signal);
  }
}
