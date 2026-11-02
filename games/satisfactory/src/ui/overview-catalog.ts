const entries: Record<string, [string, string]> = {
  title: ['Overview', 'Panoramica'],
  live: ['Live server observation', 'Osservazione del server in tempo reale'],
  snapshot: [
    'Last known world state. These values are historical; they do not indicate current players or performance.',
    'Ultimo stato noto del mondo. Questi valori sono storici: non indicano giocatori o prestazioni attuali.',
  ],
  unavailable: [
    'No world observation available yet.',
    'Nessuna osservazione del mondo ancora disponibile.',
  ],
  observedAt: ['Observed at', 'Rilevato il'],
  tier: ['Technology tier', 'Tier tecnologico'],
  phase: ['Game phase', 'Fase di gioco'],
  schematic: ['Active schematic', 'Schema attivo'],
  duration: ['Play time (hours)', 'Tempo di gioco (ore)'],
  paused: ['Paused', 'In pausa'],
  running: ['World loaded', 'Mondo caricato'],
  yes: ['Yes', 'Sì'],
  no: ['No', 'No'],
  refresh: ['Refresh', 'Aggiorna'],
};
export const satisfactoryOverviewCatalogs = {
  en: Object.fromEntries(
    Object.entries(entries).map(([key, pair]) => [`games.satisfactory.overview.${key}`, pair[0]]),
  ),
  it: Object.fromEntries(
    Object.entries(entries).map(([key, pair]) => [`games.satisfactory.overview.${key}`, pair[1]]),
  ),
};
