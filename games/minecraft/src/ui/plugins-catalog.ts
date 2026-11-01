import { minecraftModsMessages } from './mods-catalog.js';

/** Shared interactions, with the plugin vocabulary owned by the integration. */
export const minecraftPluginsMessages: Record<string, [string, string]> = {
  ...Object.fromEntries(
    Object.entries(minecraftModsMessages).map(([key, value]) => [
      key.replace(/^mods\./, 'plugins.'),
      value,
    ]),
  ),
  'plugins.search': ['Search plugins', 'Cerca plugin'],
  'plugins.searchInstalled': ['Search installed plugins', 'Cerca plugin installati'],
  'plugins.showAllProjects': ['Include incompatible plugins', 'Includi plugin incompatibili'],
  'plugins.installed': ['Installed', 'Installati'],
  'plugins.alreadyInstalled': ['Already installed', 'Già installato'],
  'plugins.ready': ['Ready', 'Pronto'],
  'plugins.enabled': ['Enabled', 'Abilitato'],
  'plugins.disabled': ['Disabled', 'Disabilitato'],
  'plugins.forced': ['Forced', 'Forzato'],
  'plugins.blocker.conflict': [
    'Conflicts with the selected or installed plugins.',
    'È in conflitto con i plugin selezionati o installati.',
  ],
  'plugins.updates.current': [
    'Catalog plugins are up to date',
    'I plugin del catalogo sono aggiornati',
  ],
  'plugins.empty': ['No plugins installed', 'Nessun plugin installato'],
  'plugins.emptyAction': ['Find plugins', 'Trova plugin'],
  'plugins.noResults': ['No matching plugins', 'Nessun plugin corrispondente'],
  'plugins.loading': ['Loading plugins', 'Caricamento plugin'],
  'plugins.unsupported': [
    'This runtime does not support plugins.',
    'Questo runtime non supporta i plugin.',
  ],
  'plugins.notInstalled': [
    'Finish installing the server to manage plugins.',
    'Completa l’installazione del server per gestire i plugin.',
  ],
  'plugins.readonly': [
    'You have read-only access to plugins.',
    'Hai accesso ai plugin in sola lettura.',
  ],
  'plugins.refresh': ['Refresh plugins', 'Aggiorna plugin'],
  'plugins.blocker.observedLoaders': [
    'Platforms found in the catalog: {loaders}',
    'Piattaforme trovate nel catalogo: {loaders}',
  ],
  'plugins.incompatibility.loader': ['Different server platform', 'Piattaforma server diversa'],
  'plugins.incompatibility.client-only': ['Client-only content', 'Contenuto solo client'],
  'plugins.incompatibility.singleplayer-only': [
    'Singleplayer-only content',
    'Contenuto solo giocatore singolo',
  ],
  'plugins.forceBody': [
    'The server may fail to start or load this plugin. You can remove it from the queue before applying.',
    'Il server potrebbe non avviarsi o non caricare questo plugin. Puoi rimuoverlo dalla coda prima di applicare.',
  ],
  'plugins.comingSoon': ['Coming soon', 'In arrivo'],
  'plugins.restartUnavailable': [
    'Could not check whether plugins need a restart.',
    'Impossibile verificare se i plugin richiedono un riavvio.',
  ],
  'plugins.reviewInstalled': ['Review plugins', 'Vedi plugin'],
};
