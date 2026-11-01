import { describe, expect, it } from 'vitest';
import {
  createFilemanExtensionHost,
  defineTrustedFilemanExtension,
  type FilemanContext,
} from './fileman.js';

const context: FilemanContext = {
  serverId: 'fixture',
  gameId: 'fixture-game',
  path: '/world',
  surface: 'directory',
  readOnly: false,
};
const join = (parts: readonly (string | null)[]) => parts.join('');
describe('Fileman extension host', () => {
  it('scopes game contributions and decorates existing presentation without replacing controllers', () => {
    const host = createFilemanExtensionHost([
      defineTrustedFilemanExtension<string>(
        { id: 'fixture-game:folder', gameId: 'fixture-game' },
        [],
      ),
    ]);
    expect(host.render('listing', context, 'native', join)).toBe('native');
  });
  it('adds and modifies named surfaces in deterministic order for directory and viewer sources', () => {
    const host = createFilemanExtensionHost([
      defineTrustedFilemanExtension<string>(
        { id: 'fixture-game:details', gameId: 'fixture-game' },
        [
          {
            slot: 'entry.name',
            mode: 'decorate',
            when: (c) => c.entry?.name.endsWith('.dat') === true,
            render: (_c, current) => `[${current}]`,
          },
          { slot: 'viewer.actions', mode: 'append', render: () => ' inspect' },
        ],
      ),
      defineTrustedFilemanExtension<string>({ id: 'builtin:prefix', priority: -10 }, [
        { slot: 'entry.name', mode: 'prepend', render: () => 'icon ' },
      ]),
    ]);
    const entry = { name: 'level.dat', directory: false, size: 100 };
    expect(host.render('entry.name', { ...context, entry }, 'level.dat', join)).toBe(
      '[icon level.dat]',
    );
    expect(
      host.render('entry.name', { ...context, gameId: 'other', entry }, 'level.dat', join),
    ).toBe('icon level.dat');
    expect(
      host.render(
        'viewer.actions',
        { ...context, surface: 'viewer', readOnly: true },
        'download',
        join,
      ),
    ).toBe('download inspect');
    expect(host.render('listing', context, 'native listing', join)).toBe('native listing');
  });
  it('replaces content, hides unsupported surfaces, and does not leak game patches after navigation', () => {
    const host = createFilemanExtensionHost([
      defineTrustedFilemanExtension<string>(
        { id: 'fixture-game:virtual', gameId: 'fixture-game' },
        [
          {
            slot: 'listing',
            mode: 'replace',
            when: (c) => c.surface === 'viewer',
            render: () => 'virtual folder',
          },
          { slot: 'viewer.actions', mode: 'hide', when: (c) => c.readOnly },
        ],
      ),
    ]);
    expect(host.render('listing', { ...context, surface: 'viewer' }, 'native', join)).toBe(
      'virtual folder',
    );
    expect(host.render('listing', context, 'native', join)).toBe('native');
    expect(
      host.render('listing', { ...context, gameId: 'other', surface: 'viewer' }, 'native', join),
    ).toBe('native');
    expect(
      host.render('viewer.actions', { ...context, readOnly: true }, 'action', join),
    ).toBeNull();
  });
  it('rejects invalid namespaces, non-executable API-shaped patches and ambiguous replacements', () => {
    expect(() =>
      defineTrustedFilemanExtension({ id: 'other:patch', gameId: 'fixture-game' }, []),
    ).toThrow();
    expect(() =>
      defineTrustedFilemanExtension({ id: 'builtin:patch' }, [
        { slot: 'listing', mode: 'replace', render: 'url' as never },
      ]),
    ).toThrow();
    const extension = defineTrustedFilemanExtension<string>({ id: 'builtin:replace' }, [
      { slot: 'listing', mode: 'replace', render: () => 'other' },
    ]);
    expect(() => createFilemanExtensionHost([extension, extension])).toThrow();
    const conflict = defineTrustedFilemanExtension<string>({ id: 'builtin:conflict' }, [
      { slot: 'listing', mode: 'hide' },
    ]);
    expect(() =>
      createFilemanExtensionHost([extension, conflict]).render('listing', context, 'native', join),
    ).toThrow('Conflicting');
  });
});
