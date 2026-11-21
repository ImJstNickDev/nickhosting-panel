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
import { openworldFactoriesCatalogs } from './factories-catalog.js';
import { openworldMapCatalogs } from './map-catalog.js';
import { openworldMapLayerCatalogs } from './map-layers-catalog.js';
import { openworldRulesCatalogs } from './rules-catalog.js';
import { openworldSeedCatalogs } from './seed-catalog.js';
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
      {
        id: 'map',
        titleKey: 'games.openworld.map.title',
        loader: 'telemetry',
        renderer: 'openworld-map',
        navigation: { group: 'tools', order: 25, icon: 'world', placement: 'sidebar' },
        requiredPermissions: ['game.openworld.map.read'],
        requiredCapabilities: [],
        columns: [],
        forms: [],
      },
      {
        id: 'factories',
        titleKey: 'games.openworld.factories.title',
        loader: 'telemetry',
        renderer: 'openworld-factories',
        navigation: { group: 'tools', order: 35, icon: 'network', placement: 'sidebar' },
        requiredPermissions: ['game.openworld.performance.read'],
        requiredCapabilities: [],
        columns: [],
        forms: [],
      },
      {
        id: 'rules',
        titleKey: 'games.openworld.rules.title',
        loader: 'telemetry',
        renderer: 'openworld-rules',
        navigation: { group: 'tools', order: 40, icon: 'settings', placement: 'sidebar' },
        requiredPermissions: ['game.openworld.rules.view'],
        requiredCapabilities: [],
        columns: [],
        forms: [],
      },
      {
        id: 'seed',
        titleKey: 'games.openworld.seed.title',
        loader: 'telemetry',
        renderer: 'openworld-seed',
        navigation: { group: 'tools', order: 45, icon: 'world', placement: 'sidebar' },
        requiredPermissions: ['game.openworld.seed.inspect'],
        requiredCapabilities: [],
        columns: [],
        forms: [],
      },
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
      ...openworldMapCatalogs.en,
      ...openworldFactoriesCatalogs.en,
      ...openworldRulesCatalogs.en,
      ...openworldSeedCatalogs.en,
      'games.openworld.permissions.viewRules': 'View server rules',
      'games.openworld.permissions.viewRulesHelp':
        'View game roles, protected zones, planetary borders, difficulty and bans.',
      'games.openworld.permissions.manageRules': 'Change difficulty',
      'games.openworld.permissions.manageRulesHelp':
        'Change the game difficulty. Requires access to server rules.',
      'games.openworld.permissions.manageBans': 'Manage persistent bans',
      'games.openworld.permissions.manageBansHelp':
        'Lift account bans by UUID. Requires access to server rules.',
      'games.openworld.permissions.inspectSeed': 'Inspect the world seed',
      'games.openworld.permissions.inspectSeedHelp':
        'View the seed and locate resources in unexplored terrain.',
      ...openworldMapLayerCatalogs.en,
      'games.openworld.permissions.viewPlayers': 'View players',
      'games.openworld.permissions.inspect': 'Inspect player details',
      'games.openworld.permissions.inspectHelp':
        'View saved players, inventory, exact position and individual statistics. Requires access to the player list.',
      'games.openworld.permissions.moderate': 'Moderate players',
      'games.openworld.permissions.moderateHelp':
        'Send messages, disconnect, teleport, change game mode, kill or respawn a connected player. Requires access to the player list.',
      'games.openworld.permissions.screenshots': 'Request and view game screenshots',
      'games.openworld.permissions.screenshotsHelp':
        'Request a capture from a connected player and view the shared gallery for this server. Requires access to the player list.',
      'games.openworld.permissions.viewPerformance': 'View overview, performance and factories',
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
      ...openworldMapCatalogs.it,
      ...openworldFactoriesCatalogs.it,
      ...openworldRulesCatalogs.it,
      ...openworldSeedCatalogs.it,
      'games.openworld.permissions.viewRules': 'Consulta le regole del server',
      'games.openworld.permissions.viewRulesHelp':
        'Mostra ruoli di gioco, zone protette, confini planetari, difficoltà e ban.',
      'games.openworld.permissions.manageRules': 'Modifica la difficoltà',
      'games.openworld.permissions.manageRulesHelp':
        'Modifica la difficoltà del gioco. Richiede l’accesso alle regole del server.',
      'games.openworld.permissions.manageBans': 'Gestisci i ban persistenti',
      'games.openworld.permissions.manageBansHelp':
        'Revoca i ban degli account per UUID. Richiede l’accesso alle regole del server.',
      'games.openworld.permissions.inspectSeed': 'Ispeziona il seed del mondo',
      'games.openworld.permissions.inspectSeedHelp':
        'Mostra il seed e permette di localizzare risorse nel terreno inesplorato.',
      ...openworldMapLayerCatalogs.it,
      'games.openworld.permissions.viewPlayers': 'Visualizza i giocatori',
      'games.openworld.permissions.inspect': 'Ispeziona i dettagli dei giocatori',
      'games.openworld.permissions.inspectHelp':
        'Mostra giocatori salvati, inventario, posizione esatta e statistiche individuali. Richiede l’accesso all’elenco dei giocatori.',
      'games.openworld.permissions.moderate': 'Modera i giocatori',
      'games.openworld.permissions.moderateHelp':
        'Invia messaggi, disconnetti, teletrasporta, cambia modalità, uccidi o fai rinascere un giocatore connesso. Richiede l’accesso all’elenco dei giocatori.',
      'games.openworld.permissions.screenshots': 'Richiedi e visualizza screenshot di gioco',
      'games.openworld.permissions.screenshotsHelp':
        'Richiedi una cattura a un giocatore connesso e consulta la galleria condivisa del server. Richiede l’accesso all’elenco dei giocatori.',
      'games.openworld.permissions.viewPerformance':
        'Visualizza panoramica, prestazioni e fabbriche',
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
