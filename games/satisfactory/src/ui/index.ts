export { satisfactoryPhaseLabel, satisfactorySchematicLabel } from './progression.js';

import { satisfactoryProgressionCatalogs } from './progression-catalog.js';

export { satisfactorySaveDirectory } from '../world-paths.js';

import { defineTrustedGameUiModule, gameUiDescriptorSchema } from '@nickhosting/game-sdk/ui';
import { z } from 'zod';
import { satisfactoryOverviewCatalogs } from './overview-catalog.js';
import { satisfactorySettingsCatalogs } from './settings-catalog.js';

const prefix = 'games.satisfactory.';
const translations: Record<string, [string, string]> = {
  'installation.title': ['Installation', 'Installazione'],
  'api.title': ['FICSIT Settings', 'Impostazioni FICSIT'],
  'api.token': ['Application token', 'Token applicazione'],
  'api.tokenHelp': [
    'In the game Server Manager console, run server.GenerateAPIToken and enter the result here. The token is verified against the running server and stored encrypted.',
    'Nella console del Server Manager del gioco esegui server.GenerateAPIToken e inserisci qui il risultato. Il token viene verificato sul server acceso e conservato cifrato.',
  ],
  'api.configured': ['API credentials saved.', 'Credenziali API salvate.'],
  'api.connected': ['Server API connected.', 'API del server collegata.'],
  'api.unconfigured': [
    'Connect the server API to manage settings and read player counts.',
    'Collega l’API del server per gestire le impostazioni e leggere il numero di giocatori.',
  ],
  'api.startFirst': [
    'Start the server to connect its API or edit settings.',
    'Avvia il server per collegare l’API o modificare le impostazioni.',
  ],
  'api.saved': ['Changes saved.', 'Modifiche salvate.'],
  'api.session': ['Session', 'Sessione'],
  'api.players': ['Connected players', 'Giocatori connessi'],
  'api.tickRate': ['Average tick rate', 'Tick rate medio'],
  'api.options': ['Server options', 'Opzioni server'],
  'api.pending': ['Pending value', 'Valore in attesa'],

  name: ['Satisfactory', 'Satisfactory'],
  'worlds.title': ['Worlds', 'Mondi'],
  'mods.title': ['Mods', 'Mod'],
  'runtimes.dedicated': ['Dedicated server', 'Server dedicato'],
  'steps.configure': ['Configure server', 'Configura server'],
  'steps.resources': ['Resources', 'Risorse'],
  'steps.create': ['Create server', 'Crea server'],
  'fields.mapping': ['Server runtime', 'Runtime del server'],
  'fields.branch': ['Release channel', 'Canale di rilascio'],
  'fields.autoUpdate': ['Update on startup', 'Aggiorna all’avvio'],
  'setup.title': ['Set up your server', 'Configura il server'],
  'setup.client': ['Set up in Satisfactory', 'Configura da Satisfactory'],
  'setup.panel': ['Set up here', 'Configura qui'],
  'setup.credentials': ['Server access', 'Accesso al server'],
  'setup.adminPassword': ['Administrator password', 'Password amministratore'],
  'setup.clientPassword': ['Player password (optional)', 'Password giocatori (facoltativa)'],
  'setup.clientPasswordHelp': [
    'Leave empty to let players join without a password.',
    'Lascia vuoto per consentire ai giocatori di entrare senza password.',
  ],
  'branches.public': ['Stable', 'Stabile'],
  'branches.experimental': ['Experimental channel', 'Canale sperimentale'],
  'ports.game': ['Game and HTTPS', 'Gioco e HTTPS'],
  'ports.reliable': ['Reliable Messaging', 'Reliable Messaging'],
};
const baseCatalogs = {
  en: Object.fromEntries(
    Object.entries(translations).map(([key, values]) => [prefix + key, values[0]]),
  ),
  it: Object.fromEntries(
    Object.entries(translations).map(([key, values]) => [prefix + key, values[1]]),
  ),
};
export const satisfactoryUiCatalogs = {
  en: {
    ...baseCatalogs.en,
    ...satisfactoryOverviewCatalogs.en,
    ...satisfactoryProgressionCatalogs.en,
    ...satisfactorySettingsCatalogs.en,
  },
  it: {
    ...baseCatalogs.it,
    ...satisfactoryOverviewCatalogs.it,
    ...satisfactoryProgressionCatalogs.it,
    ...satisfactorySettingsCatalogs.it,
  },
};
export const satisfactoryUiDescriptor = gameUiDescriptorSchema.parse({
  administration: [
    {
      id: 'installation',
      titleKey: 'games.satisfactory.installation.title',
      component: 'satisfactory-installation',
    },
  ],
  gameId: 'satisfactory',
  schemaVersion: 1,
  nameKey: `${prefix}name`,
  creation: {
    fields: [
      {
        id: 'mappingId',
        labelKey: `${prefix}fields.mapping`,
        type: 'choice',
        required: true,
        source: { handler: 'choices' },
      },
      {
        id: 'branch',
        labelKey: `${prefix}fields.branch`,
        type: 'choice',
        required: true,
        options: [
          { value: 'public', labelKey: `${prefix}branches.public` },
          { value: 'experimental', labelKey: `${prefix}branches.experimental` },
        ],
      },
      { id: 'autoUpdate', labelKey: `${prefix}fields.autoUpdate`, type: 'boolean' },
      {
        id: 'setupMode',
        labelKey: `${prefix}setup.title`,
        type: 'choice',
        required: true,
        options: [
          { value: 'client', labelKey: `${prefix}setup.client` },
          { value: 'panel', labelKey: `${prefix}setup.panel` },
        ],
      },
      {
        id: 'adminPassword',
        labelKey: `${prefix}setup.adminPassword`,
        type: 'text',
        secret: true,
        minLength: 1,
        maxLength: 128,
        required: true,
        when: [{ field: 'setupMode', operator: 'equals', values: ['panel'] }],
      },
      {
        id: 'clientPassword',
        labelKey: `${prefix}setup.clientPassword`,
        type: 'text',
        helpKey: `${prefix}setup.clientPasswordHelp`,
        secret: true,
        maxLength: 128,
        differentFrom: 'adminPassword',
        when: [{ field: 'setupMode', operator: 'equals', values: ['panel'] }],
      },
    ],
    pages: [
      {
        id: 'runtime',
        titleKey: `${prefix}fields.mapping`,
        field: 'mappingId',
        kind: 'choice-list',
      },
      { id: 'branch', titleKey: `${prefix}fields.branch`, field: 'branch', kind: 'choice-list' },
      {
        id: 'setup',
        titleKey: `${prefix}setup.title`,
        field: 'setupMode',
        kind: 'choice-list',
        resetFields: ['adminPassword', 'clientPassword'],
      },
      {
        id: 'credentials',
        titleKey: `${prefix}setup.credentials`,
        field: 'adminPassword',
        kind: 'form',
        fields: ['adminPassword', 'clientPassword'],
      },
    ],
    choicesHandler: 'choices',
    createHandler: 'create',
    defaults: { branch: 'public', autoUpdate: true, setupMode: 'client' },
  },
  sections: [
    {
      id: 'overview',
      titleKey: `${prefix}overview.title`,
      loader: 'overview',
      renderer: 'satisfactory-overview',
      navigation: { group: 'tools', order: 10, icon: 'activity', placement: 'sidebar' },
      requiredPermissions: ['server:read'],
      managePermissions: ['server:manage'],
      requiredCapabilities: [],
      columns: [],
      forms: [],
    },
    {
      id: 'worlds',
      titleKey: `${prefix}worlds.title`,
      loader: 'worlds',
      renderer: 'satisfactory-worlds',
      navigation: { group: 'tools', order: 20, icon: 'world', placement: 'sidebar' },
      requiredPermissions: ['server:read'],
      managePermissions: ['server:manage'],
      requiredCapabilities: ['worlds'],
      columns: [],
      forms: [],
    },
    {
      id: 'server-settings',
      titleKey: `${prefix}api.title`,
      loader: 'server-settings',
      renderer: 'satisfactory-settings',
      navigation: { group: 'config', order: 40, icon: 'settings', placement: 'sidebar' },
      requiredPermissions: ['server:read'],
      managePermissions: ['server:manage'],
      requiredCapabilities: ['files'],
      columns: [],
      forms: [],
    },
    {
      id: 'mods',
      titleKey: `${prefix}mods.title`,
      loader: 'mods',
      renderer: 'satisfactory-mods',
      navigation: { group: 'tools', order: 30, icon: 'layers', placement: 'sidebar' },
      requiredPermissions: ['server:read'],
      managePermissions: ['server:manage'],
      requiredCapabilities: ['mods'],
      columns: [],
      forms: [],
    },
  ],
  ports: [
    { role: 'game', labelKey: `${prefix}ports.game`, transports: ['tcp', 'udp'], required: true },
    { role: 'reliable', labelKey: `${prefix}ports.reliable`, transports: ['tcp'], required: true },
  ],
  connectionModes: [{ mode: 'shared-host', showPort: true }],
});
const creationSchema = z.object({
  mappingId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  projectId: z.uuid().optional(),
  limits: z.object({
    memory: z.number().int().min(32),
    cpu: z.number().int().positive(),
    disk: z.number().int().positive().optional(),
    swap: z.literal(0).default(0),
    io: z.number().int().min(10).max(1000).default(500),
  }),
  connection: z
    .object({
      reservationId: z.uuid().optional(),
      domainId: z.string().optional(),
      subdomain: z.string().optional(),
    })
    .optional(),
  autoStart: z.boolean().default(true),
  branch: z.enum(['public', 'experimental']).default('public'),
  autoUpdate: z.boolean().default(true),
  setupMode: z.enum(['client', 'panel']).default('client'),
  adminPassword: z.unknown().optional(),
  clientPassword: z.unknown().optional(),
});
const setupSchema = z
  .object({
    adminPassword: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !value.includes('\0')),
    clientPassword: z
      .string()
      .max(128)
      .refine((value) => !value.includes('\0'))
      .optional(),
  })
  .refine((value) => !value.clientPassword || value.clientPassword !== value.adminPassword);
export const satisfactoryUiModule = defineTrustedGameUiModule({
  descriptor: satisfactoryUiDescriptor,
  catalogs: satisfactoryUiCatalogs,
  handlers: {
    async overview() {
      return { values: {}, rows: [] };
    },
    async worlds() {
      return { values: {}, rows: [] };
    },
    async 'server-settings'() {
      return { values: {}, rows: [] };
    },
    async mods(client, context) {
      await client.request(`/v1/servers/${z.uuid().parse(context.serverId)}/satisfactory/mods`, {
        signal: context.signal,
      });
      return { values: {}, rows: [] };
    },
    async choices(client, context) {
      const response = z
        .object({ choices: z.array(z.object({ mappingId: z.uuid(), name: z.string() })) })
        .parse(await client.request('/v1/games/satisfactory/choices', { signal: context.signal }));
      return response.choices.map((choice) => ({
        value: choice.mappingId,
        label: choice.name,
        disabled: false,
      }));
    },
    async create(client, context) {
      const { branch, autoUpdate, setupMode, adminPassword, clientPassword, ...values } =
        creationSchema.parse(context.values);
      const setup =
        setupMode === 'panel'
          ? setupSchema.parse({ adminPassword, ...(clientPassword ? { clientPassword } : {}) })
          : undefined;
      return client.request('/v1/servers', {
        method: 'POST',
        signal: context.signal,
        body: {
          ...values,
          idempotencyKey: z.string().min(1).parse(context.idempotencyKey),
          satisfactory: { branch, autoUpdate, ...(setup ? { setup } : {}) },
        },
      });
    },
  },
});
