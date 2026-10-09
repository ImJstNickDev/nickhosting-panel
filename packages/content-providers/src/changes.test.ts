import { describe, expect, it } from 'vitest';
import { type ContentPlan, type InstalledContentFile, installedContentChange } from './index.js';

const existing: InstalledContentFile[] = [
  {
    path: 'mods/app-old.jar',
    sha256: 'a'.repeat(64),
    provider: 'modrinth',
    projectId: 'app',
    versionId: 'app1',
    dependencies: ['lib'],
  },
  {
    path: 'mods/lib.jar',
    sha256: 'b'.repeat(64),
    provider: 'modrinth',
    projectId: 'lib',
    versionId: 'lib1',
    dependencies: [],
  },
];
function plan(projectId: string, versionId: string, path: string): ContentPlan {
  return {
    format: 'individual',
    target: { minecraftVersion: '1.21.1', loader: 'fabric' },
    artifacts: [
      {
        path,
        projectId,
        versionId,
        kind: 'mod',
        serverSide: 'required',
        urls: ['https://cdn.modrinth.com/a'],
        size: 1,
        hashes: { sha256: 'c'.repeat(64) },
      },
    ],
    projects: [{ provider: 'modrinth', projectId, versionId, dependencies: [] }],
    overrides: [],
    warnings: [],
  };
}
describe('installed content update/removal preconditions', () => {
  it('prepares old filename cleanup with exact hash evidence', () => {
    expect(installedContentChange(existing, plan('app', 'app2', 'mods/app-new.jar'))).toEqual({
      removePaths: ['mods/app-old.jar'],
      replacements: [{ path: 'mods/app-old.jar', previousSha256: 'a'.repeat(64) }],
    });
  });
  it('rejects removing a dependency until all dependents are removed', () => {
    expect(() =>
      installedContentChange(existing, { remove: { provider: 'modrinth', projectId: 'lib' } }),
    ).toThrow();
    expect(
      installedContentChange(existing, { remove: { provider: 'modrinth', projectId: 'app' } })
        .removePaths,
    ).toEqual(['mods/app-old.jar']);
  });
  it('requires dependent re-resolution before changing a shared dependency version', () => {
    expect(() => installedContentChange(existing, plan('lib', 'lib2', 'mods/lib.jar'))).toThrow();
    expect(
      installedContentChange(existing, plan('lib', 'lib1', 'mods/lib.jar')).removePaths,
    ).toEqual([]);
  });
  it('rejects overwriting another project and case aliases', () => {
    expect(() =>
      installedContentChange(existing, plan('other', 'other1', 'mods/app-old.jar')),
    ).toThrow();
    expect(() =>
      installedContentChange(existing, plan('app', 'app2', 'mods/APP-old.jar')),
    ).toThrow();
  });
  it('never silently merges conflicting installed version records', () => {
    expect(() =>
      installedContentChange(
        [
          ...existing,
          {
            ...(existing[0] as InstalledContentFile),
            path: 'mods/app-other.jar',
            versionId: 'other',
          },
        ],
        plan('app', 'app2', 'mods/app.jar'),
      ),
    ).toThrow();
  });
  it('preserves incompatibilities from installed projects in both directions', () => {
    const installed = [
      {
        ...(existing[0] as InstalledContentFile),
        dependencies: [],
        incompatible: [{ provider: 'modrinth' as const, projectId: 'blocked' }],
      },
    ];
    expect(() =>
      installedContentChange(installed, plan('blocked', 'v1', 'mods/blocked.jar')),
    ).toThrow();
    const incoming = plan('incoming', 'v1', 'mods/incoming.jar');
    (incoming.projects[0] as ContentPlan['projects'][number]).incompatible = [
      { provider: 'modrinth', projectId: 'app' },
    ];
    expect(() => installedContentChange(installed, incoming)).toThrow();
  });
  it('honors exact forbidden versions and provider namespaces', () => {
    const installed = [
      {
        ...(existing[0] as InstalledContentFile),
        dependencies: [],
        incompatible: [{ provider: 'modrinth' as const, projectId: 'blocked', versionId: 'v1' }],
      },
    ];
    expect(() =>
      installedContentChange(installed, plan('blocked', 'v1', 'mods/blocked.jar')),
    ).toThrow();
    expect(() =>
      installedContentChange(installed, plan('blocked', 'v2', 'mods/blocked.jar')),
    ).not.toThrow();
    const anotherProvider = plan('blocked', 'v1', 'mods/blocked.jar');
    (anotherProvider.projects[0] as ContentPlan['projects'][number]).provider = 'curseforge';
    expect(() => installedContentChange(installed, anotherProvider)).not.toThrow();
  });
  it('checks a newly required dependency against retained projects', () => {
    const incoming = plan('incoming', 'v1', 'mods/incoming.jar');
    const dependency = plan('dependency', 'v1', 'mods/dependency.jar');
    (incoming.projects[0] as ContentPlan['projects'][number]).dependencies = ['dependency'];
    (dependency.projects[0] as ContentPlan['projects'][number]).incompatible = [
      { provider: 'modrinth', projectId: 'app' },
    ];
    incoming.projects.push(...dependency.projects);
    incoming.artifacts.push(...dependency.artifacts);
    expect(() => installedContentChange(existing, incoming)).toThrow();
  });
  it('discards replaced or removed project constraints without discarding retained ones', () => {
    const installed = [
      {
        ...(existing[0] as InstalledContentFile),
        dependencies: [],
        incompatible: [{ provider: 'modrinth' as const, projectId: 'blocked' }],
      },
    ];
    const replacement = plan('app', 'app2', 'mods/app-new.jar');
    const added = plan('blocked', 'v1', 'mods/blocked.jar');
    replacement.projects.push(...added.projects);
    replacement.artifacts.push(...added.artifacts);
    expect(() => installedContentChange(installed, replacement)).not.toThrow();
    const removed = installedContentChange(installed, {
      remove: { provider: 'modrinth', projectId: 'app' },
    });
    expect(() =>
      installedContentChange(
        installed.filter((file) => !removed.removePaths.includes(file.path)),
        added,
      ),
    ).not.toThrow();
  });
});
