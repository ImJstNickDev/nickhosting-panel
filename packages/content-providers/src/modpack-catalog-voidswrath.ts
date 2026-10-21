import { type DefaultTreeAdapterMap, parse } from 'parse5';
import { type ContentHttp, fail } from './contracts.js';
import {
  type ModpackCatalogPageInput,
  type ModpackCatalogSearchInput,
  type ModpackCatalogVersion,
  modpackCatalogDetailsSchema,
  modpackCatalogProjectsSchema,
  modpackCatalogVersionsSchema,
} from './modpack-catalog.js';
import {
  download,
  identifier,
  ModpackMetadataClient,
  publicUrl,
  queryInput,
  slicePage,
} from './modpack-catalog-common.js';
import type { ModpackCatalog, ModpackRecipe } from './modpack-recipes.js';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
function elements(root: Node): Element[] {
  const queue: Node[] = [root];
  const result: Element[] = [];
  while (queue.length) {
    const node = queue.pop();
    if (!node) continue;
    if ('tagName' in node) {
      if (['script', 'style', 'noscript'].includes(node.tagName)) continue;
      result.push(node);
    }
    if ('childNodes' in node) queue.push(...node.childNodes.toReversed());
    if (result.length > 50000) fail('modpack_html_size');
  }
  return result;
}
function attr(node: Element, name: string) {
  return node.attrs.find((a) => a.name === name)?.value ?? '';
}
function hasClass(node: Element, name: string) {
  return attr(node, 'class').split(/\s+/).includes(name);
}
function text(root?: Node): string {
  if (!root) return '';
  const queue = [root];
  const parts: string[] = [];
  while (queue.length) {
    const node = queue.pop();
    if (!node) continue;
    if ('tagName' in node && ['script', 'style', 'noscript'].includes(node.tagName)) continue;
    if (node.nodeName === '#text' && 'value' in node) parts.push(node.value);
    if ('childNodes' in node) queue.push(...node.childNodes.toReversed());
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
const origin = 'https://voidswrath.com';
function projectId(href: string): string | undefined {
  try {
    const url = new URL(href, origin);
    return url.origin === origin
      ? /^\/modpacks\/([a-z0-9-]+)\/$/.exec(url.pathname)?.[1]
      : undefined;
  } catch {
    return undefined;
  }
}
export class VoidsWrathModpackCatalog implements ModpackCatalog {
  readonly provider = 'voidswrath' as const;
  private readonly client: ModpackMetadataClient;
  constructor(http: ContentHttp) {
    this.client = new ModpackMetadataClient(http);
  }
  async search(input: ModpackCatalogSearchInput = {}, signal?: AbortSignal) {
    const query = queryInput(input.query).toLocaleLowerCase();
    const nodes = elements(parse(await this.client.text(`${origin}/mod-packs/`, signal)));
    const projects = new Map<
      string,
      {
        id: string;
        provider: 'voidswrath';
        name: string;
        summary: string;
        websiteUrl: string;
        imageUrl?: string;
        authors: string[];
      }
    >();
    for (const anchor of nodes.filter((n) => n.tagName === 'a')) {
      const id = projectId(attr(anchor, 'href'));
      if (!id) continue;
      const descendants = elements(anchor);
      const name = text(descendants.find((n) => hasClass(n, 'mod-pack-title-list')));
      if (!name?.toLocaleLowerCase().includes(query)) continue;
      const thumb = descendants.find((n) => hasClass(n, 'mod-pack-thumb'));
      const image = thumb
        ? /url\(['"]?([^'"()]+)['"]?\)/.exec(attr(thumb, 'style'))?.[1]
        : undefined;
      projects.set(id, {
        id,
        provider: this.provider,
        name,
        summary: '',
        websiteUrl: `${origin}/modpacks/${id}/`,
        imageUrl: publicUrl(image),
        authors: [],
      });
    }
    // A changed upstream page is an error, not a misleading empty catalog.
    if (!nodes.some((n) => hasClass(n, 'mod-pack-title-list'))) fail('modpack_catalog_changed');
    return modpackCatalogProjectsSchema.parse(slicePage([...projects.values()], input));
  }
  private async metadata(id: string, signal?: AbortSignal) {
    identifier(id);
    if (!/^[a-z0-9-]+$/.test(id)) fail('modpack_identity');
    const url = `${origin}/modpacks/${id}/`;
    const nodes = elements(parse(await this.client.text(url, signal)));
    const title = text(nodes.find((n) => hasClass(n, 'post-modpacks-title')));
    if (!title) fail('modpack_catalog_changed');
    const meta = (name: string) =>
      nodes.find((n) => n.tagName === 'meta' && attr(n, 'property') === name);
    const info = nodes.find((n) => hasClass(n, 'post-server-details'));
    const values = info
      ? elements(info)
          .filter((n) => n.tagName === 'li')
          .map((n) => text(n))
      : [];
    const value = (label: string) =>
      values
        .find((v) => v.toLowerCase().startsWith(`${label}:`))
        ?.split(':')
        .slice(1)
        .join(':')
        .trim();
    const version = value('version');
    const minecraft = value('minecraft');
    const links = nodes.filter(
      (n) => n.tagName === 'a' && /download the server pack/i.test(text(n)),
    );
    const serverUrl = links.length === 1 ? publicUrl(attr(links[0] as Element, 'href')) : undefined;
    const summary = meta('og:description');
    const image = meta('og:image');
    const paragraphs = nodes
      .filter((n) => n.tagName === 'p')
      .map((n) => text(n))
      .filter(Boolean);
    const project = modpackCatalogDetailsSchema.parse({
      id,
      provider: this.provider,
      name: title,
      summary: summary ? attr(summary, 'content').slice(0, 4096) : '',
      websiteUrl: url,
      imageUrl: publicUrl(image ? attr(image, 'content') : undefined),
      authors: [],
      description: paragraphs.join('\n\n').slice(0, 512 * 1024),
      descriptionFormat: 'text',
    });
    const available =
      !!version &&
      !!minecraft &&
      !!serverUrl?.startsWith('https:') &&
      /\.zip(?:\?|$)/i.test(serverUrl);
    const item: ModpackCatalogVersion = {
      id: version ?? 'current',
      projectId: id,
      name: version ?? title,
      version: version ?? 'current',
      minecraftVersions: minecraft ? [minecraft] : [],
      loaders: [],
      channel: 'unknown',
      available,
      ...(!available ? { unavailableReason: 'server-pack' as const } : {}),
      source: 'server-archive',
    };
    return { project, version: item, serverUrl };
  }
  async details(id: string, signal?: AbortSignal) {
    return (await this.metadata(id, signal)).project;
  }
  async versions(id: string, input: ModpackCatalogPageInput = {}, signal?: AbortSignal) {
    return modpackCatalogVersionsSchema.parse(
      slicePage([(await this.metadata(id, signal)).version], input),
    );
  }
  async resolve(id: string, versionId: string, signal?: AbortSignal): Promise<ModpackRecipe> {
    const { project, version, serverUrl } = await this.metadata(id, signal);
    if (version.id !== versionId) fail('modpack_identity');
    if (!version.available || !serverUrl)
      return {
        provider: this.provider,
        project,
        version,
        kind: 'unavailable',
        reason: 'server-pack',
      };
    return {
      provider: this.provider,
      project,
      version,
      kind: 'archive',
      format: 'server-archive',
      download: download({
        filename: decodeURIComponent(new URL(serverUrl).pathname.split('/').at(-1) ?? ''),
        urls: [serverUrl],
        hashes: {},
      }),
    };
  }
}
