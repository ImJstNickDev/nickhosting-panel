import {
  defineTrustedGameUiModule,
  type GameUiClient,
  type GameUiHandler,
  gameUiDescriptorSchema,
  type UiOption,
  type UiValues,
} from '@nickhosting/game-sdk/ui';
import { z } from 'zod';
import {
  openworldDashboardCatalogs,
  openworldDashboardHandlers,
  openworldDashboardSection,
} from '../dashboard-ui.js';
import { openworldSupportsRuntime, openworldVersionDelivery } from '../version-policy.js';
import { openworldGameArtwork, openworldRuntimeArtwork } from './artwork.js';
import { openworldTelemetryCatalogs } from './telemetry-catalog.js';

const catalogSchema = z.object({
  mappings: z.array(
    z.object({
      mappingId: z.uuid(),
      node: z.number().int(),
      delivery: z.object({ direct: z.boolean(), gateway: z.boolean() }),
    }),
  ),
  versions: z.array(z.string()),
});
const catalog = async (client: GameUiClient, signal?: AbortSignal) =>
  catalogSchema.parse(await client.request('/v1/games/openworld/choices', { signal }));
const runtimeArtwork = {
  assetId: openworldRuntimeArtwork.assetId,
  presentation: openworldRuntimeArtwork.presentation,
  tone: openworldRuntimeArtwork.tone,
};
function options(raw: unknown, handler: string, values: UiValues): UiOption[] {
  const { mappings, versions } = catalogSchema.parse(raw);
  if (handler === 'versions') {
    const mapping = mappings.find((m) => m.mappingId === values.mappingId);
    if (!mapping) return [];
    const recommended = versions.find((version) =>
      openworldVersionDelivery(version, mapping.delivery),
    );
    return versions.map((version) => {
      const available = Boolean(openworldVersionDelivery(version, mapping.delivery));
      return {
        value: version,
        label: version,
        latest: available && version === versions[0],
        recommended: version === recommended,
        disabled: !available,
        ...(!available && {
          reasonKey: openworldSupportsRuntime(version)
            ? 'games.openworld.requiresDirect'
            : 'games.openworld.incompatibleRuntime',
        }),
      };
    });
  }
  return mappings.map(({ mappingId, node, delivery }) => ({
    value: mappingId,
    ...(mappings.length === 1
      ? { labelKey: 'games.openworld.runtime' }
      : { label: `Openworld · #${node}` }),
    ...(openworldRuntimeArtwork.src ? { artwork: runtimeArtwork } : {}),
    recommended: mappings.length === 1,
    disabled: !versions.some((version) => openworldVersionDelivery(version, delivery)),
  }));
}
const choicesHandler =
  (handler: string): GameUiHandler =>
  async (client, ctx) =>
    options(await catalog(client, ctx.signal), handler, ctx.values);

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
          source: { handler: 'versions', dependsOn: ['mappingId'] },
        },
      ],
      pages: [
        {
          id: 'runtime',
          field: 'mappingId',
          resetFields: ['version'],
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
    administration: [
      { id: 'versions', titleKey: 'games.openworld.versions', component: 'openworld-versions' },
    ],
    sections: [
      ...(['overview', 'players', 'performance'] as const).map((id, order) => ({
        id,
        titleKey: `games.openworld.telemetry.${id}`,
        loader: 'telemetry',
        renderer: `openworld-${id}`,
        navigation: {
          group: 'tools',
          order: 10 * (order + 1),
          icon: id === 'players' ? 'users' : id === 'performance' ? 'activity' : 'layers',
          placement: 'sidebar',
        },
        requiredPermissions: [
          id === 'players' ? 'game.openworld.players.read' : 'game.openworld.performance.read',
        ],
        requiredCapabilities: id === 'players' ? ['players'] : [],
        columns: [],
        forms: [],
      })),
      openworldDashboardSection,
    ],
    ports: [
      { role: 'game', labelKey: 'games.openworld.gamePort', transports: ['udp'], required: true },
      {
        role: 'dashboard',
        labelKey: 'games.openworld.dashboard.title',
        transports: ['tcp'],
        required: true,
      },
    ],
    connectionModes: [{ mode: 'custom-subdomain' }],
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
      'games.openworld.versions': 'Versions',
      'games.openworld.catalogTitle': 'Dedicated server · Linux x64',
      'games.openworld.officialManifest': 'Official manifest',
      'games.openworld.name': 'Openworld',
      'games.openworld.runtime': 'Dedicated server',
      'games.openworld.version': 'Game version',
      'games.openworld.requiresDirect': 'Requires a direct connection on this node.',
      'games.openworld.incompatibleRuntime':
        'Requires glibc 2.38. The server uses Debian Bookworm.',
      ...openworldDashboardCatalogs.en,
      ...openworldTelemetryCatalogs.en,
      'games.openworld.permissions.viewPlayers': 'View online players',
      'games.openworld.permissions.inspect': 'Inspect player details',
      'games.openworld.permissions.inspectHelp':
        'Shows inventory, exact position and player statistics. Also requires access to the online players list.',
      'games.openworld.permissions.moderate': 'Moderate players',
      'games.openworld.permissions.moderateHelp':
        'Reserved for player actions. The current Players tab is read-only.',
      'games.openworld.permissions.viewPerformance': 'View overview and performance',
    },
    it: {
      'games.openworld.gamePort': 'Gioco',
      'games.openworld.versions': 'Versioni',
      'games.openworld.catalogTitle': 'Server dedicato · Linux x64',
      'games.openworld.officialManifest': 'Manifest ufficiale',
      'games.openworld.name': 'Openworld',
      'games.openworld.runtime': 'Server dedicato',
      'games.openworld.version': 'Versione del gioco',
      'games.openworld.requiresDirect': 'Richiede una connessione diretta su questo nodo.',
      'games.openworld.incompatibleRuntime': 'Richiede glibc 2.38. Il server usa Debian Bookworm.',
      ...openworldDashboardCatalogs.it,
      ...openworldTelemetryCatalogs.it,
      'games.openworld.permissions.viewPlayers': 'Visualizza i giocatori online',
      'games.openworld.permissions.inspect': 'Ispeziona i dettagli dei giocatori',
      'games.openworld.permissions.inspectHelp':
        'Mostra inventario, posizione esatta e statistiche. Richiede anche l’accesso all’elenco dei giocatori online.',
      'games.openworld.permissions.moderate': 'Modera i giocatori',
      'games.openworld.permissions.moderateHelp':
        'Riservato alle azioni sui giocatori. La scheda Giocatori attuale è di sola lettura.',
      'games.openworld.permissions.viewPerformance': 'Visualizza panoramica e prestazioni',
    },
  },
  handlers: {
    ...openworldDashboardHandlers,
    async telemetry() {
      return { values: {}, rows: [] };
    },
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
