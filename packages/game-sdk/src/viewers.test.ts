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
    expect(registry.forFile('other-game', 'dat')).toEqual([]);
    expect(registry.forFile('fixture-game', 'DAT')).toHaveLength(1);
    expect(load).not.toHaveBeenCalled();
    expect(await registry.get('fixture-game:data')?.load()).toEqual({ renderFixture: true });
    expect(load).toHaveBeenCalledOnce();
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
