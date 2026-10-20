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
      maxVersions: 25,
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
      maxVersions: 5,
      target,
      preferBeta: false,
    });
    expect(result).toMatchObject({ checked: 5, items: [], limited: true });
    expect(provider.resolveMods).toHaveBeenCalledTimes(5);
  });

  const roots = [{ projectId: 'mod', optionalProjectIds: [], forceIncompatible: false }];
  const alternatives = (provider: ModAdviceProvider, extra = {}) =>
    modAlternativeAdvice({
      provider,
      name: 'modrinth',
      projectId: 'mod',
      roots,
      revision: 1,
      maxVersions: 25,
      target,
      preferBeta: false,
      ...extra,
    });
  const blocked = { catalog: { blocked: [{ reason: 'conflict' }] } } as ResolvedMods;
  const accepted = { catalog: { blocked: [] } } as unknown as ResolvedMods;
  const releases = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      version(`v${i + 1}`, 20, {
        publishedAt: new Date(Date.UTC(2026, 9, 20) - i * 60_000).toISOString(),
      }),
    );

  it('continues to the next page and stops at the first valid alternative', async () => {
    const { provider } = fixture(releases(80));
    provider.resolveMods.mockImplementation(async ([root]) =>
      root?.versionId === 'v21' ? accepted : blocked,
    );
    const result = await alternatives(provider);
    expect(result).toMatchObject({ checked: 21, items: [{ id: 'v21' }], limited: false });
    expect(provider.modVersions.mock.calls.map(([, input]) => input.offset)).toEqual([0, 20]);
    expect(provider.resolveMods).toHaveBeenCalledTimes(21);
    const memo = provider.modVersions.mock.calls[0]?.[1].metadataMemo;
    expect(memo).toBeDefined();
    expect(provider.modVersions.mock.calls[1]?.[1].metadataMemo).toBe(memo);
    expect(
      provider.resolveMods.mock.calls.every(([, , options]) => options?.metadataMemo === memo),
    ).toBe(true);
  });

  it('does not fetch another page after an early hit', async () => {
    const { provider } = fixture(releases(80));
    provider.resolveMods.mockResolvedValueOnce(blocked).mockResolvedValueOnce(blocked);
    expect(await alternatives(provider)).toMatchObject({ checked: 3, items: [{ id: 'v3' }] });
    expect(provider.modVersions).toHaveBeenCalledTimes(1);
    expect(provider.resolveMods).toHaveBeenCalledTimes(3);
  });

  it.each([2, 25, 65])(
    'respects the configured limit of %i without an extra resolution',
    async (maxVersions) => {
      const { provider } = fixture(releases(80));
      provider.resolveMods.mockResolvedValue(blocked);
      expect(await alternatives(provider, { maxVersions })).toMatchObject({
        checked: maxVersions,
        items: [],
        limited: true,
      });
      expect(provider.resolveMods).toHaveBeenCalledTimes(maxVersions);
      expect(provider.modVersions).toHaveBeenCalledTimes(Math.ceil(maxVersions / 20));
    },
  );

  it('prefers a stable on a later page to a newer beta unless beta preference is enabled', async () => {
    const items = [
      ...releases(20).map((item) => ({ ...item, channel: 'beta' as const })),
      version('stable', 1),
    ];
    const { provider } = fixture(items);
    expect(await alternatives(provider)).toMatchObject({ checked: 1, items: [{ id: 'stable' }] });
    expect(provider.modVersions).toHaveBeenCalledTimes(2);
    const beta = fixture(items);
    expect(await alternatives(beta.provider, { preferBeta: true })).toMatchObject({
      checked: 1,
      items: [{ id: 'v1' }],
    });
    expect(beta.provider.modVersions).toHaveBeenCalledTimes(1);
  });

  it('only falls back to beta once the catalog is exhausted', async () => {
    const items = releases(80).map((item) => ({ ...item, channel: 'beta' as const }));
    const { provider } = fixture(items);
    expect(await alternatives(provider)).toMatchObject({ checked: 0, items: [], limited: true });
    expect(provider.modVersions).toHaveBeenCalledTimes(3);
    expect(provider.resolveMods).not.toHaveBeenCalled();
    const short = fixture(items.slice(0, 2));
    expect(await alternatives(short.provider)).toMatchObject({ checked: 1, items: [{ id: 'v1' }] });
  });

  it('skips duplicates, current, alpha, incompatible and unavailable files without consuming attempts', async () => {
    const items = [
      version('pinned', 20),
      version('alpha', 19, { channel: 'alpha' }),
      version('denied', 18, { available: false }),
      version('client', 17, { compatibility: ['client-only'] }),
      version('blocked', 16),
      version('blocked', 16),
      version('ok', 15),
    ];
    const { provider } = fixture(items);
    provider.resolveMods.mockResolvedValueOnce(blocked);
    expect(
      await alternatives(provider, {
        maxVersions: 2,
        roots: [{ ...roots[0], versionId: 'pinned' }],
      }),
    ).toMatchObject({ checked: 2, items: [{ id: 'ok' }] });
    expect(provider.resolveMods.mock.calls.map(([items]) => items[0]?.versionId)).toEqual([
      'blocked',
      'ok',
    ]);
  });

  it('reports a complete negative at the exact limit when the catalog is exhausted', async () => {
    const { provider } = fixture(releases(25));
    provider.resolveMods.mockResolvedValue(blocked);
    expect(await alternatives(provider)).toMatchObject({ checked: 25, items: [], limited: false });
  });

  it('retains completed attempts as a partial result on deadline, without hiding other failures', async () => {
    const { provider } = fixture(releases(30));
    const abort = new AbortController();
    provider.resolveMods.mockResolvedValueOnce(blocked).mockImplementationOnce(async () => {
      abort.abort();
      abort.signal.throwIfAborted();
      return accepted;
    });
    expect(await alternatives(provider, { signal: abort.signal })).toMatchObject({
      checked: 1,
      items: [],
      limited: true,
    });
    expect(provider.resolveMods).toHaveBeenCalledTimes(2);
    const failing = fixture(releases(2));
    failing.provider.resolveMods.mockRejectedValue(new Error('provider failure'));
    await expect(alternatives(failing.provider)).rejects.toThrow('provider failure');
  });
});
