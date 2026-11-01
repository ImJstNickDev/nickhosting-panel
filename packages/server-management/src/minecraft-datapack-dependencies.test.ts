import type { FilemanEntry } from '@nickhosting/game-sdk';
import { describe, expect, it } from 'vitest';
import {
  assertDatapackDependencyGraph,
  type DatapackProvenance,
  type DatapackReceipt,
  datapackReceipts,
} from './minecraft-datapack-dependencies.js';

const catalog = (
  projectId: string,
  required: DatapackProvenance['required'] = [],
  conflicts: DatapackProvenance['conflicts'] = [],
): DatapackProvenance => ({
  provider: 'modrinth',
  projectId,
  versionId: 'v1',
  required,
  conflicts,
  mods: [],
});
const receipt = (projectId: string, data = catalog(projectId)): DatapackReceipt => ({
  path: `world/datapacks/${projectId}.zip`,
  size: 12,
  modifiedAt: '2026-01-01T00:00:00Z',
  enabled: true,
  catalog: data,
});
const entries = (receipts: DatapackReceipt[]) =>
  new Map(
    receipts.map((item) => [
      item.path,
      {
        name: item.path.split('/').at(-1) ?? item.path,
        kind: 'file',
        size: item.size,
        modifiedAt: item.modifiedAt,
      } as FilemanEntry,
    ]),
  );
const change = (projectId: string, data = catalog(projectId), action = 'install') => ({
  action,
  state: 'ready',
  plan: {
    from: `world/datapacks/${projectId}.zip.pending`,
    to: `world/datapacks/${projectId}.zip`,
    size: 12,
    catalog: data,
  },
});

describe('datapack durable final graph', () => {
  it('publishes complete prepared graphs without provider access', () => {
    expect(() =>
      assertDatapackDependencyGraph(
        [],
        [change('root', catalog('root', [{ projectId: 'dep' }])), change('dep')],
        new Map(),
      ),
    ).not.toThrow();
  });
  it.each(['cancelled', 'failed', 'preparing', 'uncertain'])(
    'blocks root when dependency is %s',
    (state) => {
      expect(() =>
        assertDatapackDependencyGraph(
          [],
          [change('root', catalog('root', [{ projectId: 'dep' }])), { ...change('dep'), state }],
          new Map(),
        ),
      ).toThrow(expect.objectContaining({ code: 'content_dependency_missing' }));
    },
  );
  it('reuses observed installed exact versions and rejects stale receipts', () => {
    const dep = receipt('dep');
    const root = change('root', catalog('root', [{ projectId: 'dep', versionId: 'v1' }]));
    expect(() => assertDatapackDependencyGraph([dep], [root], entries([dep]))).not.toThrow();
    const stale = entries([dep]);
    stale.set(dep.path, { name: 'dep.zip', kind: 'file', size: 12, modifiedAt: 'changed' });
    expect(() => assertDatapackDependencyGraph([dep], [root], stale)).toThrow();
    expect(() =>
      assertDatapackDependencyGraph(
        [dep],
        [change('root', catalog('root', [{ projectId: 'dep', versionId: 'v2' }]))],
        entries([dep]),
      ),
    ).toThrow();
  });
  it.each(['disable', 'delete'])(
    'blocks %s of a required installed dependency but allows removing its consumer too',
    (action) => {
      const dep = receipt('dep'),
        root = receipt('root', catalog('root', [{ projectId: 'dep' }]));
      const remove = {
        action,
        state: 'ready',
        plan: {
          from: dep.path,
          to: action === 'disable' ? `${dep.path}.disabled` : null,
          size: 12,
          catalog: dep.catalog,
        },
      };
      expect(() =>
        assertDatapackDependencyGraph([dep, root], [remove], entries([dep, root])),
      ).toThrow();
      expect(() =>
        assertDatapackDependencyGraph(
          [dep, root],
          [
            remove,
            {
              action: 'delete',
              state: 'ready',
              plan: { from: root.path, to: null, size: 12, catalog: root.catalog },
            },
          ],
          entries([dep, root]),
        ),
      ).not.toThrow();
    },
  );
  it('requires explicit enable of disabled dependency', () => {
    const dep = { ...receipt('dep'), enabled: false, path: 'world/datapacks/dep.zip.disabled' };
    const root = change('root', catalog('root', [{ projectId: 'dep' }]));
    expect(() => assertDatapackDependencyGraph([dep], [root], entries([dep]))).toThrow();
    expect(() =>
      assertDatapackDependencyGraph(
        [dep],
        [
          root,
          {
            action: 'enable',
            state: 'ready',
            plan: { from: dep.path, to: 'world/datapacks/dep.zip', size: 12, catalog: dep.catalog },
          },
        ],
        entries([dep]),
      ),
    ).not.toThrow();
  });
  it('enforces conflicts in either direction and honors explicit disable', () => {
    for (const reverse of [false, true]) {
      const old = receipt('old', catalog('old', [], reverse ? [{ projectId: 'root' }] : []));
      const root = change('root', catalog('root', [], reverse ? [] : [{ projectId: 'old' }]));
      expect(() => assertDatapackDependencyGraph([old], [root], entries([old]))).toThrow(
        expect.objectContaining({ code: 'content_dependency_conflict' }),
      );
      expect(() =>
        assertDatapackDependencyGraph(
          [old],
          [
            root,
            {
              action: 'disable',
              state: 'ready',
              plan: { from: old.path, to: `${old.path}.disabled`, size: 12, catalog: old.catalog },
            },
          ],
          entries([old]),
        ),
      ).not.toThrow();
    }
  });
  it('keeps replacements of disabled archives outside the active dependency graph', () => {
    const pack = change('root', catalog('root', [{ projectId: 'missing' }]));
    pack.plan.to = 'world/datapacks/root.zip.disabled';
    expect(() => assertDatapackDependencyGraph([], [pack], new Map())).not.toThrow();
  });
  it('never confuses providers with identical project IDs', () => {
    const dep = receipt('dep');
    dep.catalog.provider = 'curseforge';
    expect(() =>
      assertDatapackDependencyGraph(
        [dep],
        [change('root', catalog('root', [{ projectId: 'dep' }]))],
        entries([dep]),
      ),
    ).toThrow();
  });
  it('checks observed mod proof without reading bytes again', () => {
    const root = catalog('root', [{ projectId: 'mod', versionId: 'v2' }]);
    root.mods = [
      {
        projectId: 'mod',
        versionId: 'v2',
        path: 'mods/real.jar',
        size: 12,
        modifiedAt: 'observed',
      },
    ];
    const files = new Map<string, FilemanEntry>([
      ['mods/real.jar', { name: 'real.jar', kind: 'file', size: 12, modifiedAt: 'observed' }],
    ]);
    expect(() => assertDatapackDependencyGraph([], [change('root', root)], files)).not.toThrow();
    files.set('mods/real.jar', { name: 'real.jar', kind: 'file', size: 12, modifiedAt: 'changed' });
    expect(() => assertDatapackDependencyGraph([], [change('root', root)], files)).toThrow();
  });
  it('checks freshly installed mod conflicts in both directions', () => {
    const files = new Map<string, FilemanEntry>([
      ['mods/m.jar', { name: 'm.jar', kind: 'file', size: 12 }],
    ]);
    for (const reverse of [false, true])
      expect(() =>
        assertDatapackDependencyGraph(
          [],
          [change('root', catalog('root', [], reverse ? [] : [{ projectId: 'mod' }]))],
          files,
          [
            {
              path: 'mods/m.jar',
              provider: 'modrinth',
              projectId: 'mod',
              versionId: 'v1',
              incompatible: reverse ? [{ provider: 'modrinth', projectId: 'root' }] : [],
            },
          ],
        ),
      ).toThrow();
  });
  it('invalidates history after delete or untracked replacement', () => {
    const old = {
      action: 'install',
      state: 'applied',
      plan: {
        from: 'pending',
        to: 'world/datapacks/a.zip',
        size: 12,
        modifiedAt: 'observed',
        catalog: catalog('a'),
      },
    };
    expect(datapackReceipts([old])).toHaveLength(1);
    expect(
      datapackReceipts([
        {
          action: 'delete',
          state: 'applied',
          plan: { from: 'world/datapacks/a.zip', to: null, size: 12 },
        },
        old,
      ]),
    ).toHaveLength(0);
    expect(
      datapackReceipts([
        {
          action: 'install',
          state: 'applied',
          plan: { from: 'pending2', to: 'world/datapacks/a.zip', size: 12 },
        },
        old,
      ]),
    ).toHaveLength(0);
  });
});
