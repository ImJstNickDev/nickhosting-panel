import { describe, expect, it, vi } from 'vitest';
import { createTrustedViewerRegistry, defineTrustedGameViewer } from './viewers.js';

describe('compiled first-party file viewers', () => {
  it('contributes a context-sensitive binary viewer without changing the shared engine', async () => {
    const load = vi.fn(async () => ({ renderFixture: true }));
    const descriptor = {
      id: 'fixture-game:data',
      gameId: 'fixture-game',
      labelKey: 'games.fixture-game.viewers.data',
      extensions: ['dat'],
      readOnly: true,
    };
    const registry = createTrustedViewerRegistry([defineTrustedGameViewer(descriptor, load)]);
    expect(registry.forGame('other-game')).toEqual([]);
    expect(registry.forGame(undefined)).toEqual([]);
    expect(registry.forGame('fixture-game')).toHaveLength(1);
    expect(registry.all()).toHaveLength(1);
    expect(registry.forFile('fixture-game', 'txt')).toEqual([]);
    expect(registry.forFile('other-game', 'dat')).toEqual([]);
    expect(registry.forFile('fixture-game', 'DAT')).toHaveLength(1);
    expect(load).not.toHaveBeenCalled();
    expect(await registry.get('fixture-game:data')?.load()).toEqual({ renderFixture: true });
    expect(load).toHaveBeenCalledOnce();
  });
  it('keeps compiled path suggestions separate from descriptors and executable availability', () => {
    const module = defineTrustedGameViewer(
      {
        id: 'fixture-game:archive-info',
        gameId: 'fixture-game',
        labelKey: 'games.fixture-game.viewers.archive',
        extensions: ['jar', 'jar.disabled'],
        readOnly: true,
      },
      async () => ({}),
      (source) => source.path.startsWith('mods/') && !source.entry && !source.archives?.length,
    );
    const registry = createTrustedViewerRegistry([module]);
    expect(module.matches?.({ path: 'mods/test.jar', name: 'test.jar', size: 10 })).toBe(true);
    expect(module.matches?.({ path: 'test.jar', name: 'test.jar', size: 10 })).toBe(false);
    // An explicit selection remains possible outside the suggestion path.
    expect(registry.forFile('fixture-game', 'jar')).toEqual([module]);
    expect(() =>
      defineTrustedGameViewer(module.descriptor as never, module.load, 'mods/*' as never),
    ).toThrow();
    expect(() =>
      createTrustedViewerRegistry([{ ...module, matches: 'mods/*' as never }]),
    ).toThrow();
    expect(() =>
      defineTrustedGameViewer({ ...module.descriptor, matches: 'mods/*' } as never, module.load),
    ).toThrow();
  });
  it('rejects duplicate modules, injected namespaces and API-shaped non-executable loaders', () => {
    const descriptor = {
      id: 'fixture-game:data',
      gameId: 'fixture-game',
      labelKey: 'games.fixture-game.viewers.data',
      extensions: ['dat'],
      readOnly: true,
    };
    const module = defineTrustedGameViewer(descriptor, async () => ({}));
    expect(() => createTrustedViewerRegistry([module, module])).toThrow();
    expect(() =>
      defineTrustedGameViewer({ ...descriptor, id: 'foreign:data' }, async () => ({})),
    ).toThrow();
    expect(() =>
      defineTrustedGameViewer(descriptor, 'https://example.invalid/code.js' as never),
    ).toThrow();
  });
});
