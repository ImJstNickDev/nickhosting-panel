import { lstat, mkdtemp, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentFileUnchanged } from './file-verification.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nh-file-verification-'));
  roots.push(root);
  const path = join(root, 'archive.zip');
  await writeFile(path, 'original');
  return { root, path, identity: await lstat(path, { bigint: true }) };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ephemeral content verification identity', () => {
  it('reuses an unchanged local file without reading its contents', async () => {
    const { path, identity } = await fixture();
    expect(await contentFileUnchanged(path, identity)).toBe(true);
  });
  it('rejects same-size edits even when modification time is restored', async () => {
    const { path, identity } = await fixture();
    await writeFile(path, 'modified');
    await utimes(path, identity.atime, identity.mtime);
    expect(await contentFileUnchanged(path, identity)).toBe(false);
  });
  it('rejects replacement and symlink aliases', async () => {
    const { root, path, identity } = await fixture();
    const other = join(root, 'other');
    await writeFile(other, 'original');
    await rename(other, path);
    expect(await contentFileUnchanged(path, identity)).toBe(false);
    await rename(path, other);
    await symlink(other, path);
    expect(await contentFileUnchanged(path, identity)).toBe(false);
  });
});
