import { defineTrustedFilemanExtension } from '@nickhosting/game-sdk/ui';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilemanHost, FilemanScope, FilemanSlot } from './host.js';

const slot = (name: 'listing' | 'viewer.content', text: string) =>
  createElement(FilemanSlot, { name }, text);
describe('Fileman shared presentation host', () => {
  it('mounts compiled game contributions, preserves the base view and scopes nested viewer overrides', () => {
    const extensions = [
      defineTrustedFilemanExtension<ReactNode>(
        { id: 'fixture-game:atlas', gameId: 'fixture-game' },
        [
          {
            slot: 'listing',
            mode: 'decorate',
            render: (_context, current) => createElement('main', null, current),
          },
          {
            slot: 'viewer.content',
            mode: 'replace',
            when: (context) => context.viewerId === 'fixture-game:custom',
            render: (context) => createElement('article', null, context.path),
          },
        ],
      ),
    ];
    const context = {
      serverId: 'fixture',
      gameId: 'fixture-game',
      path: '/',
      surface: 'directory' as const,
      readOnly: false,
    };
    const render = (gameId: string) =>
      renderToStaticMarkup(
        createElement(
          FilemanHost,
          { context: { ...context, gameId }, extensions },
          slot('listing', 'real folder'),
          createElement(
            FilemanScope,
            {
              context: {
                viewerId: 'fixture-game:custom',
                path: '/archive.zip',
                surface: 'viewer',
                readOnly: true,
              },
            },
            slot('viewer.content', 'builtin view'),
          ),
          slot('viewer.content', 'other view'),
        ),
      );
    expect(render('fixture-game')).toBe(
      '<main>real folder</main><article>/archive.zip</article>other view',
    );
    expect(render('other-game')).toBe('real folderbuiltin viewother view');
  });
  it('uses the normal presentation without a host and removes it only with an explicit scoped hide', () => {
    expect(renderToStaticMarkup(slot('listing', 'native'))).toBe('native');
    const extensions = [
      defineTrustedFilemanExtension<ReactNode>({ id: 'builtin:hidden' }, [
        { slot: 'listing', mode: 'hide', when: (c) => c.readOnly },
      ]),
    ];
    const render = (readOnly: boolean) =>
      renderToStaticMarkup(
        createElement(
          FilemanHost,
          { context: { serverId: 'fixture', path: '/', surface: 'viewer', readOnly }, extensions },
          slot('listing', 'native'),
        ),
      );
    expect(render(false)).toBe('native');
    expect(render(true)).toBe('');
  });
});
