import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertStorageDirectory,
  isOutsideWorkspace,
  resolveStorageRoot,
  storagePath,
} from '../deploy/storage-root.mjs';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nh-storage-root-'));
  roots.push(root);
  const workspace = join(root, 'repo');
  await mkdir(workspace);
  return { root, workspace };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('host storage root', () => {
  it('defaults to workspace mountdata without creating anything', async () => {
    const { workspace } = await fixture();
    const path = resolveStorageRoot({ workspaceRoot: workspace, env: {} });
    expect(path).toBe(join(workspace, 'mountdata'));
    expect(() => assertStorageDirectory(path)).toThrow();
  });

  it('uses only the storage key in the private file and lets environment override it', async () => {
    const { root, workspace } = await fixture();
    const target = join(root, 'external data');
    await mkdir(target);
    await writeFile(
      join(workspace, '.env.dev.local'),
      `NH_MOUNTDATA_ROOT="${target}"\nUNRELATED_SECRET=must-not-be-exported\n`,
    );
    const env = {};
    expect(resolveStorageRoot({ workspaceRoot: workspace, env })).toBe(target);
    expect(env).toEqual({});
    expect(
      resolveStorageRoot({
        workspaceRoot: workspace,
        env: { NH_MOUNTDATA_ROOT: './another-root' },
      }),
    ).toBe(join(workspace, 'another-root'));
    expect(resolveStorageRoot({ workspaceRoot: workspace, env: {}, envFile: false })).toBe(
      join(workspace, 'mountdata'),
    );
    expect(storagePath('test-assets/run.json', { workspaceRoot: workspace, env })).toBe(
      join(target, 'test-assets/run.json'),
    );
  });

  it('refuses invalid roots and escaping descendants', async () => {
    const { root, workspace } = await fixture();
    for (const value of ['', ' ', '/', '.', 'bad\npath'])
      expect(() =>
        resolveStorageRoot({ workspaceRoot: workspace, env: { NH_MOUNTDATA_ROOT: value } }),
      ).toThrow();
    const options = { workspaceRoot: workspace, env: { NH_MOUNTDATA_ROOT: root } };
    for (const value of ['', '.', '..', '../outside', '/tmp/elsewhere', 'bad\0path'])
      expect(() => storagePath(value, options)).toThrow();
  });

  it('never follows a symlink mountpoint or ancestor', async () => {
    const { root, workspace } = await fixture();
    await mkdir(join(root, 'real', 'child'), { recursive: true });
    await symlink(join(root, 'real'), join(workspace, 'alias'));
    expect(() => assertStorageDirectory(join(workspace, 'alias'))).toThrow();
    expect(() => assertStorageDirectory(join(workspace, 'alias', 'child'))).toThrow();
    await symlink(join(root, 'missing-env'), join(workspace, '.env.dev.local'));
    expect(() => resolveStorageRoot({ workspaceRoot: workspace, env: {} })).toThrow();
  });

  it('classifies external evidence without weakening containment checks', async () => {
    const { root, workspace } = await fixture();
    expect(isOutsideWorkspace(join(root, 'external', 'ledger.json'), workspace)).toBe(true);
    expect(isOutsideWorkspace(join(workspace, 'mountdata', 'ledger.json'), workspace)).toBe(false);
    expect(isOutsideWorkspace(workspace, workspace)).toBe(false);
  });

  it('exposes the same private-root resolution to shell and Python tools', async () => {
    const { root, workspace } = await fixture();
    const target = join(root, 'external');
    await mkdir(target);
    await writeFile(join(workspace, '.env.dev.local'), `NH_MOUNTDATA_ROOT=${target}\n`);
    const env = { ...process.env };
    delete env.NH_MOUNTDATA_ROOT;
    const result = spawnSync(
      process.execPath,
      [resolve('deploy/storage-root.mjs'), '--workspace', workspace, '--require-existing'],
      { env, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(target);
  });
});
