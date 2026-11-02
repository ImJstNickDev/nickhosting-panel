const messages: Record<string, [string, string]> = {
  'advanced.noBuildCost': ['Build without material costs', 'Costruisci senza costi di materiali'],
  advancedNoWorld: [
    'Load or create a world in Worlds to edit its advanced settings.',
    'Carica o crea un mondo in Worlds per modificarne le impostazioni avanzate.',
  ],
  advancedTitle: ['Advanced world settings', 'Impostazioni avanzate del mondo'],
  advancedEnabled: [
    'Creative mode is enabled for this world.',
    'La modalità creativa è attiva per questo mondo.',
  ],
  advancedDisabled: [
    'Saving these settings enables creative mode for this world.',
    'Salvando queste impostazioni si attiva la modalità creativa per questo mondo.',
  ],
  advancedConfirm: [
    'Enable creative mode and apply these settings to the current world',
    'Attiva la modalità creativa e applica queste impostazioni al mondo corrente',
  ],
  advancedEmpty: [
    'The server has not provided any advanced settings.',
    'Il server non ha fornito impostazioni avanzate.',
  ],
  optionsEmpty: [
    'The server has not provided any server options.',
    'Il server non ha fornito opzioni server.',
  ],
  advancedHelp: [
    'These settings apply to the loaded world. Available options depend on the game version and installed mods.',
    'Queste impostazioni si applicano al mondo caricato. Le opzioni disponibili dipendono dalla versione del gioco e dalle mod installate.',
  ],
  advancedWorldChanged: [
    'The active world changed. Cancel these edits before changing the new world.',
    'Il mondo attivo è cambiato. Annulla queste modifiche prima di modificare il nuovo mondo.',
  ],
  retry: ['Retry', 'Riprova'],
};
export const satisfactorySettingsCatalogs = {
  en: Object.fromEntries(
    Object.entries(messages).map(([key, values]) => [`games.satisfactory.api.${key}`, values[0]]),
  ),
  it: Object.fromEntries(
    Object.entries(messages).map(([key, values]) => [`games.satisfactory.api.${key}`, values[1]]),
  ),
};
