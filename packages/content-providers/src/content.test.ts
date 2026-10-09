import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import {
  type ContentArtifact,
  type ContentHttp,
  type ContentPlan,
  CurseForgeProvider,
  contentPlanDigest,
  inspectJarSide,
  inspectModpack,
  isPublicDownloadAddress,
  ModrinthProvider,
  recoverContentStageLock,
  safeArchivePath,
  safeContentPath,
  stageContent,
  targetFromMrpack,
  validateDownloadUrl,
  visitArchive,
} from './index.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'nh-content-'));
  temporary.push(root);
  await mkdir(join(root, 'mountdata'));
  return root;
}
async function zipBytes(
  entries: Record<string, string | Buffer>,
  options: { compress?: boolean; mode?: number } = {},
): Promise<Buffer> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  for (const [path, content] of Object.entries(entries))
    zip.addBuffer(Buffer.from(content), path, {
      compress: options.compress ?? false,
      mode: options.mode ?? 0o100644,
    });
  zip.end();
  await pipeline(
    zip.outputStream,
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  return Buffer.concat(chunks);
}
function hashes(buffer: Buffer) {
  return {
    sha1: createHash('sha1').update(buffer).digest('hex'),
    sha512: createHash('sha512').update(buffer).digest('hex'),
  };
}
function httpFor(files: Record<string, Buffer>): ContentHttp {
  return {
    json: vi.fn(),
    download: vi.fn(async (artifact, destination) => {
      const bytes = files[artifact.path];
      if (!bytes) throw new Error('missing');
      await writeFile(destination, bytes, { flag: 'wx' });
      return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    }),
  };
}
const target = { minecraftVersion: '1.21.1', loader: 'fabric' as const, loaderVersion: '0.16.0' };
const packBase = {
  formatVersion: 1,
  game: 'minecraft',
  versionId: 'v1',
  name: 'Fixture pack',
  dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.0' },
  files: [],
};
async function archive(
  entries: Record<string, string | Buffer>,
  options: { compress?: boolean; mode?: number } = {},
) {
  const root = await workspace();
  const path = join(root, 'input.zip');
  await writeFile(path, await zipBytes(entries, options));
  return { root, path };
}
function plan(artifacts: ContentArtifact[]): ContentPlan {
  return { format: 'individual', target, artifacts, overrides: [], projects: [], warnings: [] };
}
function artifact(
  path: string,
  bytes: Buffer,
  serverSide: ContentArtifact['serverSide'] = 'required',
): ContentArtifact {
  return {
    path,
    urls: ['https://cdn.modrinth.com/a'],
    size: bytes.length,
    hashes: hashes(bytes),
    kind: 'mod',
    serverSide,
  };
}

describe('archive and destination boundaries', () => {
  it.each([
    '../escape',
    '/absolute',
    'a/../../b',
    'a\\b',
    'a//b',
    'a/./b',
    'a:b',
    'a\u0000b',
    'config/a.',
    'config/CON.txt',
  ])('rejects unsafe path %s', (path) => expect(() => safeArchivePath(path)).toThrow());
  it.each([
    'server.properties',
    'eula.txt',
    'ops.json',
    'whitelist.json',
    'world/level.dat',
    'mods/start.sh',
    'config/loader.jar',
    'config/.env',
    'plugins/nested/a.jar',
    'config/evil.js',
  ])('protects platform-controlled path %s', (path) =>
    expect(() => safeContentPath(path)).toThrow(),
  );
  it('rejects case aliases, symlinks and decompression budgets before extracting', async () => {
    const duplicates = await archive({ 'config/a.cfg': 'a', 'config/A.cfg': 'b' });
    await expect(visitArchive(duplicates.path, async () => {})).rejects.toThrow();
    const link = await archive({ 'overrides/config/link': '../../outside' }, { mode: 0o120777 });
    await expect(visitArchive(link.path, async () => {})).rejects.toThrow();
    const bomb = await archive({ 'config/bomb.txt': 'a'.repeat(100000) }, { compress: true });
    await expect(
      visitArchive(bomb.path, async () => {}, { maxCompressionRatio: 10 }),
    ).rejects.toThrow();
    await expect(
      visitArchive(duplicates.path, async () => {}, { maxExpandedBytes: 1 }),
    ).rejects.toThrow();
    await expect(
      visitArchive(duplicates.path, async () => {}, { maxEntries: 1 }),
    ).rejects.toThrow();
  });
  it('rejects traversal encoded directly in hostile ZIP headers', async () => {
    const { path } = await archive({ 'safe.txt': 'a' });
    const buffer = await readFile(path);
    await writeFile(
      path,
      Buffer.from(buffer.toString('latin1').replaceAll('safe.txt', '../x.txt'), 'latin1'),
    );
    await expect(visitArchive(path, async () => {})).rejects.toThrow();
  });
  it('checks CRC even for a structurally valid stored entry', async () => {
    const { path } = await archive({
      'modrinth.index.json': JSON.stringify(packBase),
      'overrides/config/a.txt': 'safe',
    });
    const buffer = await readFile(path);
    const index = buffer.indexOf(Buffer.from('safe'));
    buffer[index] = 120;
    await writeFile(path, buffer);
    await expect(inspectModpack(path)).rejects.toThrow();
  });
});

describe('Modrinth and CurseForge modpack semantics', () => {
  it('uses manifest-selected loader/version, skips client and optional files, layers server overrides', async () => {
    const data = Buffer.from('one');
    const index = {
      ...packBase,
      files: [
        {
          path: 'mods/client.jar',
          downloads: ['https://cdn.modrinth.com/a'],
          fileSize: data.length,
          hashes: hashes(data),
          env: { client: 'required', server: 'unsupported' },
        },
        {
          path: 'mods/optional.jar',
          downloads: ['https://cdn.modrinth.com/a'],
          fileSize: data.length,
          hashes: hashes(data),
          env: { client: 'optional', server: 'optional' },
        },
        {
          path: 'config/config.json',
          downloads: ['https://cdn.modrinth.com/a'],
          fileSize: data.length,
          hashes: hashes(data),
        },
      ],
    };
    const { path } = await archive({
      'server-overrides/config/config.json': 'server',
      'overrides/config/config.json': 'common',
      'client-overrides/config/client.json': 'client',
      'modrinth.index.json': JSON.stringify(index),
    });
    const result = await inspectModpack(path);
    expect(result.target).toEqual(target);
    expect(result.artifacts).toEqual([]);
    expect(result.overrides).toHaveLength(1);
    expect(result.overrides[0]?.archivePath).toBe('server-overrides/config/config.json');
    expect(result.warnings).toContain('content.optional_server_file_skipped');
  });
  it('rejects ambiguous manifest, unknown dependencies and conflicting loaders', async () => {
    const { path } = await archive({
      'modrinth.index.json': JSON.stringify(packBase),
      'manifest.json': '{}',
    });
    await expect(inspectModpack(path)).rejects.toThrow();
    expect(() =>
      targetFromMrpack({ minecraft: '1.21.1', 'fabric-loader': '1', forge: '2' }),
    ).toThrow();
    expect(() => targetFromMrpack({ minecraft: '1.21.1', unknown: '1' })).toThrow();
    const protectedFile = await archive({
      'modrinth.index.json': JSON.stringify(packBase),
      'overrides/server.properties': 'rcon.password=secret',
    });
    await expect(inspectModpack(protectedFile.path)).rejects.toThrow();
  });
  it('requires optional CurseForge credentials and exact manifest loader semantics', async () => {
    const cf = {
      manifestType: 'minecraftModpack',
      manifestVersion: 1,
      minecraft: { version: '1.21.1', modLoaders: [{ id: 'fabric-0.16.0', primary: true }] },
      files: [{ projectID: 1, fileID: 2, required: true }],
      overrides: 'overrides',
    };
    const { path } = await archive({ 'manifest.json': JSON.stringify(cf) });
    await expect(inspectModpack(path)).rejects.toThrow();
    const resolver = {
      resolveMany: vi.fn(async () => ({ ...plan([]), format: 'curseforge' as const })),
    };
    const result = await inspectModpack(path, {
      curseforge: resolver as unknown as CurseForgeProvider,
    });
    expect(result.format).toBe('curseforge');
    expect(resolver.resolveMany).toHaveBeenCalledWith([{ projectID: 1, fileID: 2 }], target);
  });
});

describe('provider identity, side and dependency resolution', () => {
  function mr(
    versionChanges: Record<string, unknown> = {},
    projectChanges: Record<string, unknown> = {},
  ) {
    const versions: Record<string, unknown> = {
      v1: {
        id: 'v1',
        project_id: 'p1',
        name: 'P1',
        version_number: '1',
        date_published: '2026-01-01',
        game_versions: ['1.21.1'],
        loaders: ['fabric'],
        files: [
          {
            filename: 'p1.jar',
            size: 1,
            url: 'https://cdn.modrinth.com/a',
            hashes: hashes(Buffer.from('a')),
            primary: true,
          },
        ],
        dependencies: [],
        ...versionChanges,
      },
      v2: {
        id: 'v2',
        project_id: 'p2',
        name: 'P2',
        version_number: '1',
        date_published: '2026-01-01',
        game_versions: ['1.21.1'],
        loaders: ['fabric'],
        files: [
          {
            filename: 'p2.jar',
            size: 1,
            url: 'https://cdn.modrinth.com/b',
            hashes: hashes(Buffer.from('b')),
            primary: true,
          },
        ],
        dependencies: [],
      },
    };
    const http: ContentHttp = {
      json: vi.fn(async (url) => {
        if (url.includes('/version/')) return versions[url.split('/').pop() as string];
        if (url.includes('/version?')) return [versions.v2];
        const id = url.split('/').pop();
        return { id, title: id, project_type: 'mod', server_side: 'required', ...projectChanges };
      }),
      download: vi.fn(),
    };
    return { provider: new ModrinthProvider(http), http, versions };
  }
  it('resolves pinned required dependencies and records removal guards', async () => {
    const { provider } = mr({
      dependencies: [{ project_id: 'p2', version_id: 'v2', dependency_type: 'required' }],
    });
    const result = await provider.resolve('p1', 'v1', target);
    expect(result.artifacts).toHaveLength(2);
    expect(result.projects.find((p) => p.projectId === 'p1')?.dependencies).toEqual(['p2']);
  });
  it('records project-scoped and exact-version Modrinth exclusions for future operations', async () => {
    const result = await mr({
      dependencies: [
        { project_id: 'p2', version_id: 'v2', dependency_type: 'incompatible' },
        { project_id: 'p3', dependency_type: 'incompatible' },
      ],
    }).provider.resolve('p1', 'v1', target);
    expect(result.projects[0]?.incompatible).toEqual([
      { provider: 'modrinth', projectId: 'p2', versionId: 'v2' },
      { provider: 'modrinth', projectId: 'p3', versionId: undefined },
    ]);
  });
  it('discovers modpacks before asking for a runtime and verifies returned project identity', async () => {
    const { provider, http, versions } = mr({}, { project_type: 'modpack' });
    await provider.searchModpacks('fixture');
    const url = new URL(vi.mocked(http.json).mock.calls[0]?.[0] ?? 'https://invalid.test');
    expect(JSON.parse(url.searchParams.get('facets') ?? 'null')).toEqual([
      ['project_type:modpack'],
    ]);
    vi.mocked(http.json).mockImplementation(async (url) =>
      url.endsWith('/version')
        ? [versions.v1]
        : { id: 'p1', title: 'Pack', project_type: 'modpack' },
    );
    expect(await provider.modpackVersions('p1')).toHaveLength(1);
    vi.mocked(http.json).mockImplementation(async (url) =>
      url.endsWith('/version')
        ? [versions.v2]
        : { id: 'p1', title: 'Pack', project_type: 'modpack' },
    );
    await expect(provider.modpackVersions('p1')).rejects.toThrow();
    await expect(mr().provider.modpackVersions('p1')).rejects.toThrow();
    vi.mocked(http.json).mockImplementation(async (url) =>
      url.endsWith('/version')
        ? Array(10001).fill(versions.v1)
        : { id: 'p1', title: 'Pack', project_type: 'modpack' },
    );
    await expect(provider.modpackVersions('p1')).rejects.toThrow();
  });
  it('deduplicates cycles without omitting pinned conflicts', async () => {
    const { provider, versions } = mr({
      dependencies: [{ project_id: 'p2', version_id: 'v2', dependency_type: 'required' }],
    });
    (versions.v2 as { dependencies: unknown[] }).dependencies = [
      { project_id: 'p1', version_id: 'v1', dependency_type: 'required' },
    ];
    expect((await provider.resolve('p1', 'v1', target)).artifacts).toHaveLength(2);
  });
  it('supports current project environment arrays but uses precise version-side evidence', async () => {
    expect(
      (
        await mr(
          { environment: 'client_or_server_prefers_both' },
          { environment: ['client_or_server_prefers_both'] },
        ).provider.resolve('p1', 'v1', target)
      ).artifacts,
    ).toHaveLength(1);
    await expect(
      mr({}, { environment: ['client_only', 'server_only'] }).provider.resolve('p1', 'v1', target),
    ).rejects.toThrow();
  });
  it('rejects client-only, unknown side, mismatched version and dependency identity', async () => {
    await expect(
      mr({}, { server_side: 'unsupported' }).provider.resolve('p1', 'v1', target),
    ).rejects.toThrow();
    await expect(
      mr({ environment: 'unknown' }).provider.resolve('p1', 'v1', target),
    ).rejects.toThrow();
    await expect(
      mr({ environment: 'client_only' }).provider.resolve('p1', 'v1', target),
    ).rejects.toThrow();
    await expect(
      mr({ game_versions: ['1.20'] }).provider.resolve('p1', 'v1', target),
    ).rejects.toThrow();
    await expect(
      mr({
        dependencies: [{ project_id: 'p9', version_id: 'v2', dependency_type: 'required' }],
      }).provider.resolve('p1', 'v1', target),
    ).rejects.toThrow();
  });
  it('rejects incompatible dependency graphs, ambiguous artifacts and resource packs', async () => {
    await expect(
      mr({
        dependencies: [
          { project_id: 'p2', version_id: 'v2', dependency_type: 'required' },
          { project_id: 'p2', dependency_type: 'incompatible' },
        ],
      }).provider.resolve('p1', 'v1', target),
    ).rejects.toThrow();
    await expect(
      mr({}, { project_type: 'resourcepack' }).provider.resolve('p1', 'v1', target),
    ).rejects.toThrow();
  });
  function cf(
    overrides: Record<string, unknown> = {},
    projectOverrides: Record<string, unknown> = {},
  ) {
    const http: ContentHttp = {
      json: vi.fn(async (url) => ({
        data: url.includes('/files/')
          ? {
              id: 2,
              modId: 1,
              fileName: 'a.jar',
              fileLength: 1,
              downloadUrl: 'https://edge.forgecdn.net/a',
              isAvailable: true,
              gameVersions: ['1.21.1', 'Fabric'],
              hashes: [{ algo: 1, value: hashes(Buffer.from('a')).sha1 }],
              dependencies: [],
              ...overrides,
            }
          : { id: 1, name: 'A', allowModDistribution: true, ...projectOverrides },
      })),
      download: vi.fn(),
    };
    return { http, provider: new CurseForgeProvider(http, { apiKey: 'fixture-only' }) };
  }
  it('uses injected API key but never includes it in download plans', async () => {
    const { provider, http } = cf();
    const result = await provider.resolve(1, 2, target);
    expect(JSON.stringify(result)).not.toContain('fixture-only');
    expect(JSON.stringify(provider)).not.toContain('fixture-only');
    expect(result.artifacts[0]?.serverSide).toBe('unknown');
    expect(http.json).toHaveBeenCalledWith(expect.any(String), {
      headers: { 'x-api-key': 'fixture-only' },
    });
  });
  it('retains CurseForge Incompatible relation 5 for later cross-install checks', async () => {
    const result = await cf({ dependencies: [{ modId: 9, relationType: 5 }] }).provider.resolve(
      1,
      2,
      target,
    );
    expect(result.projects[0]?.incompatible).toEqual([{ provider: 'curseforge', projectId: '9' }]);
  });
  it('refuses unavailable/restricted files rather than scraping or guessing URLs', async () => {
    await expect(cf({ downloadUrl: null }).provider.resolve(1, 2, target)).rejects.toThrow();
    await expect(
      cf({}, { allowModDistribution: false }).provider.resolve(1, 2, target),
    ).rejects.toThrow();
    await expect(cf({ modId: 9 }).provider.resolve(1, 2, target)).rejects.toThrow();
    await expect(
      cf({ gameVersions: ['1.21.1', 'Forge'] }).provider.resolve(1, 2, target),
    ).rejects.toThrow();
  });
});

describe('streamed job-scoped staging and recovery', () => {
  it('stages verified files, reuses only rehashed files and persists exact plan identity', async () => {
    const root = await workspace();
    const bytes = await zipBytes({ 'fabric.mod.json': JSON.stringify({ environment: '*' }) });
    const input = plan([artifact('mods/server.jar', bytes)]);
    const http = httpFor({ 'mods/server.jar': bytes });
    const options = { mountdataRoot: join(root, 'mountdata'), jobId: 'job1', http };
    const first = await stageContent(input, options);
    const second = await stageContent(input, options);
    expect(first).toEqual(second);
    expect(http.download).toHaveBeenCalledTimes(1);
    expect(first.manifest).toHaveLength(1);
    await writeFile(join(first.directory, 'mods/server.jar'), 'tampered');
    await expect(stageContent(input, options)).rejects.toThrow();
    await expect(stageContent({ ...input, warnings: ['different'] }, options)).rejects.toThrow();
  });
  it('verifies injected download hashes instead of trusting a reported success', async () => {
    const root = await workspace();
    const bytes = Buffer.from('true');
    const http = httpFor({ 'config/a.txt': Buffer.from('fake') });
    await expect(
      stageContent(plan([artifact('config/a.txt', bytes)]), {
        mountdataRoot: join(root, 'mountdata'),
        jobId: 'job',
        http,
      }),
    ).rejects.toThrow();
  });
  it('never installs embedded client-only or unknown override JARs', async () => {
    const client = await zipBytes({ 'fabric.mod.json': JSON.stringify({ environment: 'client' }) });
    const root = await workspace();
    await expect(
      stageContent(plan([artifact('mods/client.jar', client)]), {
        mountdataRoot: join(root, 'mountdata'),
        jobId: 'client',
        http: httpFor({ 'mods/client.jar': client }),
      }),
    ).rejects.toThrow();
    const unknown = await zipBytes({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0' });
    await expect(
      stageContent(plan([artifact('mods/unknown.jar', unknown, 'unknown')]), {
        mountdataRoot: join(root, 'mountdata'),
        jobId: 'unknown',
        http: httpFor({ 'mods/unknown.jar': unknown }),
      }),
    ).rejects.toThrow();
    const jarPath = join(root, 'client.jar');
    await writeFile(jarPath, client);
    expect(await inspectJarSide(jarPath)).toBe('client');
  });
  it('handles selected server overrides and refuses changed archives', async () => {
    const { root, path } = await archive({
      'modrinth.index.json': JSON.stringify(packBase),
      'overrides/config/a.txt': 'original',
      'server-overrides/config/a.txt': 'server',
    });
    const input = await inspectModpack(path);
    const output = await stageContent(input, {
      mountdataRoot: join(root, 'mountdata'),
      jobId: 'ok',
      archivePath: path,
      http: httpFor({}),
    });
    expect(await readFile(join(output.directory, 'config/a.txt'), 'utf8')).toBe('server');
    await writeFile(
      path,
      await zipBytes({
        'modrinth.index.json': JSON.stringify(packBase),
        'server-overrides/config/a.txt': 'change',
      }),
    );
    await expect(
      stageContent(input, {
        mountdataRoot: join(root, 'mountdata'),
        jobId: 'changed',
        archivePath: path,
        http: httpFor({}),
      }),
    ).rejects.toThrow();
  });
  it('recovers only a lock with verified DB exclusivity and exact immutable plan', async () => {
    const root = await workspace();
    const input = plan([]);
    const options = { mountdataRoot: join(root, 'mountdata'), jobId: 'job', http: httpFor({}) };
    await stageContent(input, options);
    const job = join(options.mountdataRoot, 'content-staging/job');
    await writeFile(join(job, '.lock'), '');
    await expect(stageContent(input, options)).rejects.toThrow();
    const assertExclusiveJob = vi.fn(async () => {
      throw new Error('lease active');
    });
    await expect(
      recoverContentStageLock({
        ...options,
        expectedPlanDigest: contentPlanDigest(input),
        assertExclusiveJob,
      }),
    ).rejects.toThrow();
    await recoverContentStageLock({
      ...options,
      expectedPlanDigest: contentPlanDigest(input),
      assertExclusiveJob: async () => {},
    });
    expect((await stageContent(input, options)).manifest).toEqual([]);
  });
  it('rejects symlinked stage roots and existing output files', async () => {
    const root = await workspace();
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'mountdata/link'));
    await expect(
      stageContent(plan([]), {
        mountdataRoot: join(root, 'mountdata/link'),
        jobId: 'job',
        http: httpFor({}),
      }),
    ).rejects.toThrow();
  });
  it('limits total downloaded bytes before making a request', async () => {
    const root = await workspace();
    const bytes = Buffer.from('1234');
    const http = httpFor({ 'config/a.txt': bytes });
    await expect(
      stageContent(plan([artifact('config/a.txt', bytes)]), {
        mountdataRoot: join(root, 'mountdata'),
        jobId: 'job',
        http,
        limits: { maxExpandedBytes: 3 },
      }),
    ).rejects.toThrow();
    expect(http.download).not.toHaveBeenCalled();
  });
});

describe('download URL and address isolation', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.2',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::ffff:8.8.8.8',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])('rejects nonpublic or embedded address %s', (address) =>
    expect(isPublicDownloadAddress(address)).toBe(false),
  );
  it('accepts normal public addresses', () => {
    expect(isPublicDownloadAddress('1.1.1.1')).toBe(true);
    expect(isPublicDownloadAddress('2606:4700:4700::1111')).toBe(true);
  });
  it.each([
    'http://cdn.modrinth.com/a',
    'https://cdn.modrinth.com.evil.test/a',
    'https://user:password@cdn.modrinth.com/a',
    'https://127.0.0.1/a',
    'https://cdn.modrinth.com:444/a',
    'https://cdn.modrinth.com/a#part',
  ])('rejects unsafe or unapproved URL %s', (url) =>
    expect(() => validateDownloadUrl(url, ['https://cdn.modrinth.com'])).toThrow(),
  );
});
