import { describe, expect, it, vi } from 'vitest';
import type { ContentHttp } from './contracts.js';
import { AtLauncherModpackCatalog } from './modpack-catalog-atlauncher.js';

const cdn = 'https://download.nodecdn.net/containers/atl';
const sha1 = 'a'.repeat(40);
const md5 = 'b'.repeat(32);
const serverMd5 = 'c'.repeat(32);
const mod = {
  file: 'Example.jar',
  url: 'packs/Fixture/files/Example.jar',
  download: 'server',
  type: 'mods',
  server: true,
  filesize: 123,
  md5,
};
const baseManifest = {
  version: '1.0',
  minecraft: '1.20.1',
  loader: { type: 'forge', metadata: { minecraft: '1.20.1', version: '47.3.0' } },
  mods: [mod],
  configs: { filesize: 456, sha1 },
};
function fixture(manifest: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) {
  const json = vi.fn(async (url: string) => {
    if (url === 'https://api.atlauncher.com/v1/packs/full/public')
      return {
        error: false,
        data: [
          {
            id: 1,
            safeName: 'Fixture',
            name: 'Fixture Pack',
            versions: [{ version: '1.0', minecraft: '1.20.1' }],
          },
        ],
      };
    if (url === 'https://api.atlauncher.com/v1/pack/Fixture/1.0')
      return { error: false, data: { version: '1.0', minecraftVersion: '1.20.1', ...metadata } };
    if (url === `${cdn}/packs/Fixture/versions/1.0/Configs.json`)
      return { ...baseManifest, ...manifest };
    throw new Error(`Unexpected request: ${url}`);
  });
  const http: ContentHttp = { json, download: vi.fn() };
  return { catalog: new AtLauncherModpackCatalog(http), json, http };
}

describe('ATLauncher exact server manifests', () => {
  it('combines the pinned root configs archive with declared server files and exact runtime', async () => {
    const { catalog, http } = fixture({
      caseAllFiles: 'lower',
      mods: [
        mod,
        { ...mod, file: 'Client.jar', server: false },
        { ...mod, file: 'Optional.jar', optional: true },
      ],
    });
    const recipe = await catalog.resolve('Fixture', '1.0');
    expect(recipe).toMatchObject({
      kind: 'archive',
      format: 'server-archive',
      preserveRoot: true,
      target: { minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.3.0' },
      download: {
        filename: 'Configs.zip',
        urls: [`${cdn}/packs/Fixture/versions/1.0/Configs.zip`],
        size: 456,
        hashes: { sha1 },
      },
      files: [
        {
          path: 'mods/example.jar',
          download: { filename: 'Example.jar', size: 123, hashes: { md5 } },
          serverSide: 'required',
        },
      ],
    });
    if (recipe.kind !== 'archive') throw new Error('Expected archive');
    expect(recipe.files).toHaveLength(1);
    expect(http.download).not.toHaveBeenCalled();
  });

  it('uses separate server artifact metadata without reusing the client hash or size', async () => {
    const { catalog } = fixture({
      noConfigs: true,
      mods: [
        {
          ...mod,
          serverSeparate: true,
          serverUrl: 'packs/Fixture/files/Server.jar',
          serverFile: 'Server.jar',
          serverDownload: 'server',
          serverType: 'mods',
          serverMD5: serverMd5,
        },
      ],
    });
    const recipe = await catalog.resolve('Fixture', '1.0');
    expect(recipe).toMatchObject({
      kind: 'files',
      files: [
        {
          path: 'mods/Server.jar',
          download: { urls: [`${cdn}/packs/Fixture/files/Server.jar`], hashes: { md5: serverMd5 } },
        },
      ],
    });
    if (recipe.kind !== 'files') throw new Error('Expected files');
    expect(recipe.files[0]?.download.size).toBeUndefined();
    expect(JSON.stringify(recipe.files)).not.toContain(md5);
  });

  it('retains the exact Fabric loader, selected server option and direct URL', async () => {
    const { catalog } = fixture({
      noConfigs: true,
      loader: { type: 'fabric', metadata: { minecraft: '1.20.1', loader: '0.16.7' } },
      mods: [
        {
          ...mod,
          url: 'https://cdn.modrinth.com/mod.jar',
          download: 'direct',
          optional: true,
          selected: true,
        },
      ],
    });
    expect(await catalog.resolve('Fixture', '1.0')).toMatchObject({
      kind: 'files',
      target: { loader: 'fabric', loaderVersion: '0.16.7' },
      files: [
        {
          optional: true,
          serverSide: 'optional',
          download: { urls: ['https://cdn.modrinth.com/mod.jar'] },
        },
      ],
    });
  });

  it.each([
    ['browser-only download', { mods: [{ ...mod, download: 'browser' }] }, 'distribution'],
    ['only client mods', { mods: [{ ...mod, server: false }] }, 'client-only'],
    ['empty separate server URL', { mods: [{ ...mod, serverUrl: '' }] }, 'unresolved'],
    ['server extraction', { mods: [{ ...mod, type: 'extract' }] }, 'unresolved'],
    ['undeclared server side', { mods: [{ ...mod, server: undefined }] }, 'unresolved'],
    ['server setup actions', { actions: [{ type: 'execute' }] }, 'unresolved'],
    ['custom libraries', { libraries: [{ file: 'custom.jar' }] }, 'unresolved'],
    ['server startup arguments', { serverArguments: '--custom' }, 'unresolved'],
    ['missing configs', { configs: undefined }, 'unresolved'],
    ['missing runtime', { loader: undefined }, 'runtime'],
    ['unpinned loader', { loader: { type: 'forge', metadata: { version: 'latest' } } }, 'runtime'],
    [
      'loader choice',
      { loader: { type: 'forge', choose: true, metadata: { version: '47.3.0' } } },
      'runtime',
    ],
  ])('reports %s as a concrete blocker', async (_name, manifest, reason) => {
    const { catalog, http } = fixture(manifest);
    expect(await catalog.resolve('Fixture', '1.0')).toMatchObject({
      kind: 'unavailable',
      reason,
      version: { available: false, unavailableReason: reason },
    });
    expect(http.download).not.toHaveBeenCalled();
  });

  it('does not turn a NeoForge declaration into permission or install support', async () => {
    const { catalog } = fixture({
      noConfigs: true,
      loader: { type: 'neoforge', metadata: { version: '21.1.264' } },
    });
    expect(await catalog.resolve('Fixture', '1.0')).toMatchObject({
      kind: 'files',
      target: { loader: 'neoforge', loaderVersion: '21.1.264' },
    });
  });

  it.each([
    [{ version: 'other' }, {}],
    [{ minecraft: '1.21.1' }, {}],
    [{}, { version: 'other' }],
    [{}, { minecraftVersion: '1.21.1' }],
  ])('rejects mismatched version or Minecraft identity', async (manifest, metadata) => {
    const { catalog } = fixture(manifest, metadata);
    await expect(catalog.resolve('Fixture', '1.0')).rejects.toThrow();
  });

  it.each([
    { file: '../escape.jar' },
    { path: '../outside' },
    { url: 'packs/Fixture/../../outside.jar' },
    { url: 'packs/Fixture/%2e%2e/outside.jar' },
    { url: 'https://other.example/file.jar' },
    { download: 'direct', url: 'http://files.example/file.jar' },
    { md5: 'invalid' },
  ])('rejects unsafe paths, URLs and hashes', async (override) => {
    const { catalog } = fixture({ mods: [{ ...mod, ...override }] });
    await expect(catalog.resolve('Fixture', '1.0')).rejects.toThrow();
  });

  it('rejects duplicate installation paths', async () => {
    const { catalog } = fixture({ mods: [mod, mod] });
    await expect(catalog.resolve('Fixture', '1.0')).rejects.toThrow();
  });

  it('returns browser-safe available versions and shares their metadata with resolution', async () => {
    const { catalog, json } = fixture();
    const versions = await catalog.versions('Fixture');
    expect(versions).toMatchObject({
      items: [{ available: true, target: { loader: 'forge', loaderVersion: '47.3.0' } }],
    });
    expect(JSON.stringify(versions)).not.toContain(cdn);
    expect(JSON.stringify(versions)).not.toContain('Example.jar');
    expect(json).toHaveBeenCalledTimes(3);
    await catalog.resolve('Fixture', '1.0');
    expect(json).toHaveBeenCalledTimes(3);
  });

  it('does not request any metadata for a cancelled call', async () => {
    const { catalog, json } = fixture();
    await expect(catalog.versions('Fixture', {}, AbortSignal.abort())).rejects.toThrow();
    expect(json).not.toHaveBeenCalled();
  });

  it('rejects an unlisted version before requesting its manifest', async () => {
    const { catalog, json } = fixture();
    await expect(catalog.resolve('Fixture', 'unknown')).rejects.toThrow();
    expect(json).toHaveBeenCalledTimes(1);
  });
});
