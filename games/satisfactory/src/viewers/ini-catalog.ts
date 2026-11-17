const messages: Record<string, [string, string]> = {
  name: ['Unreal INI', 'INI Unreal'],
  loading: ['Reading configuration…', 'Lettura configurazione…'],
  unavailable: [
    'The configuration could not be read. Open the text editor to inspect the file.',
    'Impossibile leggere la configurazione. Apri l’editor di testo per esaminare il file.',
  ],
  tooLarge: [
    'This file is too large for the structured view. Open it in the text editor.',
    'Questo file è troppo grande per la vista strutturata. Aprilo nell’editor di testo.',
  ],
  empty: ['This configuration file is empty.', 'Questo file di configurazione è vuoto.'],
  textEditor: ['Open text editor', 'Apri editor di testo'],
  line: ['Line', 'Riga'],
  setting: ['Setting', 'Impostazione'],
  value: ['Value', 'Valore'],
  append: ['Add if absent', 'Aggiungi se assente'],
  duplicate: ['Add, including duplicates', 'Aggiungi, anche duplicati'],
  remove: ['Remove matching value', 'Rimuovi valore corrispondente'],
  clear: ['Clear array', 'Svuota array'],
  unrecognized: ['Unrecognized line', 'Riga non riconosciuta'],
  previous: ['Previous', 'Precedente'],
  next: ['Next', 'Successiva'],
  range: ['Lines {start}–{end} of {total}', 'Righe {start}–{end} di {total}'],
};
export const satisfactoryIniCatalogs = {
  en: Object.fromEntries(
    Object.entries(messages).map(([key, values]) => [
      `games.satisfactory.viewers.ini.${key}`,
      values[0],
    ]),
  ),
  it: Object.fromEntries(
    Object.entries(messages).map(([key, values]) => [
      `games.satisfactory.viewers.ini.${key}`,
      values[1],
    ]),
  ),
};
