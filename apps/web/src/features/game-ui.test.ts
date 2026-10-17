import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  defineTrustedGameUiModule,
  gameUiDescriptorSchema,
  type UiField,
  uiFieldSchema,
} from '@nickhosting/game-sdk/ui';
import { minecraftUiModule } from '@nickhosting/minecraft/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { gameUiWebMessages } from '../../../../packages/i18n/src/game-ui-web.js';
import { webMessages } from '../../../../packages/i18n/src/web.js';
import { FileIcon } from './file-icon.js';
import { GameFields, GameSections } from './game-sections.js';
import {
  gameUiRegistry,
  getGameAdminSections,
  getGameArtwork,
  getGameFileIcon,
} from './integrations.js';

function render(element: ReactElement, cache?: QueryClient) {
  const messages = Object.fromEntries(
    Object.entries({ ...webMessages, ...gameUiWebMessages }).map(([k, pair]) => [k, pair[0]]),
  );
  Object.assign(messages, minecraftUiModule.catalogs.en);
  const i18n = setupI18n({ locale: 'en', messages: { en: messages } });
  return renderToStaticMarkup(
    h(
      I18nProvider,
      { i18n },
      h(QueryClientProvider, { client: cache ?? new QueryClient() }, h(MemoryRouter, {}, element)),
    ),
  );
}
describe('trusted game frontend rendering', () => {
  it('uses decorative integration file icons with generic fallbacks, independently of editor support', () => {
    expect(getGameFileIcon('minecraft', '/server.PROPERTIES')).toMatch(/minecraft-properties.svg/);
    expect(getGameFileIcon('unknown-game', 'server.properties')).toBeUndefined();
    expect(getGameFileIcon('minecraft', 'properties')).toBeUndefined();
    expect(getGameFileIcon('minecraft', 'config.json')).toBeUndefined();
    const icon = (name: string, gameId?: string, folder = false) =>
      renderToStaticMarkup(h(FileIcon, { name, gameId, folder }));
    expect(icon('server.properties', 'minecraft')).toContain('alt=""');
    expect(icon('server.properties', 'minecraft')).toContain('fm-type-game');
    expect(icon('server.properties', 'unknown-game')).toContain('fm-type-config');
    expect(icon('config.json')).toContain('fm-type-json');
    expect(icon('server.jar')).toContain('fm-type-jar');
    expect(icon('json')).toContain('fm-type-text');
    expect(icon('server.properties', 'minecraft', true)).toContain('fm-type-folder');
    expect(icon('level.dat')).toContain('aria-hidden="true"');
  });
  it('resolves only first-party artwork/admin routes with an absent-game fallback', () => {
    expect(getGameArtwork('minecraft')).toMatch(/minecraft-landscape.svg/);
    expect(getGameArtwork('unknown-game')).toBeUndefined();
    expect(getGameAdminSections('unknown-game')).toEqual([]);
    expect(getGameAdminSections('minecraft').map((section) => section.id)).toEqual(['versions']);
    expect(gameUiRegistry.list().map((m) => m.descriptor.gameId)).toEqual(['minecraft']);
  });
  it('keeps creation runtime-first and renders a real archive picker for pack replacement', () => {
    const markup = render(
      h(GameFields, {
        module: minecraftUiModule,
        fields: minecraftUiModule.descriptor.creation.fields,
        values: minecraftUiModule.descriptor.creation.defaults,
        onChange: () => {},
      }),
    );
    expect(markup).toContain('Runtime');
    expect(markup).toContain('Version');
    expect(markup).not.toContain('type="file"');
    expect(markup).toContain('https://www.minecraft.net/en-us/eula');
    expect(markup).not.toContain('format="uuid"');
    const fields = minecraftUiModule.descriptor.sections
      .find((section) => section.id === 'content')
      ?.forms.find((form) => form.id === 'replace-pack')?.fields;
    expect(fields).toBeDefined();
    const replacement = render(
      h(GameFields, {
        module: minecraftUiModule,
        fields: fields ?? [],
        values: {},
        onChange: () => {},
      }),
    );
    expect(replacement).toContain('type="file"');
    expect(replacement).toContain('accept=".mrpack,.zip"');
    expect(replacement).not.toContain('format="uuid"');
  });
  it('renders false and missing property values without submitting guessed defaults', () => {
    const fields =
      minecraftUiModule.descriptor.sections.find((s) => s.id === 'properties')?.forms[0]?.fields ??
      [];
    const markup = render(
      h(GameFields, {
        module: minecraftUiModule,
        fields,
        values: { pvp: false, 'view-distance': 10 },
        onChange: () => {},
      }),
    );
    expect(markup).toContain('value="10"');
    expect(markup).not.toContain('checked=""');
  });
  it('renders alternate fixture fields without editing shared game screens', () => {
    const descriptor = gameUiDescriptorSchema.parse({
      gameId: 'fixture-arena',
      schemaVersion: 1,
      nameKey: 'games.fixture-arena.name',
      creation: {
        fields: [
          {
            id: 'mode',
            type: 'choice',
            labelKey: 'games.fixture-arena.mode',
            options: [{ value: 'team', label: 'Team' }],
          },
          {
            id: 'members',
            type: 'number',
            labelKey: 'games.fixture-arena.members',
            min: 2,
            max: 16,
            when: [{ field: 'mode', operator: 'equals', values: ['team'] }],
          },
        ],
        choicesHandler: 'choices',
        createHandler: 'create',
      },
      sections: [],
      ports: [
        {
          role: 'game',
          labelKey: 'games.fixture-arena.name',
          transports: ['tcp', 'udp'],
          required: true,
        },
        {
          role: 'query',
          labelKey: 'games.fixture-arena.name',
          transports: ['udp'],
          required: true,
        },
      ],
      connectionModes: [{ mode: 'static-host-port', showPort: true }],
    });
    const catalogs = {
      en: {
        'games.fixture-arena.name': 'Arena',
        'games.fixture-arena.mode': 'Mode',
        'games.fixture-arena.members': 'Members',
      },
      it: {
        'games.fixture-arena.name': 'Arena',
        'games.fixture-arena.mode': 'Modalità',
        'games.fixture-arena.members': 'Membri',
      },
    };
    const module = defineTrustedGameUiModule({
      descriptor,
      catalogs,
      handlers: { choices: async () => [], create: async () => ({}) },
    });
    const markup = render(
      h(GameFields, {
        module,
        fields: descriptor.creation.fields,
        values: { mode: 'team' },
        onChange: () => {},
      }),
    );
    expect(markup).toContain('type="number"');
    expect(markup).toContain('min="2"');
    expect(markup).toContain('max="16"');
  });
  it('shows authorization refusal before attempting manager-only section data', () => {
    const query = new QueryClient();
    query.setQueryData(['server', 'server-id'], {
      permissions: { read: true, manage: false, operate: false },
    });
    const markup = render(
      h(GameSections, { serverId: 'server-id', sectionId: 'worlds', gameId: 'minecraft' }),
      query,
    );
    expect(markup).toContain('You do not have permission');
    expect(markup).not.toContain('type="file"');
  });
  it('makes destructive previews a read-only list and keeps empty preview distinct from missing', () => {
    const field: UiField = uiFieldSchema.parse({
      id: 'paths',
      type: 'preview',
      handler: 'wipe-preview',
      labelKey: 'games.minecraft.fields.expectedDeletePaths',
      maxItems: 100,
      required: true,
    });
    const markup = render(
      h(GameFields, {
        module: minecraftUiModule,
        fields: [field],
        values: { paths: ['world'] },
        onChange: () => {},
      }),
    );
    expect(markup).toContain('<code>world</code>');
    expect(markup).not.toContain('<textarea');
  });
});
