const messages: Record<string, [string, string]> = {
  locations: ['Game folders', 'Cartelle del gioco'],
  saves: ['Saves', 'Salvataggi'],
  mods: ['Mods', 'Mod'],
  configuration: ['Configuration', 'Configurazione'],
  logs: ['Logs', 'Log'],
  crashes: ['Crash reports', 'Report crash'],
  'kind.crash': ['Unreal crash report', 'Report crash Unreal'],
  'kind.certificate': ['Certificate file', 'File certificato'],
  worlds: ['Open Worlds', 'Apri Worlds'],
  'kind.serverSettings': ['Satisfactory server settings', 'Impostazioni server Satisfactory'],
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
