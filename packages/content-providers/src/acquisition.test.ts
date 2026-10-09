import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { acquireModrinthModpack, type ContentHttp, ModrinthProvider } from './index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'nh-acquire-'));
  roots.push(root);
  await mkdir(join(root, 'mountdata'));
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        game: 'minecraft',
        name: 'Fixture',
        versionId: '1',
        dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.0' },
        files: [],
      }),
    ),
    'modrinth.index.json',
  );
  zip.end();
  const chunks: Buffer[] = [];
  await pipeline(
    zip.outputStream,
    new Writable({
      write(chunk, _encoding, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    }),
  );
  const bytes = Buffer.concat(chunks);
  const http: ContentHttp = {
    json: vi.fn(async (url) =>
      url.includes('/version/')
        ? {
            id: 'v1',
            project_id: 'p1',
            name: 'Fixture',
            version_number: '1',
            game_versions: ['1.21.1'],
            loaders: ['fabric'],
            date_published: '2026-01-01',
            files: [
              {
                filename: 'fixture.mrpack',
                url: 'https://cdn.modrinth.com/fixture',
                size: bytes.length,
                hashes: { sha512: createHash('sha512').update(bytes).digest('hex') },
                primary: true,
              },
            ],
            dependencies: [],
          }
        : { id: 'p1', title: 'Fixture', project_type: 'modpack', server_side: 'required' },
    ),
    download: vi.fn(async (_artifact, path) => {
      await writeFile(path, bytes, { flag: 'wx' });
      return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }),
  };
  return { root, http, provider: new ModrinthProvider(http) };
}
it('acquires a modpack by exact provider identifiers and revalidates persisted archives', async () => {
  const { root, http, provider } = await setup();
  const options = { mountdataRoot: join(root, 'mountdata'), jobId: 'job1', http };
  const first = await acquireModrinthModpack(provider, 'p1', 'v1', options);
  expect(first.plan.target).toEqual({
    minecraftVersion: '1.21.1',
    loader: 'fabric',
    loaderVersion: '0.16.0',
  });
  expect((await readFile(first.archivePath)).length).toBeGreaterThan(0);
  expect(await acquireModrinthModpack(provider, 'p1', 'v1', options)).toEqual(first);
  expect(http.download).toHaveBeenCalledTimes(1);
  await writeFile(first.archivePath, 'changed');
  await expect(acquireModrinthModpack(provider, 'p1', 'v1', options)).rejects.toThrow();
});
it('requires explicit exclusive durable-job proof to recover a crash-left acquisition lock', async () => {
  const { root, http, provider } = await setup();
  const options = { mountdataRoot: join(root, 'mountdata'), jobId: 'job1', http };
  await acquireModrinthModpack(provider, 'p1', 'v1', options);
  await writeFile(join(root, 'mountdata/content-inputs/job1/.lock'), '');
  await expect(acquireModrinthModpack(provider, 'p1', 'v1', options)).rejects.toThrow();
  await expect(
    acquireModrinthModpack(provider, 'p1', 'v1', {
      ...options,
      assertExclusiveJob: async () => {
        throw new Error('not exclusive');
      },
    }),
  ).rejects.toThrow();
  expect(
    (
      await acquireModrinthModpack(provider, 'p1', 'v1', {
        ...options,
        assertExclusiveJob: async () => {},
      })
    ).plan.format,
  ).toBe('modrinth');
});
