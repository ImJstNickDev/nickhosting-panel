const messages: Record<string, [string, string]> = {
  name: ['Log', 'Log'],
  refresh: ['Refresh', 'Aggiorna'],
  search: ['Search log', 'Cerca nel log'],
  level: ['Level', 'Livello'],
  all: ['All levels', 'Tutti i livelli'],
  error: ['Errors', 'Errori'],
  warning: ['Warnings', 'Avvisi'],
  info: ['Other lines', 'Altre righe'],
  loading: ['Reading log…', 'Lettura log…'],
  unavailable: ['The log could not be read.', 'Impossibile leggere il log.'],
  encoding: ['This log is not valid UTF-8 text.', 'Questo log non contiene testo UTF-8 valido.'],
  lineTooLarge: [
    'A log line exceeds the supported size.',
    'Una riga del log supera la dimensione supportata.',
  ],
  budget: [
    'This log exceeds the viewer processing limit.',
    'Questo log supera il limite di elaborazione del viewer.',
  ],
  tooLarge: [
    'This log exceeds the configured viewer size limit.',
    'Questo log supera il limite di dimensione configurato per il viewer.',
  ],
  changed: [
    'The log changed while it was being read. Try again.',
    'Il log è cambiato durante la lettura. Riprova.',
  ],
  archiveLarge: [
    'This archived log is too large for this viewer. Extract it to search the complete log.',
    'Questo log nell’archivio è troppo grande per il viewer. Estrailo per cercare nel log completo.',
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
