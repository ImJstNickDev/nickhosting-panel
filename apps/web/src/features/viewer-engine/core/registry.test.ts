import { describe, expect, it, vi } from 'vitest';
import { canUseDocumentView, documentViews } from './document-registry.js';
import {
  availableViewers,
  preferredViewer,
  selectableViewers,
  type ViewerSource,
  viewerExtension,
} from './registry.js';

vi.mock('../trusted-viewers.js', async () => {
  const { createTrustedViewerRegistry, defineTrustedGameViewer } = await import(
    '@nickhosting/game-sdk/ui'
  );
  return {
    gameViewerRegistry: createTrustedViewerRegistry([
      defineTrustedGameViewer(
        {
          id: 'fixture-game:mod-info',
          gameId: 'fixture-game',
          labelKey: 'games.fixture-game.viewers.mod',
          extensions: ['jar', 'jar.disabled', 'jar.pending'],
          readOnly: true,
        },
        async () => ({}),
        (source) => source.path.startsWith('mods/') && !source.entry && !source.archives?.length,
      ),
    ]),
  };
});

const file = (name: string, size = 100): ViewerSource => ({ name, path: `world/${name}`, size });
describe('trusted viewer selection', () => {
  it('prioritizes integration suggestions only in their game and path, retaining explicit choices', () => {
    const mod = { ...file('test.jar'), path: 'mods/test.jar', gameId: 'fixture-game' };
    expect(availableViewers(mod).map((viewer) => viewer.id)).toEqual([
      'fixture-game:mod-info',
      'archive',
    ]);
    expect(preferredViewer(mod)).toBe('fixture-game:mod-info');
    expect(preferredViewer({ ...mod, gameId: undefined })).toBe('archive');
    expect(preferredViewer({ ...mod, gameId: 'other-game' })).toBe('archive');
    expect(preferredViewer({ ...mod, path: 'server.jar' })).toBe('archive');
    expect(preferredViewer({ ...mod, path: 'pack.zip', entry: 'mods/test.jar' })).toBe('archive');
    expect(preferredViewer({ ...mod, archives: ['nested.jar'] })).toBe('archive');
    expect(preferredViewer(mod, [{ scope: 'server', extension: 'jar', viewerId: 'archive' }])).toBe(
      'archive',
    );
    const elsewhere = { ...mod, path: 'downloads/test.jar' };
    expect(selectableViewers(elsewhere).map((viewer) => viewer.id)).toContain(
      'fixture-game:mod-info',
    );
    expect(
      preferredViewer(elsewhere, [
        { scope: 'game', extension: 'jar', viewerId: 'fixture-game:mod-info' },
      ]),
    ).toBe('fixture-game:mod-info');
  });
  it('recognizes contributed compound suffixes without hardcoded game formats', () => {
    expect(viewerExtension('test.JAR.DISABLED', 'fixture-game')).toBe('jar.disabled');
    expect(viewerExtension('test.jar.pending', 'fixture-game')).toBe('jar.pending');
    expect(viewerExtension('test.JAR.DISABLED', 'other-game')).toBe('disabled');
    expect(viewerExtension('test.jar.pending')).toBe('pending');
    expect(
      preferredViewer({
        path: 'mods/test.jar.disabled',
        name: 'test.jar.disabled',
        size: 10,
        gameId: 'fixture-game',
      }),
    ).toBe('fixture-game:mod-info');
    expect(viewerExtension('test.disabled')).toBe('disabled');
    expect(
      preferredViewer(
        {
          path: 'mods/test.jar.disabled',
          name: 'test.jar.disabled',
          size: 10,
          gameId: 'other-game',
        },
        [{ scope: 'global', extension: 'disabled', viewerId: 'archive' }],
      ),
    ).toBe('archive');
  });
  it('uses Quill and Scribe for bounded Markdown documents and archive members', () => {
    for (const name of ['README.md', 'notes.markdown', 'notes.mdown', 'notes.mkd']) {
      expect(preferredViewer(file(name))).toBe('markdown');
      expect(availableViewers(file(name)).map((view) => view.id)).toEqual(['markdown', 'text']);
      expect(canUseDocumentView(file(name), 'markdown')).toBe(true);
      expect(availableViewers(file(name, 2 * 1024 * 1024))).toEqual([]);
      expect(preferredViewer({ ...file(name), entry: `docs/${name}` })).toBe('markdown');
    }
  });
  it('shares editable JSON documents without reducing the standalone JSON budget', () => {
    for (const name of ['data.json', 'data.jsonc', 'data.json5']) {
      expect(documentViews(name).map((view) => view.id)).toEqual(['json']);
      expect(canUseDocumentView(file(name), 'json')).toBe(true);
      expect(canUseDocumentView(file(name), 'text')).toBe(true);
      expect(availableViewers(file(name)).map((view) => view.id)).toEqual(['json', 'text']);
      expect(canUseDocumentView(file(name, 2 * 1024 * 1024), 'json')).toBe(false);
      expect(availableViewers(file(name, 2 * 1024 * 1024)).map((view) => view.id)).toEqual([
        'json',
      ]);
    }
    expect(canUseDocumentView(file('server.jar'), 'text')).toBe(false);
  });
  it('uses compound extensions and never chooses text for binary files', () => {
    expect(viewerExtension('backup.TAR.ZST')).toBe('tar.zst');
    expect(preferredViewer(file('world.tar.xz'))).toBe('archive');
    expect(availableViewers(file('icon.ico')).map((item) => item.id)).toEqual(['image']);
    expect(preferredViewer(file('server.jar'))).toBe('archive');
    expect(preferredViewer(file('state.dat'))).toBeUndefined();
    expect(preferredViewer(file('world.gz'))).toBe('archive');
    expect(preferredViewer(file('report.PDF', 10 * 1024 * 1024))).toBe('pdf');
    expect(preferredViewer({ ...file('report.pdf'), entry: 'reports/report.pdf' })).toBe('pdf');
  });
  it('honors scoped personal choices even when the extension does not suggest that viewer', () => {
    const preferences = [
      { scope: 'global', extension: 'json', viewerId: 'json' },
      { scope: 'game', extension: 'json', viewerId: 'text' },
      { scope: 'server', extension: 'json', viewerId: 'json' },
    ] as const;
    expect(preferredViewer(file('config.json'), preferences)).toBe('json');
    expect(preferredViewer(file('config.json'), preferences.slice(0, 2))).toBe('text');
    expect(
      preferredViewer(file('config.json'), [
        { scope: 'server', extension: 'json', viewerId: 'image' },
      ]),
    ).toBe('image');
    expect(
      preferredViewer(file('unusual.dat'), [
        { scope: 'server', extension: 'dat', viewerId: 'json' },
      ]),
    ).toBe('json');
    expect(
      preferredViewer(file('config.json'), [
        { scope: 'server', extension: 'json', viewerId: 'foreign:unknown' },
      ]),
    ).toBe('json');
  });
  it('retains the editor memory bound and allows nested archives but excludes nested database readers', () => {
    expect(availableViewers(file('huge.json', 2 * 1024 * 1024)).map((item) => item.id)).toEqual([
      'json',
    ]);
    expect(preferredViewer({ ...file('nested.zip'), entry: 'a/nested.zip' })).toBe('archive');
    const nested = { ...file('config.json'), entry: 'a/config.json' };
    expect(preferredViewer(nested)).toBe('json');
    expect(selectableViewers(nested).map((item) => item.id)).toContain('archive');
    expect(selectableViewers(nested).map((item) => item.id)).not.toContain('sqlite');
    expect(
      preferredViewer(nested, [{ scope: 'server', extension: 'json', viewerId: 'archive' }]),
    ).toBe('archive');
    expect(
      selectableViewers({ ...file('nested.zip'), archives: ['nested.zip'] }).map((item) => item.id),
    ).not.toContain('sqlite');
    expect(selectableViewers(file('unknown.dat')).map((item) => item.id)).toEqual([
      'image',
      'audio',
      'video',
      'archive',
      'sqlite',
      'json',
      'pdf',
      'markdown',
      'text',
    ]);
  });
  it('offers shared CSV/TSV views within editor bounds, including read-only archive entries', () => {
    for (const name of ['users.csv', 'users.tsv']) {
      expect(preferredViewer(file(name))).toBe('sqlite');
      expect(availableViewers(file(name)).map((item) => item.id)).toEqual(['sqlite', 'text']);
      expect(preferredViewer({ ...file(name), entry: name })).toBe('sqlite');
      expect(availableViewers(file(name, 2 * 1024 * 1024))).toEqual([]);
    }
  });
});
