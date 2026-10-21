import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { minecraftModpackPrepareSchema } from '../../../games/minecraft/src/modpack-contracts.js';
import {
  assertMinecraftModpackPlanCurrent,
  type MinecraftModpackObservation,
  modpackDigest,
  type PreparedMinecraftModpack,
  planMinecraftModpack,
  preparedModpackSchema,
} from './minecraft-modpacks-plan.js';

const target = { minecraftVersion: '1.21.1', loader: 'fabric' as const, loaderVersion: '0.16.10' };
const binding = { combinationId: randomUUID(), mappingId: randomUUID(), target };
const file = (path: string, hash = 'a') => ({
  path,
  size: 50,
  sha256: hash.repeat(64),
  modifiedAt: '2026-01-01T00:00:00Z',
});
const pack: PreparedMinecraftModpack['pack'] = {
  project: {
    provider: 'modrinth',
    id: 'pack',
    name: 'Pack',
    summary: '',
    websiteUrl: 'https://example.test/pack',
    authors: [],
  },
  version: {
    id: 'v2',
    projectId: 'pack',
    name: 'v2',
    version: '2.0',
    minecraftVersions: ['1.21.1'],
    loaders: ['fabric'],
    channel: 'release',
    available: true,
    source: 'modrinth-index',
  },
};
function fixture() {
  const observation: MinecraftModpackObservation = {
    combinationId: binding.combinationId,
    mappingId: binding.mappingId,
    entries: [],
    worldRoots: ['world'],
    protectedPaths: ['server.jar', 'libraries'],
    replacePaths: ['mods', 'config'],
  };
  const prepared: PreparedMinecraftModpack = {
    pack,
    target,
    stagingKey: 'private/stage',
    files: [],
    blockers: [],
  };
  return {
    selection: minecraftModpackPrepareSchema.parse({
      provider: 'modrinth',
      projectId: 'pack',
      versionId: 'v2',
      mode: 'update',
      idempotencyKey: 'key',
    }),
    prepared,
    observation,
    previous: {
      operationId: randomUUID(),
      receipt: {
        pack: { ...pack, version: { ...pack.version, id: 'v1' } },
        target,
        files: [] as ReturnType<typeof file>[],
      },
    },
    runtime: binding,
  };
}
const observed = (value: ReturnType<typeof file>) => ({ ...value, kind: 'file' as const });

describe('Modpack preparation policy', () => {
  it('permits only marked merged properties on initial install and binds the original snapshot', () => {
    const f = fixture();
    f.selection.mode = 'install';
    f.prepared.files = [file('server.properties', 'b')];
    f.prepared.propertiesMerged = true;
    f.prepared.propertiesSource = { size: 50, modifiedAt: '2026-01-01T00:00:00Z' };
    f.observation.entries = [observed(file('server.properties'))];
    const input = { ...f, previous: null };
    const plan = planMinecraftModpack(input);
    expect(plan.write.map((file) => file.path)).toEqual(['server.properties']);
    expect(plan.remove).toEqual(['server.properties']);
    expect(() => assertMinecraftModpackPlanCurrent(plan, f.observation)).not.toThrow();
    f.observation.entries[0] = {
      ...observed(file('server.properties')),
      modifiedAt: '2026-02-01T00:00:00Z',
    };
    expect(planMinecraftModpack(input).blockers).toContainEqual({
      reason: 'conflict',
      path: 'server.properties',
    });
  });
  it('keeps locally modified properties on update and honors an explicit use-pack decision', () => {
    const f = fixture();
    f.prepared.files = [file('server.properties', 'c')];
    f.prepared.propertiesMerged = true;
    f.prepared.propertiesSource = { size: 50, modifiedAt: '2026-01-01T00:00:00Z' };
    f.previous.receipt.files = [file('server.properties', 'a')];
    f.observation.entries = [observed(file('server.properties', 'b'))];
    expect(planMinecraftModpack(f).preserve).toContain('server.properties');
    f.selection.fileDecisions['server.properties'] = 'use-pack';
    expect(planMinecraftModpack(f).write.map((file) => file.path)).toEqual(['server.properties']);
  });
  it('blocks plans above the single publication limit before any apply effects', () => {
    const f = fixture();
    f.prepared.files = Array.from({ length: 10001 }, (_, index) => file(`mods/${index}.jar`));
    const plan = planMinecraftModpack(f);
    expect(plan.write).toHaveLength(10001);
    expect(plan.blockers).toContainEqual({ reason: 'publication-limit' });
    f.prepared.files.pop();
    expect(planMinecraftModpack(f).blockers).toEqual([]);
  });
  it('rejects world-reset flags for install/update and unsafe decision paths', () => {
    const selection = fixture().selection;
    expect(
      minecraftModpackPrepareSchema.safeParse({ ...selection, worldPolicy: 'reset' }).success,
    ).toBe(false);
    expect(
      minecraftModpackPrepareSchema.safeParse({
        ...selection,
        fileDecisions: { '../world/level.dat': 'use-pack' },
      }).success,
    ).toBe(false);
  });
  it('updates receipt-owned files and retires only exact unchanged fingerprints', () => {
    const f = fixture();
    f.previous.receipt.files = [
      file('mods/old.jar'),
      file('mods/modified.jar'),
      file('mods/same.jar'),
    ];
    f.observation.entries = [
      observed(file('mods/old.jar')),
      observed(file('mods/modified.jar', 'b')),
      observed(file('mods/same.jar')),
      observed(file('mods/user.jar')),
    ];
    f.prepared.files = [file('mods/new.jar'), file('mods/same.jar')];
    const plan = planMinecraftModpack(f);
    expect(plan.blockers).toEqual([]);
    expect(plan.remove).toEqual(['mods/old.jar']);
    expect(plan.write.map((entry) => entry.path)).toEqual(['mods/new.jar']);
    expect(plan.preserve).toEqual(['mods/modified.jar', 'mods/same.jar']);
    expect(plan.retained.find((entry) => entry.path === 'mods/modified.jar')?.sha256).toBe(
      'a'.repeat(64),
    );
    expect(plan.expected.some((entry) => entry.path === 'mods/user.jar')).toBe(false);
  });
  it('preserves changed configs by default, supports an explicit pack choice', () => {
    const f = fixture();
    f.previous.receipt.files = [file('config/settings.toml')];
    f.prepared.files = [file('config/settings.toml', 'c')];
    f.observation.entries = [observed(file('config/settings.toml', 'b'))];
    const kept = planMinecraftModpack(f);
    expect(kept.write).toEqual([]);
    expect(kept.blockers).toEqual([]);
    expect(kept.preserve).toEqual(['config/settings.toml']);
    f.selection.fileDecisions['config/settings.toml'] = 'use-pack';
    const replaced = planMinecraftModpack(f);
    expect(replaced.write[0]?.sha256).toBe('c'.repeat(64));
    expect(replaced.remove).toEqual(['config/settings.toml']);
  });
  it('does not grant new ownership to untracked configurations', () => {
    const f = fixture();
    f.prepared.files = [file('config/local.toml')];
    f.observation.entries = [observed(file('config/local.toml', 'b'))];
    const plan = planMinecraftModpack(f);
    expect(plan.preserve).toEqual(['config/local.toml']);
    expect(plan.retained).toEqual([]);
  });
  it('blocks modified binary conflicts until a deliberate keep/use choice', () => {
    const f = fixture();
    f.previous.receipt.files = [file('mods/mod.jar')];
    f.observation.entries = [observed(file('mods/mod.jar', 'b'))];
    f.prepared.files = [file('mods/mod.jar', 'c')];
    expect(planMinecraftModpack(f).blockers).toContainEqual({
      reason: 'modified-file',
      path: 'mods/mod.jar',
    });
    f.selection.fileDecisions['mods/mod.jar'] = 'keep-local';
    expect(planMinecraftModpack(f).blockers).toEqual([]);
  });
  it('protects worlds, runtime and identity settings even when the pack supplies them', () => {
    const f = fixture();
    f.prepared.files = [
      file('world/level.dat'),
      file('server.properties'),
      file('ops.json'),
      file('server.jar'),
    ];
    expect(planMinecraftModpack(f).write).toEqual([]);
    expect(planMinecraftModpack(f).preserve).toHaveLength(4);
  });
  it('requires an exact supported runtime and a pinned loader version', () => {
    const f = fixture();
    f.runtime = { ...binding, target: { ...target, loaderVersion: 'latest' } };
    expect(planMinecraftModpack(f).blockers).toContainEqual({ reason: 'runtime' });
    delete f.prepared.target.loaderVersion;
    expect(planMinecraftModpack(f).blockers).toContainEqual({ reason: 'loader-version' });
  });
  it('rejects symlink parents, even when the leaf does not exist', () => {
    const f = fixture();
    f.prepared.files = [file('mods/mod.jar')];
    f.observation.entries = [{ path: 'mods', kind: 'symlink', size: 0 }];
    expect(planMinecraftModpack(f).blockers).toContainEqual({
      reason: 'protected-path',
      path: 'mods/mod.jar',
    });
  });
  it('resets only observed world roots after explicit replacement policy', () => {
    const f = fixture();
    f.selection.mode = 'replace';
    f.selection.worldPolicy = 'reset';
    f.observation.entries = [
      { path: 'mods', kind: 'directory', size: 0 },
      { path: 'world', kind: 'directory', size: 0 },
    ];
    expect(planMinecraftModpack(f).remove).toEqual(['mods', 'world']);
  });
  it('does not delete a root containing a configuration the user kept', () => {
    const f = fixture();
    f.selection.mode = 'replace';
    f.prepared.files = [file('config/keep.toml')];
    f.observation.entries = [
      { path: 'config', kind: 'directory', size: 0 },
      observed(file('config/keep.toml', 'b')),
      observed(file('config/remove.toml')),
    ];
    const plan = planMinecraftModpack(f);
    expect(plan.remove).toEqual(['config/remove.toml']);
    expect(plan.preserve).toEqual(['config/keep.toml']);
  });
  it('rejects changed candidates or runtime after preparation without reading artifact bytes again', () => {
    const f = fixture();
    f.prepared.files = [file('mods/new.jar')];
    const plan = planMinecraftModpack(f);
    expect(() => assertMinecraftModpackPlanCurrent(plan, f.observation)).not.toThrow();
    f.observation.entries.push(observed(file('mods/new.jar', 'b')));
    expect(() => assertMinecraftModpackPlanCurrent(plan, f.observation)).toThrow('conflict');
  });
  it('preserves digest identity across PostgreSQL JSON object ordering', () => {
    expect(modpackDigest({ a: { c: 1, b: 2 }, d: [1, 2] })).toBe(
      modpackDigest({ d: [1, 2], a: { b: 2, c: 1 } }),
    );
    expect(modpackDigest([1, 2])).not.toBe(modpackDigest([2, 1]));
  });
  it('rejects a file that is also another payload file parent', () => {
    const f = fixture();
    f.prepared.files = [file('mods'), file('mods-other'), file('mods/file.jar')];
    expect(preparedModpackSchema.safeParse(f.prepared).success).toBe(false);
  });
  it('detects a newly introduced symlink ancestor before publication', () => {
    const f = fixture();
    f.prepared.files = [file('mods/new.jar')];
    const plan = planMinecraftModpack(f);
    f.observation.entries.push({ path: 'mods', kind: 'symlink', size: 0 });
    expect(() => assertMinecraftModpackPlanCurrent(plan, f.observation)).toThrow('conflict');
  });
});
