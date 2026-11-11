const messages: Record<string, [string, string]> = {
  name: ['Log', 'Log'],
  refresh: ['Refresh', 'Aggiorna'],
  search: ['Filter lines', 'Filtra righe'],
  level: ['Level', 'Livello'],
  all: ['All levels', 'Tutti i livelli'],
  error: ['Errors', 'Errori'],
  warning: ['Warnings', 'Avvisi'],
  info: ['Other lines', 'Altre righe'],
  loading: ['Reading log…', 'Lettura log…'],
  unavailable: ['The log could not be read.', 'Impossibile leggere il log.'],
  tail: [
    'Showing the last 64 KiB. Filters apply to the loaded lines.',
    'Ultimi 64 KiB. I filtri si applicano alle righe caricate.',
  ],
  archiveLarge: [
    'This archived log is too large for this viewer. Extract it to inspect its tail.',
    'Questo log nell’archivio è troppo grande per il viewer. Estrailo per esaminarne la coda.',
  ],
  empty: ['No log lines.', 'Nessuna riga nel log.'],
  noMatches: ['No matching lines.', 'Nessuna riga corrispondente.'],
  previous: ['Previous', 'Precedente'],
  next: ['Next', 'Successiva'],
  range: ['Lines {start}–{end} of {total}', 'Righe {start}–{end} di {total}'],
};
export const satisfactoryLogCatalogs = {
  en: Object.fromEntries(
    Object.entries(messages).map(([k, v]) => [`games.satisfactory.viewers.log.${k}`, v[0]]),
  ),
  it: Object.fromEntries(
    Object.entries(messages).map(([k, v]) => [`games.satisfactory.viewers.log.${k}`, v[1]]),
  ),
};
