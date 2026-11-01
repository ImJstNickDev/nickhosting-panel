import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readArchiveFile, visitArchive } from './archive.js';
import type { ModpackStagedFile } from './modpack-staging.js';
import { buildModpackTransferArchive } from './modpack-transfer.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
async function fixture(entries: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'nh-modpack-transfer-'));
  roots.push(root);
  const directory = join(root, 'files');
  await mkdir(directory);
  const files: ModpackStagedFile[] = [];
  for (const [path, data] of Object.entries(entries)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), data);
    files.push({ path, size: Buffer.byteLength(data), sha256: sha(data) });
  }
  return {
    root,
    directory,
    files,
    stagingRoot: '.nickhosting-pack-test-stage',
    destination: join(root, 'transfer.zip'),
  };
}
describe('prepared modpack transfer archive', () => {
  it('creates one STORE ZIP with hidden-root paths and exact sealed file/ZIP hashes', async () => {
    const f = await fixture({
      'config/example.json': '{"a":1}',
      'kubejs/server_scripts/test.js': 'event => event',
    });
    const result = await buildModpackTransferArchive(f);
    expect(result).not.toBeNull();
    const data = await readFile(f.destination);
    expect(result?.archiveBytes).toBe(data.length);
    expect(result?.archiveSha256).toBe(sha(data));
    expect(result?.expandedBytes).toBe(f.files.reduce((sum, file) => sum + file.size, 0));
    expect(result?.files.map((file) => file.path)).toEqual(
      f.files.map((file) => `${f.stagingRoot}/${file.path}`),
    );
    const seen: string[] = [];
    await visitArchive(f.destination, async (file) => {
      expect(file.entry.compressionMethod).toBe(0);
      expect((file.entry.externalFileAttributes >>> 16) & 0o777).toBe(0o644);
      seen.push(file.path);
      const content = await readArchiveFile(file, 1024);
      expect(sha(content)).toBe(result?.files.find((entry) => entry.path === file.path)?.sha256);
    });
    expect(seen).toHaveLength(2);
  });
  it('skips an empty selection without writing an archive', async () => {
    const f = await fixture({});
    expect(await buildModpackTransferArchive(f)).toBeNull();
    expect(await readdir(f.root)).toEqual(['files']);
  });
  it('packs only selected plan writes, preserving other prepared files', async () => {
    const f = await fixture({ 'config/keep.txt': 'local', 'config/write.txt': 'new' });
    const result = await buildModpackTransferArchive({
      ...f,
      files: f.files.filter((file) => file.path.endsWith('write.txt')),
    });
    expect(result?.files.map((x) => x.path)).toEqual([`${f.stagingRoot}/config/write.txt`]);
    expect(await readFile(join(f.directory, 'config/keep.txt'), 'utf8')).toBe('local');
  });
  it('rejects same-size source mutation and removes the incomplete ZIP', async () => {
    const f = await fixture({ 'config/a.txt': 'old' });
    await writeFile(join(f.directory, 'config/a.txt'), 'new');
    await expect(buildModpackTransferArchive(f)).rejects.toThrow('stage_file_changed');
    expect(await readdir(f.root)).toEqual(['files']);
  });
  it('rejects stale file sizes and missing sources without emitting a usable archive', async () => {
    const f = await fixture({ 'config/a.txt': 'old' });
    await writeFile(join(f.directory, 'config/a.txt'), 'longer');
    await expect(buildModpackTransferArchive(f)).rejects.toThrow();
    expect(await readdir(f.root)).toEqual(['files']);
  });
  it.each(['file', 'directory'])('does not follow source %s symlinks', async (kind) => {
    const f = await fixture({ 'config/a.txt': 'safe' });
    const external = join(f.root, 'external');
    await mkdir(external);
    await writeFile(join(external, 'a.txt'), 'safe');
    if (kind === 'file') {
      await rm(join(f.directory, 'config/a.txt'));
      await symlink(join(external, 'a.txt'), join(f.directory, 'config/a.txt'));
    } else {
      await rm(join(f.directory, 'config'), { recursive: true });
      await symlink(external, join(f.directory, 'config'));
    }
    await expect(buildModpackTransferArchive(f)).rejects.toThrow();
    await expect(readFile(f.destination)).rejects.toThrow();
  });
  it('never overwrites or deletes an existing destination on failure', async () => {
    const f = await fixture({ 'config/a.txt': 'safe' });
    await writeFile(f.destination, 'existing');
    await expect(buildModpackTransferArchive(f)).rejects.toThrow();
    expect(await readFile(f.destination, 'utf8')).toBe('existing');
  });
  it('rejects untrusted staging roots, path collisions and output inside input tree', async () => {
    const f = await fixture({ 'config/a.txt': 'safe' });
    for (const stagingRoot of [
      'world',
      '../escape',
      '.nickhosting-pack-../bad-stage',
      '.nickhosting-pack-a-stage/x',
    ]) {
      await expect(buildModpackTransferArchive({ ...f, stagingRoot })).rejects.toThrow();
    }
    await expect(
      buildModpackTransferArchive({ ...f, files: [...f.files, ...f.files] }),
    ).rejects.toThrow();
    await expect(
      buildModpackTransferArchive({ ...f, destination: join(f.directory, 'output.zip') }),
    ).rejects.toThrow();
  });
  it('stops cancelled work and removes a partial archive', async () => {
    const f = await fixture({ 'config/big.bin': Buffer.alloc(8 * 1024 * 1024, 123) });
    const controller = new AbortController();
    const pending = buildModpackTransferArchive({ ...f, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(new Error('cancel transfer')), 2);
    try {
      await expect(pending).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
    await expect(readFile(f.destination)).rejects.toThrow();
  });
});
