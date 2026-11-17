const messages: Record<string, [string, string]> = {
  compare: ['Compare save details', 'Confronta dettagli salvataggi'],
  metadata: ['Metadata', 'Metadati'],
  different: ['Different', 'Diverso'],
  serverSettings: [
    'This file contains server settings, not a world save.',
    'Questo file contiene le impostazioni del server, non un salvataggio del mondo.',
  ],
  unsupported: [
    'This save header version is not supported.',
    'Questa versione del formato di salvataggio non è supportata.',
  ],
  name: ['Save details', 'Dettagli salvataggio'],
  session: ['Session', 'Sessione'],
  save: ['Save', 'Salvataggio'],
  map: ['Map', 'Mappa'],
  savedAt: ['Saved', 'Salvato'],
  duration: ['Play time (h:mm:ss)', 'Tempo di gioco (h:mm:ss)'],
  build: ['Game build', 'Build del gioco'],
  format: ['Save format', 'Formato salvataggio'],
  loading: ['Reading save details…', 'Lettura dettagli salvataggio…'],
  unavailable: [
    'Save details could not be read. The file may be incomplete or use an unsupported format.',
    'Impossibile leggere i dettagli. Il file potrebbe essere incompleto o usare un formato non supportato.',
  ],
};
export const satisfactoryViewerCatalogs = {
  en: Object.fromEntries(
    Object.entries(messages).map(([key, values]) => [
      `games.satisfactory.viewers.save.${key}`,
      values[0],
    ]),
  ),
  it: Object.fromEntries(
    Object.entries(messages).map(([key, values]) => [
      `games.satisfactory.viewers.save.${key}`,
      values[1],
    ]),
  ),
};
