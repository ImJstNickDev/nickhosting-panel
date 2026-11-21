import {
  defineTrustedGameUiModule,
  type GameUiClient,
  type GameUiHandler,
  gameUiDescriptorSchema,
  type UiOption,
} from '@nickhosting/game-sdk/ui';
import { z } from 'zod';
import {
  openworldDashboardCatalogs,
  openworldDashboardHandlers,
  openworldDashboardSection,
} from '../dashboard-ui.js';
import { openworldGameArtwork, openworldRuntimeArtwork } from './artwork.js';

const catalogSchema = z.object({
  mappings: z.array(z.object({ mappingId: z.uuid(), node: z.number().int() })),
  versions: z.array(z.string()),
});
const catalog = async (client: GameUiClient, signal?: AbortSignal) =>
  catalogSchema.parse(await client.request('/v1/games/openworld/choices', { signal }));
const runtimeArtwork = {
  assetId: openworldRuntimeArtwork.assetId,
  presentation: openworldRuntimeArtwork.presentation,
  tone: openworldRuntimeArtwork.tone,
};
function options(raw: unknown, handler: string): UiOption[] {
  const { mappings, versions } = catalogSchema.parse(raw);
  if (handler === 'versions')
    return versions.map((version, index) => ({
      value: version,
      label: version,
      latest: index === 0,
      disabled: false,
    }));
  return mappings.map(({ mappingId, node }) => ({
    value: mappingId,
    ...(mappings.length === 1
      ? { labelKey: 'games.openworld.runtime' }
      : { label: `Openworld · #${node}` }),
    ...(openworldRuntimeArtwork.src ? { artwork: runtimeArtwork } : {}),
    recommended: mappings.length === 1,
    disabled: false,
  }));
}
const choicesHandler =
  (handler: string): GameUiHandler =>
  async (client, ctx) =>
    options(await catalog(client, ctx.signal), handler);

export const openworldUiModule = defineTrustedGameUiModule({
  descriptor: gameUiDescriptorSchema.parse({
    schemaVersion: 1,
    gameId: 'openworld',
    nameKey: 'games.openworld.name',
    ...(openworldGameArtwork.src ? { artwork: { assetId: openworldGameArtwork.assetId } } : {}),
    creation: {
      fields: [
        {
          id: 'mappingId',
          type: 'choice',
          labelKey: 'games.openworld.runtime',
          required: true,
          source: { handler: 'mappings' },
        },
        {
          id: 'version',
          type: 'choice',
          labelKey: 'games.openworld.version',
          required: true,
          source: { handler: 'versions' },
        },
      ],
      pages: [
        {
          id: 'runtime',
          field: 'mappingId',
          kind: 'choice-list',
          titleKey: 'games.openworld.runtime',
        },
        {
          id: 'version',
          field: 'version',
          kind: 'version-list',
          titleKey: 'games.openworld.version',
        },
      ],
      choicesHandler: 'mappings',
      createHandler: 'create',
      defaults: {},
    },
    sections: [openworldDashboardSection],
    ports: [
      { role: 'game', labelKey: 'games.openworld.gamePort', transports: ['udp'], required: true },
      {
        role: 'dashboard',
        labelKey: 'games.openworld.dashboard.title',
        transports: ['tcp'],
        required: true,
      },
    ],
    connectionModes: [{ mode: 'shared-host', showPort: true }],
  }),
  assets: {
    ...(openworldGameArtwork.src
      ? { [openworldGameArtwork.assetId]: openworldGameArtwork.src }
      : {}),
    ...(openworldRuntimeArtwork.src
      ? { [openworldRuntimeArtwork.assetId]: openworldRuntimeArtwork.src }
      : {}),
  },
  runtimeArtwork: (runtime) =>
    runtime === 'dedicated' && openworldRuntimeArtwork.src ? runtimeArtwork : undefined,
  creationCatalog: { handlers: ['mappings', 'versions'], load: catalog, options },
  catalogs: {
    en: {
      'games.openworld.gamePort': 'Game',
      'games.openworld.name': 'Openworld',
      'games.openworld.runtime': 'Dedicated server',
      'games.openworld.version': 'Game version',
      ...openworldDashboardCatalogs.en,
    },
    it: {
      'games.openworld.gamePort': 'Gioco',
      'games.openworld.name': 'Openworld',
      'games.openworld.runtime': 'Server dedicato',
      'games.openworld.version': 'Versione del gioco',
      ...openworldDashboardCatalogs.it,
    },
  },
  handlers: {
    ...openworldDashboardHandlers,
    mappings: choicesHandler('mappings'),
    versions: choicesHandler('versions'),
    async create(client, { values, signal, idempotencyKey }) {
      const { mappingId, name, limits, autoStart, projectId, connection, version } = values;
      return client.request('/v1/servers', {
        method: 'POST',
        signal,
        body: {
          mappingId,
          name,
          limits,
          autoStart,
          projectId,
          connection,
          idempotencyKey,
          game: { id: 'openworld', configuration: { version } },
        },
      });
    },
  },
});
