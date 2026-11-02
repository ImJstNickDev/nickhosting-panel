const entries: Record<string, [string, string]> = {
  title: ['FICSIT Overview', 'Panoramica FICSIT'],
  live: ['Live', 'Live'],
  snapshot: ['Saved state', 'Stato salvato'],
  lastUpdated: ['Last updated {time}', 'Ultimo aggiornamento {time}'],
  justNow: ['just now', 'ora'],
  unavailable: [
    'No world observation available yet.',
    'Nessuna osservazione del mondo ancora disponibile.',
  ],
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
