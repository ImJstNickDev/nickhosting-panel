import {
  defineTrustedGameUiModule,
  type GameUiClient,
  type GameUiContext,
  gameUiDescriptorSchema,
  type UiField,
  type UiSectionData,
} from '@nickhosting/game-sdk/ui';
import { z } from 'zod';
import { minecraftContentRuntimes } from '../content-capabilities.js';
import { minecraftPropertyEnumName } from '../property-enums.js';
import { minecraftViewerMessages } from '../viewers/catalog.js';
import {
  createMinecraftUiController,
  MinecraftUiError,
  minecraftCatalogOptions,
  minecraftContentCapabilities,
} from './controller.js';
import { minecraftDatapacksMessages } from './datapacks-catalog.js';
import { minecraftModpacksMessages } from './modpacks-catalog.js';
import { createMinecraftModpacksController } from './modpacks-controller.js';
import { minecraftModsMessages } from './mods-catalog.js';
import { createMinecraftModsController } from './mods-controller.js';
import { minecraftPlayersMessages } from './players-catalog.js';
import { minecraftPluginsMessages } from './plugins-catalog.js';
import { minecraftWorldsMessages } from './worlds-catalog.js';

export { minecraftFormattingTokens } from '../message-formatting.js';
export * from '../message-layout.js';
export { minecraftViewers } from '../viewers/index.js';
export * from './controller.js';

const namespace = 'games.minecraft';
const k = (name: string) => `${namespace}.${name}`;
const translated: Record<string, [string, string]> = {
  ...minecraftViewerMessages,
  ...minecraftPlayersMessages,
  ...minecraftDatapacksMessages,
  ...minecraftModsMessages,
  ...minecraftModpacksMessages,
  ...minecraftPluginsMessages,
  ...minecraftWorldsMessages,
  'messages.disconnected': ['Failed to connect to the server', 'Connessione al server fallita'],
  'messages.back': ['Back to Server List', 'Torna alla lista dei server'],
  'messages.source': ['Text codes', 'Codici di testo'],
  'messages.colors': ['Text color', 'Colore del testo'],
  'messages.visual': ['Visual editor', 'Editor visuale'],
  'messages.variables': ['Insert variable', 'Inserisci variabile'],
  'messages.undo': ['Undo', 'Annulla modifica'],
  'messages.redo': ['Redo', 'Ripeti modifica'],
  'messages.inherited': ['Default', 'Predefinito'],
  'messages.custom': ['Custom', 'Personalizzato'],
  'messages.reference': ['Vanilla 26.1 preview', 'Anteprima Vanilla 26.1'],
  'messages.multiplayer': ['Play Multiplayer', 'Multigiocatore'],
  'messages.join': ['Join Server', 'Entra nel server'],
  'messages.direct': ['Direct Connection', 'Accesso diretto'],
  'messages.add': ['Add Server', 'Aggiungi server'],
  'messages.edit': ['Edit', 'Modifica'],
  'messages.delete': ['Delete', 'Elimina'],
  'messages.refresh': ['Refresh', 'Aggiorna'],
  'messages.cancel': ['Cancel', 'Annulla'],
  'messages.alignLeft': ['Align left', 'Allinea a sinistra'],
  'messages.alignCenter': ['Align center', 'Allinea al centro'],
  'messages.alignRight': ['Align right', 'Allinea a destra'],
  'messages.alignment': ['Message alignment', 'Allineamento del messaggio'],
  'messages.layoutGuide': ['Client layout guide', 'Guida al layout del client'],
  'messages.lineCount': [
    '{count, plural, one {# line} other {# lines}}',
    '{count, plural, one {# riga} other {# righe}}',
  ],
  'messages.motdGuide': [
    'Vanilla 26.1 wraps at 267 GUI pixels and displays only the first two lines, without an ellipsis. Variable values can change the result.',
    'Vanilla 26.1 va a capo a 267 pixel GUI e mostra solo le prime due righe, senza puntini di sospensione. I valori delle variabili possono cambiare il risultato.',
  ],
  'messages.disconnectGuide': [
    'Vanilla 26.1 wraps to the game window width minus 50 GUI pixels. There is no line limit; long messages can extend beyond the screen. This guide uses the preview window size.',
    'Vanilla 26.1 va a capo alla larghezza della finestra meno 50 pixel GUI. Non esiste un limite di righe: i messaggi lunghi possono uscire dallo schermo. La guida usa le dimensioni di questa anteprima.',
  ],
  'messages.measurementGuide': [
    'Estimated with the default font. Client fonts and settings can change the result.',
    'Stima con il font predefinito. Font e impostazioni del client possono cambiare il risultato.',
  ],
  'messages.fallbackGuide': [
    'Preview font unavailable. The guide uses default Minecraft metrics.',
    'Font di anteprima non disponibile. La guida usa le misure predefinite di Minecraft.',
  ],
  'messages.motdClipped': [
    'The text is estimated to exceed the two visible lines. All lines remain editable here.',
    'Il testo supera le due righe visibili secondo la stima. Qui puoi ancora modificarle tutte.',
  ],
  'messages.disconnectClipped': [
    'The message may extend beyond a game window this size.',
    'Il messaggio potrebbe uscire da una finestra di gioco di queste dimensioni.',
  ],
  name: ['Minecraft', 'Minecraft'],
  'admin.versions': ['Versions', 'Versioni'],
  'installer.runtime': ['Choose a runtime', 'Scegli un runtime'],
  'fields.runtime': ['Runtime', 'Runtime'],
  'runtimes.vanilla': ['Vanilla', 'Vanilla'],
  'runtimes.paper': ['Paper', 'Paper'],
  'runtimes.folia': ['Folia', 'Folia'],
  'runtimes.fabric': ['Fabric', 'Fabric'],
  'runtimes.forge': ['Forge', 'Forge'],
  'installer.address': ['Choose an address', 'Scegli un indirizzo'],
  'installer.version': ['Choose a version', 'Scegli una versione'],
  'installer.loader': ['Choose a Fabric Loader', 'Scegli un Fabric Loader'],
  'fields.loaderVersion': ['Fabric Loader', 'Fabric Loader'],
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
  'sections.properties': ['Settings', 'Impostazioni'],
  'sections.players': ['Players', 'Giocatori'],
  'sections.worlds': ['Worlds', 'Mondi'],
  'sections.mods': ['Mods', 'Mod'],
  'sections.plugins': ['Plugins', 'Plugin'],
  'sections.datapacks': ['Datapacks', 'Datapack'],
  'sections.modpacks': ['Modpacks', 'Modpack'],
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
  'settings.description': ['Server description', 'Descrizione del server'],
  'settings.gameplay': ['Gameplay', 'Gioco'],
  'settings.access': ['Access', 'Accesso'],
  'settings.world': ['World', 'Mondo'],
  'settings.performance': ['Performance', 'Prestazioni'],
  'settings.other': ['Other settings', 'Altre impostazioni'],
  'settings.motdHelp': [
    'Shown in the server list while Minecraft is running. Gateway messages are in Automation.',
    'Visibile nella lista server quando Minecraft è in esecuzione. I messaggi Gateway sono in Automazione.',
  ],
  'settings.flightHelp': [
    'Allows flying clients to stay connected; does not grant flight.',
    'Consente ai client in volo di restare connessi; non abilita il volo.',
  ],
  'settings.hardcoreHelp': [
    'Players cannot return to survival after death.',
    'Dopo la morte i giocatori non possono tornare in sopravvivenza.',
  ],
  'settings.structuresHelp': [
    'Applies to newly generated terrain.',
    'Si applica al terreno generato da questo momento.',
  ],
  'settings.idleHelp': [
    'Disconnects inactive players. 0 disables it; server sleep is configured in Automation.',
    'Disconnette i giocatori inattivi. 0 lo disattiva; la sospensione del server si configura in Automazione.',
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
const action = (id: string, capability: string, extra: Record<string, unknown> = {}) => ({
  id,
  handler: id,
  labelKey: k(`actions.${id}`),
  requiredPermissions: ['server:manage'],
  requiredCapabilities: [capability],
  requiresStopped: true,
  ...extra,
});
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
  }).map(([id, bounds]) => ({
    id,
    type: 'number',
    min: bounds[0],
    max: bounds[1],
    required: true,
  })),
].map((f) => ({ ...f, labelKey: k(`properties.${f.id}`) }));
export const minecraftUiDescriptor = gameUiDescriptorSchema.parse({
  gameId: 'minecraft',
  schemaVersion: 1,
  nameKey: k('name'),
  artwork: { assetId: 'landscape' },
  administration: [
    { id: 'versions', titleKey: k('admin.versions'), component: 'minecraft-versions' },
  ],
  fileIcons: [{ extensions: ['properties'], assetId: 'properties' }],
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
        resetFields: [
          'choiceId',
          'loaderVersion',
          'operators',
          'whitelist',
          'whitelistEnabled',
          'eula',
        ],
      },
      { id: 'version', titleKey: k('installer.version'), field: 'choiceId', kind: 'version-list' },
      {
        id: 'loader',
        titleKey: k('installer.loader'),
        field: 'loaderVersion',
        kind: 'version-list',
      },
      { id: 'address', titleKey: k('installer.address'), kind: 'address' },
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
      field('loaderVersion', {
        type: 'choice',
        required: true,
        when: [{ field: 'runtime', operator: 'equals', values: ['fabric'] }],
        source: { handler: 'loaders', dependsOn: ['runtime'] },
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
          renderer: 'minecraft-properties',
          submitChangedOnly: true,
          fields: propertyFields,
          action: action('save', 'files'),
        },
      ],
    },
    {
      id: 'players',
      titleKey: k('sections.players'),
      loader: 'players',
      renderer: 'minecraft-players',
      requiredPermissions: ['server:read'],
      requiredCapabilities: ['players'],
      columns: [],
      forms: [],
    },
    {
      id: 'worlds',
      titleKey: k('sections.worlds'),
      loader: 'worlds',
      renderer: 'minecraft-worlds',
      requiredPermissions: ['server:read'],
      requiredCapabilities: ['worlds'],
      columns: [],
      forms: [],
    },
    {
      id: 'mods',
      titleKey: k('sections.mods'),
      loader: 'mods',
      renderer: 'minecraft-mods',
      runtimeIds: [...minecraftContentRuntimes.mods],
      requiredPermissions: ['server:read'],
      requiredCapabilities: ['files'],
      columns: [],
      forms: [],
    },
    {
      id: 'plugins',
      titleKey: k('sections.plugins'),
      loader: 'plugins',
      renderer: 'minecraft-plugins',
      runtimeIds: [...minecraftContentRuntimes.plugins],
      requiredPermissions: ['server:read'],
      requiredCapabilities: ['files'],
      columns: [],
      forms: [],
    },
    {
      id: 'datapacks',
      titleKey: k('sections.datapacks'),
      renderer: 'minecraft-datapacks',
      loader: 'datapacks',
      requiredPermissions: ['server:read'],
      requiredCapabilities: ['files'],
      columns: [
        { id: 'path', labelKey: k('fields.path') },
        { id: 'installed_at', labelKey: k('fields.installedAt'), format: 'date' },
      ],
      forms: [],
    },
    {
      id: 'modpacks',
      aliases: ['content'],
      titleKey: k('sections.modpacks'),
      loader: 'modpacks',
      renderer: 'minecraft-modpacks',
      requiredPermissions: ['server:read'],
      requiredCapabilities: ['files'],
      columns: [],
      forms: [],
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
      return typeof value === 'string' ? [[f.id, minecraftPropertyEnumName(f.id, value)]] : [];
    }),
  );
}
export const minecraftUiModule = defineTrustedGameUiModule({
  descriptor: minecraftUiDescriptor,
  gatewayMessageEditor: 'minecraft-26.1',
  catalogs: minecraftUiCatalogs,
  assets: {
    gatewayFont: new URL('./assets/local-26.1/minecraft.woff', import.meta.url).href,
    gatewayMenu: new URL('./assets/local-26.1/menu-background.png', import.meta.url).href,
    gatewayListMenu: new URL('./assets/local-26.1/menu-list-background.png', import.meta.url).href,
    gatewayPanorama: new URL('./assets/local-26.1/panorama.png', import.meta.url).href,
    gatewayHeader: new URL('./assets/local-26.1/header-separator.png', import.meta.url).href,
    gatewayFooter: new URL('./assets/local-26.1/footer-separator.png', import.meta.url).href,
    gatewayServerIcon: new URL('./assets/local-26.1/server-icon.png', import.meta.url).href,
    gatewayPing: new URL('./assets/local-26.1/ping.png', import.meta.url).href,
    gatewayButton: new URL('./assets/local-26.1/button.png', import.meta.url).href,
    landscape: new URL('./assets/minecraft-landscape.svg', import.meta.url).href,
    fabric: new URL('./assets/fabric-workshop.svg', import.meta.url).href,
    properties: new URL('./assets/minecraft-properties.svg', import.meta.url).href,
  },
  playerAppearance: {
    fallback: new URL('./assets/player-placeholder.svg', import.meta.url).href,
    avatarUrl: (name) => `https://api.mcheads.org/head/${encodeURIComponent(name)}/64`,
  },
  creationCatalog: {
    handlers: ['runtimes', 'choices', 'loaders'],
    applies: (_handler, values) => values.sourceMode !== 'modpack',
    load: (client, signal) => createMinecraftUiController(client).creationCatalog(signal),
    options: minecraftCatalogOptions,
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
          ...(choice.runtime === 'fabric'
            ? [
                {
                  labelKey: k('fields.loaderVersion'),
                  value: z.string().parse(context.values.loaderVersion),
                },
              ]
            : []),
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
    loaders: (client, context) => createMinecraftUiController(client).loaderOptions(context.signal),
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
          connection: v.connection,
          minecraft: {
            choiceId,
            ...(v.runtime === 'fabric' ? { loaderVersion: v.loaderVersion } : {}),
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
      const players = await createMinecraftUiController(client).players(
        server(context),
        context.signal,
      );
      return { values: {}, rows: [], metadata: { players, installed: players.installed } };
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
    modpacks: async (client, context): Promise<UiSectionData> => {
      const modpacks = await createMinecraftModpacksController(client).snapshot(
        server(context),
        context.signal,
      );
      return { values: {}, rows: [], metadata: { modpacks } };
    },
    plugins: async (client, context): Promise<UiSectionData> => {
      const plugins = await createMinecraftModsController(client, 'plugins').snapshot(
        server(context),
        context.signal,
      );
      return { values: {}, rows: [], metadata: { plugins, installed: plugins.installed } };
    },
    mods: async (client, context): Promise<UiSectionData> => {
      const mods = await createMinecraftModsController(client).snapshot(
        server(context),
        context.signal,
      );
      return { values: {}, rows: [], metadata: { mods, installed: mods.installed } };
    },
    datapacks: async (client, context): Promise<UiSectionData> => {
      const datapacks = await createMinecraftUiController(client).datapacks(
        server(context),
        undefined,
        context.signal,
      );
      return { values: {}, rows: [], metadata: { datapacks, installed: datapacks.installed } };
    },
    worlds: async (client, context): Promise<UiSectionData> => {
      const worlds = await createMinecraftUiController(client).worlds(
        server(context),
        context.signal,
      );
      return { values: {}, rows: [], metadata: { worlds, installed: worlds.installed } };
    },
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
        // These are the existing tracked installation receipts, not a new scan.
        // Pack inventory remains complete; individual categories are projections.
        rows: profile.content.filter((item) => {
          switch (context.values.sectionId) {
            case 'mods':
              return item.path.startsWith('mods/');
            case 'plugins':
              return item.path.startsWith('plugins/');
            case 'datapacks':
              return /^[^/]+\/datapacks\//.test(item.path);
            default:
              return true;
          }
        }),
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

export type {
  FabricCatalogResponse,
  FabricCatalogSnapshot,
  FabricCatalogStatus,
} from '../fabric-catalog.js';
