const messages: Record<string, [string, string]> = {
  locations: ['Game folders', 'Cartelle del gioco'],
  saves: ['Saves', 'Salvataggi'],
  mods: ['Mods', 'Mod'],
  configuration: ['Configuration', 'Configurazione'],
  logs: ['Logs', 'Log'],
  worlds: ['Open Worlds', 'Apri Worlds'],
  'kind.save': ['Satisfactory save', 'Salvataggio Satisfactory'],
  'kind.blueprint': ['Satisfactory blueprint', 'Blueprint Satisfactory'],
  'kind.configuration': ['Unreal configuration', 'Configurazione Unreal'],
  'kind.log': ['Log file', 'File di log'],
  'kind.modManifest': ['Mod manifest', 'Manifest delle mod'],
};
export const satisfactoryFilemanCatalogs = {
  en: Object.fromEntries(
    Object.entries(messages).map(([key, value]) => [`games.satisfactory.fileman.${key}`, value[0]]),
  ),
  it: Object.fromEntries(
    Object.entries(messages).map(([key, value]) => [`games.satisfactory.fileman.${key}`, value[1]]),
  ),
};
