import {
  defineTrustedGameUiModule,
  type GameUiClient,
  type GameUiContext,
  gameUiDescriptorSchema,
  type UiField,
  type UiSectionData,
} from '@nickhosting/game-sdk/ui';
import { z } from 'zod';
import {
  createMinecraftUiController,
  MinecraftUiError,
  minecraftContentCapabilities,
} from './controller.js';

export * from './controller.js';

const namespace = 'games.minecraft-java';
const k = (name: string) => `${namespace}.${name}`;
const translated: Record<string, [string, string]> = {
  name: ['Minecraft Java', 'Minecraft Java'],
  'installer.runtime': ['Choose a runtime', 'Scegli un runtime'],
  'fields.runtime': ['Runtime', 'Runtime'],
  'runtimes.vanilla': ['Vanilla', 'Vanilla'],
  'runtimes.paper': ['Paper', 'Paper'],
  'runtimes.folia': ['Folia', 'Folia'],
  'runtimes.fabric': ['Fabric', 'Fabric'],
  'runtimes.forge': ['Forge', 'Forge'],
  'installer.version': ['Choose a version', 'Scegli una versione'],
  'installer.operators': ['Who should be an operator?', 'Chi sarà operatore?'],
  'installer.whitelist': ['Do you want to turn whitelist on?', 'Vuoi attivare la whitelist?'],
  'installer.eula': [
    'By clicking Create Server I accept the',
    'Facendo clic su Crea server accetto la',
  ],
  'installer.eulaLink': ['Minecraft EULA', 'EULA di Minecraft'],
  'installer.small': ['1–2', '1–2'],
  'installer.medium': ['3–5', '3–5'],
  'installer.large': ['6+', '6+'],
  'fields.choiceId': ['Version', 'Versione'],
  'fields.sourceMode': ['Server content', 'Contenuti del server'],
  'fields.empty': ['New world', 'Nuovo mondo'],
  'fields.modpack': ['Modpack archive', 'Archivio modpack'],
  'fields.sourceId': ['Verified modpack upload', 'Modpack caricato e verificato'],
  'fields.operators': ['Operators', 'Operatori'],
  'fields.whitelist': ['Whitelist', 'Whitelist'],
  'fields.whitelistEnabled': ['Enable whitelist', 'Abilita whitelist'],
  'fields.eula': ['I accept the Minecraft EULA', 'Accetto l’EULA di Minecraft'],
  'fields.readEula': ['Read the Minecraft EULA', 'Leggi l’EULA di Minecraft'],
  'fields.eulaHelp': [
    'Read the Minecraft EULA before accepting.',
    'Leggi l’EULA di Minecraft prima di accettare.',
  ],
  'sections.properties': ['Game settings', 'Impostazioni di gioco'],
  'sections.players': ['Players', 'Giocatori'],
  'sections.worlds': ['Worlds', 'Mondi'],
  'sections.content': ['Content', 'Contenuti'],
  'forms.properties': ['Server properties', 'Proprietà del server'],
  'forms.player': ['Player access', 'Accesso giocatori'],
  'forms.selectWorld': ['Select world', 'Seleziona mondo'],
  'forms.removeWorld': ['Delete world', 'Elimina mondo'],
  'forms.importWorld': ['Import world', 'Importa mondo'],
  'forms.verify': ['Verify installation', 'Verifica installazione'],
  'forms.replacePack': ['Replace modpack', 'Sostituisci modpack'],
  'forms.removeContent': ['Remove content', 'Rimuovi contenuti'],
  'actions.save': ['Save changes', 'Salva modifiche'],
  'actions.applyPlayer': ['Apply', 'Applica'],
  'actions.select': ['Select', 'Seleziona'],
  'actions.delete': ['Delete world', 'Elimina mondo'],
  'actions.import': ['Import world', 'Importa mondo'],
  'actions.verify': ['Verify installation', 'Verifica installazione'],
  'actions.replace': ['Replace modpack', 'Sostituisci modpack'],
  'actions.remove': ['Remove', 'Rimuovi'],
  'warnings.removeWorld': [
    'This permanently deletes the selected world. Stop the server first.',
    'Il mondo selezionato verrà eliminato definitivamente. Prima arresta il server.',
  ],
  'warnings.replacePack': [
    'This removes the listed content and worlds. A backup must finish before deletion when requested.',
    'Questa operazione elimina i contenuti e i mondi elencati. Se richiesto, il backup deve terminare prima dell’eliminazione.',
  ],
  'warnings.removeContent': [
    'This removes the selected installed content. Dependent content may prevent removal.',
    'Questa operazione rimuove il contenuto selezionato. Eventuali dipendenze possono impedirne la rimozione.',
  ],
  'fields.list': ['Access list', 'Lista di accesso'],
  'fields.action': ['Action', 'Azione'],
  'fields.add': ['Add', 'Aggiungi'],
  'fields.remove': ['Remove', 'Rimuovi'],
  'fields.name': ['Player name', 'Nome giocatore'],
  'fields.operatorLevel': ['Operator level', 'Livello operatore'],
  'fields.bypassesPlayerLimit': ['Allow entry when full', 'Consenti l’accesso a server pieno'],
  'fields.world': ['World', 'Mondo'],
  'fields.archiveRef': ['Verified upload', 'Caricamento verificato'],
  'fields.replaceExisting': [
    'Replace the existing world folder',
    'Sostituisci la cartella del mondo esistente',
  ],
  'fields.replaceConsent': [
    'Delete the existing world before importing',
    'Elimina il mondo esistente prima dell’importazione',
  ],
  'fields.targetWorld': ['World folder', 'Cartella del mondo'],
  'fields.confirm': ['Confirm deletion', 'Conferma eliminazione'],
  'fields.backupBefore': ['Create a verified backup first', 'Crea prima un backup verificato'],
  'fields.wipeConsent': [
    'Delete the listed content and worlds',
    'Elimina i contenuti e i mondi elencati',
  ],
  'fields.expectedDeletePaths': ['Paths to delete', 'Percorsi da eliminare'],
  'fields.provider': ['Provider', 'Provider'],
  'fields.projectId': ['Project ID', 'ID progetto'],
  'fields.path': ['File', 'File'],
  'fields.status': ['Status', 'Stato'],
  'fields.installedAt': ['Installed', 'Installato'],
  'ports.game': ['Game connection', 'Connessione di gioco'],
  'properties.motd': ['Server description', 'Descrizione del server'],
  'properties.difficulty': ['Difficulty', 'Difficoltà'],
  'properties.gamemode': ['Game mode', 'Modalità di gioco'],
  'properties.pvp': ['Player combat', 'Combattimento tra giocatori'],
  'properties.white-list': ['Enable whitelist', 'Abilita whitelist'],
  'properties.enforce-whitelist': [
    'Disconnect players removed from whitelist',
    'Disconnetti i giocatori rimossi dalla whitelist',
  ],
  'properties.hardcore': ['Hardcore', 'Hardcore'],
  'properties.allow-flight': ['Allow flying', 'Consenti il volo'],
  'properties.spawn-monsters': ['Spawn monsters', 'Genera mostri'],
  'properties.spawn-animals': ['Spawn animals', 'Genera animali'],
  'properties.spawn-npcs': ['Spawn villagers', 'Genera abitanti'],
  'properties.generate-structures': ['Generate structures', 'Genera strutture'],
  'properties.max-players': ['Player limit', 'Limite giocatori'],
  'properties.view-distance': ['View distance (chunks)', 'Distanza visiva (chunk)'],
  'properties.simulation-distance': [
    'Simulation distance (chunks)',
    'Distanza di simulazione (chunk)',
  ],
  'properties.spawn-protection': ['Spawn protection (blocks)', 'Protezione dello spawn (blocchi)'],
  'properties.player-idle-timeout': [
    'Player idle timeout (minutes)',
    'Timeout inattività giocatori (minuti)',
  ],
  'options.peaceful': ['Peaceful', 'Pacifica'],
  'options.easy': ['Easy', 'Facile'],
  'options.normal': ['Normal', 'Normale'],
  'options.hard': ['Hard', 'Difficile'],
  'options.survival': ['Survival', 'Sopravvivenza'],
  'options.creative': ['Creative', 'Creativa'],
  'options.adventure': ['Adventure', 'Avventura'],
  'options.spectator': ['Spectator', 'Spettatore'],
  'states.verified': ['Verified', 'Verificato'],
  'states.incompatible': ['Incompatible', 'Incompatibile'],
  'states.unavailable': ['Unavailable', 'Non disponibile'],
};
export const minecraftUiCatalogs = Object.freeze({
  en: Object.fromEntries(Object.entries(translated).map(([id, [en]]) => [k(id), en])),
  it: Object.fromEntries(Object.entries(translated).map(([id, [, it]]) => [k(id), it])),
});
const field = (id: string, extra: Record<string, unknown>) => ({
  id,
  labelKey: k(`fields.${id}`),
  ...extra,
});
const choice = (id: string, entries: string[]) =>
  field(id, {
    type: 'choice',
    required: true,
    options: entries.map((value) => ({ value, labelKey: k(`fields.${value}`) })),
  });
const action = (id: string, capability: string, extra: Record<string, unknown> = {}) => ({
  id,
  handler: id,
  labelKey: k(`actions.${id}`),
  requiredPermissions: ['server:manage'],
  requiredCapabilities: [capability],
  requiresStopped: true,
  ...extra,
});
const operatorWhen = [
  { field: 'list', operator: 'equals', values: ['operators'] },
  { field: 'action', operator: 'equals', values: ['add'] },
];
const propertyFields: unknown[] = [
  { id: 'motd', type: 'text', maxLength: 256 },
  {
    id: 'difficulty',
    type: 'choice',
    options: ['peaceful', 'easy', 'normal', 'hard'].map((value) => ({
      value,
      labelKey: k(`options.${value}`),
    })),
  },
  {
    id: 'gamemode',
    type: 'choice',
    options: ['survival', 'creative', 'adventure', 'spectator'].map((value) => ({
      value,
      labelKey: k(`options.${value}`),
    })),
  },
  ...[
    'pvp',
    'white-list',
    'enforce-whitelist',
    'hardcore',
    'allow-flight',
    'spawn-monsters',
    'spawn-animals',
    'spawn-npcs',
    'generate-structures',
  ].map((id) => ({ id, type: 'boolean' })),
  ...Object.entries({
    'max-players': [1, 100000],
    'view-distance': [2, 32],
    'simulation-distance': [2, 32],
    'spawn-protection': [0, 29999984],
    'player-idle-timeout': [0, 2147483647],
  }).map(([id, bounds]) => ({ id, type: 'number', min: bounds[0], max: bounds[1] })),
].map((f) => ({ ...f, labelKey: k(`properties.${f.id}`) }));
export const minecraftUiDescriptor = gameUiDescriptorSchema.parse({
  gameId: 'minecraft-java',
  schemaVersion: 1,
  nameKey: k('name'),
  artwork: { assetId: 'landscape' },
  creation: {
    defaults: {
      sourceMode: 'empty',
      operators: [],
      whitelist: [],
      whitelistEnabled: false,
      eula: false,
    },
    pages: [
      {
        id: 'runtime',
        titleKey: k('installer.runtime'),
        field: 'runtime',
        kind: 'choice-list',
        position: 'before-name',
        resetFields: ['choiceId', 'operators', 'whitelist', 'whitelistEnabled', 'eula'],
      },
      { id: 'version', titleKey: k('installer.version'), field: 'choiceId', kind: 'version-list' },
      {
        id: 'operators',
        titleKey: k('installer.operators'),
        field: 'operators',
        kind: 'players',
        requiredCapability: 'playerManagement',
        lookupHandler: 'lookup-player',
      },
      {
        id: 'whitelist',
        titleKey: k('installer.whitelist'),
        field: 'whitelist',
        kind: 'toggle-players',
        requiredCapability: 'playerManagement',
        lookupHandler: 'lookup-player',
        toggleField: 'whitelistEnabled',
        seedField: 'operators',
      },
    ],
    resourcePresets: [
      { id: 'small', labelKey: k('installer.small'), memoryMiB: 2048, cpuPercent: 100 },
      { id: 'medium', labelKey: k('installer.medium'), memoryMiB: 4096, cpuPercent: 150 },
      { id: 'large', labelKey: k('installer.large'), memoryMiB: 6144, cpuPercent: 200 },
    ],
    agreement: {
      field: 'eula',
      textKey: k('installer.eula'),
      linkKey: k('installer.eulaLink'),
      url: 'https://www.minecraft.net/en-us/eula',
    },
    choicesHandler: 'choices',
    createHandler: 'create',
    prepareHandler: 'prepare-create',
    fields: [
      field('runtime', { type: 'choice', required: true, source: { handler: 'runtimes' } }),
      field('choiceId', {
        type: 'choice',
        required: true,
        source: { handler: 'choices', dependsOn: ['runtime'] },
      }),
      field('operators', {
        type: 'multi-text',
        maxItems: 1000,
        maxLength: 16,
        format: 'player-name',
      }),
      field('whitelist', {
        type: 'multi-text',
        maxItems: 1000,
        maxLength: 16,
        format: 'player-name',
      }),
      field('whitelistEnabled', { type: 'boolean' }),
      field('eula', {
        type: 'boolean',
        required: true,
        mustBeTrue: true,
        helpKey: k('fields.eulaHelp'),
        documentation: {
          url: 'https://www.minecraft.net/en-us/eula',
          labelKey: k('fields.readEula'),
        },
      }),
    ],
  },
  sections: [
    {
      id: 'properties',
      titleKey: k('sections.properties'),
      loader: 'properties',
      requiredPermissions: ['server:read'],
      requiredCapabilities: ['files'],
      forms: [
        {
          id: 'properties',
          titleKey: k('forms.properties'),
          fields: propertyFields,
          action: action('save', 'files'),
        },
      ],
    },
    {
      id: 'players',
      titleKey: k('sections.players'),
      loader: 'players',
      requiredPermissions: ['server:read'],
      requiredCapabilities: ['players'],
      columns: [
        { id: 'name', labelKey: k('fields.name') },
        { id: 'list', labelKey: k('fields.list'), format: 'message' },
      ],
      forms: [
        {
          id: 'player',
          titleKey: k('forms.player'),
          fields: [
            choice('list', ['operators', 'whitelist']),
            choice('action', ['add', 'remove']),
            field('name', {
              type: 'text',
              format: 'player-name',
              lookupHandler: 'lookup-player',
              minLength: 3,
              maxLength: 16,
              required: true,
            }),
            field('operatorLevel', { type: 'number', min: 1, max: 4, when: operatorWhen }),
            field('bypassesPlayerLimit', { type: 'boolean', when: operatorWhen }),
          ],
          action: action('applyPlayer', 'players', { id: 'apply-player', handler: 'apply-player' }),
        },
      ],
    },
    {
      id: 'worlds',
      titleKey: k('sections.worlds'),
      loader: 'worlds',
      requiredPermissions: ['server:manage'],
      requiredCapabilities: ['worlds'],
      columns: [
        { id: 'name', labelKey: k('fields.world') },
        { id: 'status', labelKey: k('fields.status'), format: 'message' },
      ],
      forms: [
        {
          id: 'select-world',
          titleKey: k('forms.selectWorld'),
          fields: [
            field('world', {
              type: 'choice',
              required: true,
              source: { handler: 'world-choices' },
            }),
          ],
          action: action('select', 'worlds'),
        },
        {
          id: 'import-world',
          titleKey: k('forms.importWorld'),
          fields: [
            field('archiveRef', {
              type: 'archive',
              accept: ['.zip'],
              handler: 'upload-world',
              required: true,
            }),
            field('targetWorld', {
              type: 'text',
              format: 'world-name',
              maxLength: 64,
              required: true,
            }),
            field('replaceExisting', { type: 'boolean' }),
            field('replaceConsent', {
              type: 'boolean',
              mustBeTrue: true,
              required: true,
              when: [{ field: 'replaceExisting', operator: 'equals', values: [true] }],
            }),
            field('backupBefore', {
              type: 'boolean',
              required: true,
              when: [{ field: 'replaceExisting', operator: 'equals', values: [true] }],
            }),
          ],
          action: action('import', 'worlds'),
        },
        {
          id: 'remove-world',
          titleKey: k('forms.removeWorld'),
          fields: [
            field('world', {
              type: 'choice',
              required: true,
              source: { handler: 'world-choices' },
            }),
            field('confirm', { type: 'boolean', required: true, mustBeTrue: true }),
            field('backupBefore', { type: 'boolean', required: true }),
          ],
          action: action('delete', 'worlds', {
            destructive: true,
            confirmationKey: k('warnings.removeWorld'),
          }),
        },
      ],
    },
    {
      id: 'content',
      titleKey: k('sections.content'),
      loader: 'content',
      requiredPermissions: ['server:read'],
      requiredCapabilities: ['files'],
      columns: [
        { id: 'path', labelKey: k('fields.path') },
        { id: 'installed_at', labelKey: k('fields.installedAt'), format: 'date' },
      ],
      forms: [
        {
          id: 'verify',
          titleKey: k('forms.verify'),
          fields: [],
          action: action('verify', 'files'),
        },
        {
          id: 'replace-pack',
          titleKey: k('forms.replacePack'),
          fields: [
            field('archiveRef', {
              type: 'archive',
              accept: ['.mrpack', '.zip'],
              handler: 'upload-modpack',
              required: true,
              catalog: {
                searchHandler: 'modpack-search',
                versionsHandler: 'modpack-versions',
                acquireHandler: 'modpack-acquire',
              },
            }),
            field('wipeConsent', { type: 'boolean', required: true, mustBeTrue: true }),
            field('backupBefore', { type: 'boolean', required: true }),
            field('expectedDeletePaths', {
              type: 'preview',
              handler: 'wipe-preview',
              maxItems: 1000,
              required: true,
            }),
          ],
          action: action('replace', 'files', {
            destructive: true,
            confirmationKey: k('warnings.replacePack'),
          }),
        },
        {
          id: 'remove-content',
          titleKey: k('forms.removeContent'),
          fields: [
            field('provider', {
              type: 'choice',
              required: true,
              options: [
                { value: 'modrinth', label: 'Modrinth' },
                { value: 'curseforge', label: 'CurseForge' },
              ],
            }),
            field('projectId', { type: 'text', maxLength: 128, required: true }),
          ],
          action: action('remove', 'mods', {
            destructive: true,
            confirmationKey: k('warnings.removeContent'),
          }),
        },
      ],
    },
  ],
  ports: [{ role: 'game', labelKey: k('ports.game'), transports: ['tcp'], required: true }],
  connectionModes: [
    { mode: 'custom-subdomain', srv: { service: '_minecraft', transport: 'tcp' } },
    { mode: 'static-host-port', showPort: true },
  ],
});
const server = (context: GameUiContext) => z.uuid().parse(context.serverId);
const intent = (context: GameUiContext) =>
  z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/)
    .parse(context.idempotencyKey);
export function minecraftPropertyValues(
  properties: Readonly<Record<string, unknown>>,
  fields: readonly UiField[] = minecraftUiDescriptor.sections[0]?.forms[0]?.fields ?? [],
) {
  return Object.fromEntries(
    fields.flatMap<[string, string | number | boolean]>((f) => {
      const value = properties[f.id];
      if (value === undefined) return [];
      if (f.type === 'boolean')
        return value === true || value === 'true'
          ? [[f.id, true]]
          : value === false || value === 'false'
            ? [[f.id, false]]
            : [];
      if (f.type === 'number') {
        const number =
          typeof value === 'number'
            ? value
            : typeof value === 'string' && /^\d+$/.test(value)
              ? Number(value)
              : Number.NaN;
        return Number.isFinite(number) ? [[f.id, number]] : [];
      }
      return typeof value === 'string' ? [[f.id, value]] : [];
    }),
  );
}
export const minecraftUiModule = defineTrustedGameUiModule({
  descriptor: minecraftUiDescriptor,
  catalogs: minecraftUiCatalogs,
  assets: { landscape: new URL('./assets/minecraft-landscape.svg', import.meta.url).href },
  playerAppearance: {
    fallback: new URL('./assets/player-placeholder.svg', import.meta.url).href,
    avatarUrl: (name) => `https://api.mcheads.org/head/${encodeURIComponent(name)}/64`,
  },
  handlers: {
    'prepare-create': async (client, context) => {
      const controller = createMinecraftUiController(client);
      if (context.values.sourceMode === 'modpack') {
        const result = await controller.inspectModpack(
          z.uuid().parse(context.values.sourceId),
          context.signal,
        );
        if (!result.derived) throw new MinecraftUiError('integration_unavailable');
        return {
          values: { ...context.values, choiceId: result.derived.choiceId },
          summary: [
            {
              labelKey: k('fields.choiceId'),
              value: `${result.derived.release} · ${result.derived.runtime}`,
            },
          ],
        };
      }
      const choice = (await controller.choices(context.signal)).find(
        (choice) => choice.id === context.values.choiceId,
      );
      if (!choice || (context.values.runtime && context.values.runtime !== choice.runtime))
        throw new MinecraftUiError('integration_unavailable');
      return {
        values: {
          ...context.values,
          playerManagement: choice.capabilities?.playerManagement !== false,
          ...(choice.capabilities?.playerManagement === false
            ? { operators: [], whitelist: [], whitelistEnabled: false }
            : {}),
        },
        summary: [
          { labelKey: k('fields.runtime'), value: choice.runtime },
          { labelKey: k('fields.choiceId'), value: choice.version },
        ],
      };
    },
    'lookup-player': (client, context) =>
      createMinecraftUiController(client).player(
        z.string().parse(context.values.name),
        false,
        context.signal,
      ),
    'modpack-search': (client, context) =>
      createMinecraftUiController(client).searchModpacks(
        z.string().parse(context.values.query),
        0,
        context.signal,
      ),
    'modpack-versions': (client, context) =>
      createMinecraftUiController(client).modpackVersions(
        z.string().parse(context.values.projectId),
        context.signal,
      ),
    'modpack-acquire': (client, context) =>
      createMinecraftUiController(client).acquireModpack(
        {
          projectId: z.string().parse(context.values.projectId),
          versionId: z.string().parse(context.values.versionId),
          serverId: context.serverId,
          idempotencyKey: intent(context),
        },
        context.signal,
      ),
    'wipe-preview': async (client, context) =>
      (await createMinecraftUiController(client).wipePreview(server(context), context.signal))
        .deletePaths,
    'upload-world': (client, context) => uploadArchive(client, context, 'world'),
    'upload-modpack': (client, context) => uploadArchive(client, context, 'modpack'),
    runtimes: (client, context) =>
      createMinecraftUiController(client).runtimeOptions(context.signal),
    choices: async (client, context) => {
      const controller = createMinecraftUiController(client);
      if (context.values.sourceMode === 'modpack' && context.values.sourceId) {
        const wizard = await controller.inspectModpack(
          z.uuid().parse(context.values.sourceId),
          context.signal,
        );
        return wizard.choices.map((c) => ({
          value: c.id,
          label: `${c.release} · ${c.runtime}`,
          disabled: false,
        }));
      }
      if (typeof context.values.runtime !== 'string') return [];
      return controller.choiceOptions(context.signal, context.values.runtime);
    },
    create: async (client, context) => {
      const controller = createMinecraftUiController(client),
        v = context.values;
      let choiceId = v.choiceId;
      if (v.sourceMode === 'modpack')
        choiceId = (await controller.inspectModpack(z.uuid().parse(v.sourceId), context.signal))
          .derived?.choiceId;
      return controller.create(
        {
          idempotencyKey: intent(context),
          name: v.name,
          projectId: v.projectId,
          limits: v.limits,
          autoStart: v.autoStart ?? true,
          minecraft: {
            choiceId,
            configuration: {
              eula: v.eula,
              properties:
                v.playerManagement === false ? {} : { 'white-list': v.whitelistEnabled ?? false },
              operators: v.operators ?? [],
              whitelist: v.whitelistEnabled ? (v.whitelist ?? []) : [],
              ...(v.sourceMode === 'modpack' ? { modpack: { sourceId: v.sourceId } } : {}),
            },
          },
        },
        context.signal,
      );
    },
    properties: async (client, context): Promise<UiSectionData> => {
      const profile = await createMinecraftUiController(client).profile(
        server(context),
        context.signal,
      );
      return {
        values: minecraftPropertyValues(profile.effectiveProperties),
        rows: [],
        editableFields: profile.supportedProperties ?? [],
        metadata: {
          installed: profile.installed,
          version: profile.version,
          runtime: profile.runtime,
        },
      };
    },
    save: async (client, context) =>
      createMinecraftUiController(client).updateProperties(
        server(context),
        intent(context),
        context.values,
        context.signal,
      ),
    players: async (client, context): Promise<UiSectionData> => {
      const profile = await createMinecraftUiController(client).profile(
        server(context),
        context.signal,
      );
      return {
        values: { list: 'whitelist', action: 'add', operatorLevel: 4, bypassesPlayerLimit: false },
        rows: [
          ...profile.configuration.operators.map((name) => ({ name, list: k('fields.operators') })),
          ...profile.configuration.whitelist.map((name) => ({ name, list: k('fields.whitelist') })),
        ],
      };
    },
    'apply-player': async (client, context) => {
      const v = context.values;
      return createMinecraftUiController(client).operate(
        server(context),
        intent(context),
        {
          kind: 'player',
          list: v.list,
          action: v.action,
          name: v.name,
          ...(v.list === 'operators' && v.action === 'add'
            ? { operatorLevel: v.operatorLevel, bypassesPlayerLimit: v.bypassesPlayerLimit }
            : {}),
        },
        context.signal,
      );
    },
    worlds: async (client, context): Promise<UiSectionData> => ({
      values: { backupBefore: true, confirm: false },
      rows: (await createMinecraftUiController(client).worlds(server(context), context.signal)).map(
        (world) => ({ ...world, status: k(`states.${world.status}`) }),
      ),
    }),
    'world-choices': async (client, context) =>
      (await createMinecraftUiController(client).worlds(server(context), context.signal)).map(
        (w) => ({
          value: w.name,
          label: w.name,
          disabled: w.status !== 'verified',
          ...(w.status !== 'verified' ? { reasonKey: k(`states.${w.status}`) } : {}),
        }),
      ),
    select: async (client, context) =>
      createMinecraftUiController(client).operate(
        server(context),
        intent(context),
        { kind: 'world-select', world: context.values.world },
        context.signal,
      ),
    import: async (client, context) =>
      createMinecraftUiController(client).operate(
        server(context),
        intent(context),
        {
          kind: 'world-import',
          archiveRef: context.values.archiveRef,
          targetWorld: context.values.targetWorld,
          ...(context.values.replaceExisting === true
            ? {
                replace: {
                  wipeConsent: context.values.replaceConsent,
                  expectedDeletePaths: [context.values.targetWorld],
                  backupBefore: context.values.backupBefore,
                },
              }
            : {}),
        },
        context.signal,
      ),
    delete: async (client, context) =>
      createMinecraftUiController(client).operate(
        server(context),
        intent(context),
        {
          kind: 'world-remove',
          world: context.values.world,
          confirm: context.values.confirm,
          backupBefore: context.values.backupBefore,
        },
        context.signal,
      ),
    content: async (client, context): Promise<UiSectionData> => {
      const profile = await createMinecraftUiController(client).profile(
        server(context),
        context.signal,
      );
      return {
        values: { wipeConsent: false, backupBefore: true },
        rows: profile.content,
        metadata: {
          installed: profile.installed,
          ...minecraftContentCapabilities(profile.runtime),
        },
      };
    },
    verify: async (client, context) =>
      createMinecraftUiController(client).operate(
        server(context),
        intent(context),
        { kind: 'verify' },
        context.signal,
      ),
    replace: async (client, context) => {
      // Preserve the exact preview the user confirmed; do not silently refresh it at submit time.
      const v = context.values;
      return createMinecraftUiController(client).operate(
        server(context),
        intent(context),
        {
          kind: 'modpack-upload',
          archiveRef: v.archiveRef,
          replace: {
            wipeConsent: v.wipeConsent,
            backupBefore: v.backupBefore,
            expectedDeletePaths: v.expectedDeletePaths,
          },
        },
        context.signal,
      );
    },
    remove: async (client, context) =>
      createMinecraftUiController(client).operate(
        server(context),
        intent(context),
        { kind: 'remove', provider: context.values.provider, projectId: context.values.projectId },
        context.signal,
      ),
  },
});

/** Trusted callers can use the controller for file pickers and provider catalog workflows. */
export function requireMinecraftUiHandler(
  id: string,
  client: GameUiClient,
  context: GameUiContext,
) {
  const handler = minecraftUiModule.handlers[id];
  if (!handler) throw new MinecraftUiError('validation_failed');
  return handler(client, context);
}

async function uploadArchive(
  client: GameUiClient,
  context: GameUiContext,
  kind: 'world' | 'modpack',
) {
  const file = context.values.file;
  if (!(file instanceof Blob)) throw new MinecraftUiError('validation_failed');
  return createMinecraftUiController(client).uploadSource({
    kind,
    serverId: context.serverId,
    idempotencyKey: intent(context),
    file,
    sha256: z.string().parse(context.values.sha256),
    signal: context.signal,
  });
}
