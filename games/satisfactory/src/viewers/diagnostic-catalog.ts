const messages: Record<string, [string, string]> = {
  crash: ['Crash report', 'Report arresto anomalo'],
  certificate: ['Public certificate', 'Certificato pubblico'],
  certificateNumber: ['Certificate {number}', 'Certificato {number}'],
  loading: ['Reading metadata…', 'Lettura metadati…'],
  unavailable: [
    'This file could not be inspected. Use Open with to view the original file.',
    'Impossibile analizzare il file. Usa Apri con per visualizzare il file originale.',
  ],
  tooLarge: [
    'This file is too large for the metadata view. Use Open with to view the original file.',
    'Questo file è troppo grande per la vista metadati. Usa Apri con per visualizzare il file originale.',
  ],
  privateKey: [
    'Private keys are not shown in this viewer.',
    'Le chiavi private non vengono mostrate in questo visualizzatore.',
  ],
  empty: [
    'No supported crash details found.',
    'Nessun dettaglio di arresto anomalo supportato trovato.',
  ],
  CrashGUID: ['Crash ID', 'ID arresto anomalo'],
  CrashType: ['Crash type', 'Tipo di arresto anomalo'],
  ErrorMessage: ['Error', 'Errore'],
  GameName: ['Game', 'Gioco'],
  EngineVersion: ['Engine version', 'Versione motore'],
  BuildVersion: ['Build', 'Build'],
  BuildConfiguration: ['Build configuration', 'Configurazione build'],
  PlatformName: ['Platform', 'Piattaforma'],
  SecondsSinceStart: ['Seconds since startup', 'Secondi dall’avvio'],
  CallStack: ['Call stack', 'Stack di chiamate'],
  PCallStack: ['Portable call stack', 'Stack di chiamate portabile'],
  subject: ['Subject', 'Soggetto'],
  issuer: ['Issuer', 'Emittente'],
  serial: ['Serial number', 'Numero di serie'],
  notBefore: ['Valid from', 'Valido dal'],
  notAfter: ['Valid until', 'Valido fino al'],
  fingerprint: ['SHA-256 fingerprint', 'Impronta SHA-256'],
};
export const diagnosticViewerCatalog = {
  en: Object.fromEntries(
    Object.entries(messages).map(([key, value]) => [
      `games.satisfactory.viewers.diagnostic.${key}`,
      value[0],
    ]),
  ),
  it: Object.fromEntries(
    Object.entries(messages).map(([key, value]) => [
      `games.satisfactory.viewers.diagnostic.${key}`,
      value[1],
    ]),
  ),
};
