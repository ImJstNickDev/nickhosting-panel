import { describe, expect, it, vi } from 'vitest';
import type { ModCatalogVersion } from '../../content-providers/src/mod-catalog.js';
import type { ResolvedMods } from '../../content-providers/src/mod-resolution.js';
import {
  type ModAdviceProvider,
  modAlternativeAdvice,
  modUpdateAdvice,
} from './minecraft-mod-advice.js';

const target = { minecraftVersion: '26.1', loader: 'fabric' as const };
function version(
  id: string,
  day: number,
  extra: Partial<ModCatalogVersion> = {},
): ModCatalogVersion {
  return {
    id,
    provider: 'modrinth',
    projectId: 'mod',
    name: id,
    version: id,
    filename: `${id}.jar`,
    gameVersions: ['26.1'],
    loaders: ['fabric'],
    publishedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`,
    bytes: 100,
    channel: 'release',
    available: true,
    compatibility: [],
    environment: { kind: 'both', source: 'modrinth', original: [] },
    ...extra,
  };
}
function fixture(versions: ModCatalogVersion[], current = version('old', 1)) {
  const provider = {
    modVersion: vi.fn<ModAdviceProvider['modVersion']>(async () => current),
    modVersions: vi.fn(async (_id, input) => ({
      items: versions.slice(input.offset ?? 0, (input.offset ?? 0) + 20),
      total: versions.length,
    })),
    resolveMods: vi.fn<ModAdviceProvider['resolveMods']>(async () => ({
      plan: {
        format: 'individual',
        target,
        artifacts: [],
        overrides: [],
        projects: [],
        warnings: [],
      },
      catalog: { blocked: [], items: [], optional: [], embedded: [] },
    })),
  } satisfies ModAdviceProvider;
  const input = {
    packs: [
      {
        path: 'mods/old.jar',
        provider: 'modrinth' as const,
        projectId: 'mod',
        versionId: current.id,
      },
    ],
    provider: () => provider,
    target,
    preferBeta: false,
  };
  return { provider, input };
}
describe('bounded read-only Mods advice', () => {
  it('offers a newer compatible stable, never the newer beta by default', async () => {
    const { input, provider } = fixture([
      version('beta', 20, { channel: 'beta' }),
      version('stable', 15),
    ]);
    expect((await modUpdateAdvice(input)).items[0]).toMatchObject({
      status: 'update',
      version: { id: 'stable' },
    });
    expect((await modUpdateAdvice({ ...input, preferBeta: true })).items[0]?.version?.id).toBe(
      'beta',
    );
    expect(provider.resolveMods).not.toHaveBeenCalled();
  });
  it('does not downgrade a newer installed beta to an older stable release', async () => {
    const { input } = fixture(
      [version('stable', 10)],
      version('installed-beta', 20, { channel: 'beta' }),
    );
    expect((await modUpdateAdvice(input)).items[0]?.status).toBe('current');
  });
  it('does not offer same timestamp or same ID as a newer update', async () => {
    const { input } = fixture([version('other', 10)], version('installed', 10));
    expect((await modUpdateAdvice(input)).items[0]?.status).toBe('current');
  });
  it('excludes client-only, incompatible, distribution-denied and alpha candidates', async () => {
    const { input } = fixture([
      version('client', 20, { compatibility: ['client-only'] }),
      version('wrong-game', 19, { compatibility: ['minecraft-version'] }),
      version('denied', 18, { available: false }),
      version('alpha', 17, { channel: 'alpha' }),
      version('ok', 2),
    ]);
    expect((await modUpdateAdvice(input)).items[0]?.version?.id).toBe('ok');
  });
  it('uses beta fallback only after exhausting the catalog and reports an incomplete lookup', async () => {
    const { input, provider } = fixture(
      Array.from({ length: 80 }, (_, i) => version(`beta-${i}`, 20, { channel: 'beta' })),
    );
    expect((await modUpdateAdvice(input)).items[0]?.status).toBe('limited');
    expect(provider.modVersions).toHaveBeenCalledTimes(3);
    const short = fixture([version('only-beta', 5, { channel: 'beta' })]);
    expect((await modUpdateAdvice(short.input)).items[0]?.version?.id).toBe('only-beta');
  });
  it('deduplicates identical receipt lookups and preserves path/version identities', async () => {
    const { input, provider } = fixture([version('new', 10)]);
    const first = input.packs[0];
    if (!first) throw new Error('Missing fixture');
    input.packs.push({ ...first, path: 'mods/old.jar.disabled' });
    const result = await modUpdateAdvice(input);
    expect(provider.modVersion).toHaveBeenCalledTimes(1);
    expect(provider.modVersions).toHaveBeenCalledTimes(1);
    expect(result.items.map((item) => item.path)).toEqual([
      'mods/old.jar',
      'mods/old.jar.disabled',
    ]);
  });
  it('reports provider failures per item without hiding successful checks', async () => {
    const { input, provider } = fixture([version('new', 10)]);
    provider.modVersion.mockRejectedValueOnce(new Error('provider down'));
    const first = input.packs[0];
    if (!first) throw new Error('Missing fixture');
    input.packs.push({ ...first, projectId: 'second', path: 'mods/second.jar' });
    expect((await modUpdateAdvice(input)).items.map((item) => item.status)).toEqual([
      'unavailable',
      'update',
    ]);
  });
  it('returns an alternative only after resolving the complete selected provider graph', async () => {
    const { provider } = fixture([version('new', 10), version('older', 5)]);
    provider.resolveMods.mockResolvedValueOnce({
      catalog: { blocked: [{ reason: 'incompatible-version' }] },
    } as ResolvedMods);
    const roots = [
      { projectId: 'mod', optionalProjectIds: ['optional'], forceIncompatible: false },
      { projectId: 'other', versionId: 'pinned', optionalProjectIds: [], forceIncompatible: false },
    ];
    const result = await modAlternativeAdvice({
      provider,
      name: 'modrinth',
      projectId: 'mod',
      roots,
      revision: 3,
      target,
      preferBeta: false,
    });
    expect(result).toMatchObject({ revision: 3, checked: 2, items: [{ id: 'older' }] });
    expect(provider.resolveMods.mock.calls[1]?.[0]).toEqual([
      { ...roots[0], versionId: 'older' },
      roots[1],
    ]);
    expect(provider.resolveMods.mock.calls[0]?.[2]?.metadataMemo).toBe(
      provider.resolveMods.mock.calls[1]?.[2]?.metadataMemo,
    );
    expect(roots[0]).not.toHaveProperty('versionId');
  });
  it('retains completed checks when the shared deadline expires without starting remaining lookups', async () => {
    const { input, provider } = fixture([version('new', 10)]);
    const controller = new AbortController();
    const first = input.packs[0];
    if (!first) throw new Error('Missing fixture');
    input.packs = ['fast', 'slow', 'third', 'fourth'].map((projectId) => ({ ...first, projectId }));
    provider.modVersion.mockImplementation(async (projectId) => {
      if (projectId === 'fast') return version('old', 1);
      if (projectId === 'third') controller.abort();
      if (controller.signal.aborted) throw new Error('deadline');
      return new Promise((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error('deadline')), {
          once: true,
        }),
      );
    });
    const result = await modUpdateAdvice({ ...input, signal: controller.signal });
    expect(result.items.map((item) => item.status)).toEqual([
      'update',
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
    expect(provider.modVersion.mock.calls.map(([projectId]) => projectId)).toEqual([
      'fast',
      'slow',
      'third',
    ]);
  });
  it('caps alternative attempts and never claims an exhaustive negative result', async () => {
    const { provider } = fixture(Array.from({ length: 10 }, (_, i) => version(`v${i}`, 20 - i)));
    provider.resolveMods.mockResolvedValue({
      catalog: { blocked: [{ reason: 'conflict' }] },
    } as ResolvedMods);
    const result = await modAlternativeAdvice({
      provider,
      name: 'modrinth',
      projectId: 'mod',
      roots: [{ projectId: 'mod', optionalProjectIds: [], forceIncompatible: false }],
      revision: 1,
      target,
      preferBeta: false,
    });
    expect(result).toMatchObject({ checked: 5, items: [], limited: true });
    expect(provider.resolveMods).toHaveBeenCalledTimes(5);
  });
});
