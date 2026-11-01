import { defineTrustedGameUiModule, gameUiDescriptorSchema } from '@nickhosting/game-sdk/ui';
import { z } from 'zod';

const prefix = 'games.satisfactory.';
const translations: Record<string, [string, string]> = {
  name: ['Satisfactory', 'Satisfactory'],
  'mods.title': ['Mods', 'Mod'],
  'runtimes.dedicated': ['Dedicated server', 'Server dedicato'],
  'steps.configure': ['Configure server', 'Configura server'],
  'steps.resources': ['Resources', 'Risorse'],
  'steps.create': ['Create server', 'Crea server'],
  'fields.mapping': ['Server runtime', 'Runtime del server'],
  'fields.branch': ['Release channel', 'Canale di rilascio'],
  'fields.autoUpdate': ['Update on startup', 'Aggiorna all’avvio'],
  'branches.public': ['Stable', 'Stabile'],
  'branches.experimental': ['Experimental channel', 'Canale sperimentale'],
  'ports.game': ['Game and HTTPS', 'Gioco e HTTPS'],
  'ports.reliable': ['Reliable Messaging', 'Reliable Messaging'],
};
export const satisfactoryUiCatalogs = {
  en: Object.fromEntries(
    Object.entries(translations).map(([key, values]) => [prefix + key, values[0]]),
  ),
  it: Object.fromEntries(
    Object.entries(translations).map(([key, values]) => [prefix + key, values[1]]),
  ),
};
export const satisfactoryUiDescriptor = gameUiDescriptorSchema.parse({
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
    ],
    pages: [
      {
        id: 'runtime',
        titleKey: `${prefix}fields.mapping`,
        field: 'mappingId',
        kind: 'choice-list',
      },
      { id: 'branch', titleKey: `${prefix}fields.branch`, field: 'branch', kind: 'choice-list' },
    ],
    choicesHandler: 'choices',
    createHandler: 'create',
    defaults: { branch: 'public', autoUpdate: true },
  },
  sections: [
    {
      id: 'mods',
      titleKey: `${prefix}mods.title`,
      loader: 'mods',
      renderer: 'satisfactory-mods',
      navigation: { group: 'tools', order: 30, icon: 'layers', placement: 'sidebar' },
      requiredPermissions: ['server:read'],
      requiredCapabilities: ['mods'],
      columns: [],
      forms: [],
    },
  ],
  ports: [
    { role: 'game', labelKey: `${prefix}ports.game`, transports: ['tcp', 'udp'], required: true },
    { role: 'reliable', labelKey: `${prefix}ports.reliable`, transports: ['tcp'], required: true },
  ],
  connectionModes: [{ mode: 'static-host-port', showPort: true }],
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
});
export const satisfactoryUiModule = defineTrustedGameUiModule({
  descriptor: satisfactoryUiDescriptor,
  catalogs: satisfactoryUiCatalogs,
  handlers: {
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
      const { branch, autoUpdate, ...values } = creationSchema.parse(context.values);
      return client.request('/v1/servers', {
        method: 'POST',
        signal: context.signal,
        body: {
          ...values,
          idempotencyKey: z.string().min(1).parse(context.idempotencyKey),
          satisfactory: { branch, autoUpdate },
        },
      });
    },
  },
});
