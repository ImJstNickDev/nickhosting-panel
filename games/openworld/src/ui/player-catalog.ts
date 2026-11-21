const messages: Record<string, [string, string]> = {
  search: ['Search players by name or UUID', 'Cerca giocatori per nome o UUID'],
  observedCount: [
    '{count, plural, one {# connection observed} other {# connections observed}}',
    '{count, plural, one {# connessione osservata} other {# connessioni osservate}}',
  ],
  observed: ['Seen', 'Osservato'],
  all: ['All players', 'Tutti i giocatori'],
  serverGallery: ['Server screenshots', 'Screenshot del server'],
  personalGallery: ['Player screenshots', 'Screenshot del giocatore'],
  unassigned: ['Unassigned', 'Senza attribuzione'],
  saved: ['Saved', 'Salvato'],
  offlinePlayer: ['Offline', 'Offline'],
  source: ['Profile source', 'Fonte del profilo'],
  chooseSession: ['Choose a connection', 'Scegli una connessione'],
  sessions: ['Player sessions', 'Sessioni dei giocatori'],
  sessionId: ['Connection #{id}', 'Connessione n. {id}'],
  guest: ['Guest', 'Ospite'],
  details: ['Position and identity', 'Posizione e identità'],
  lastSaveAt: ['Saved {time}', 'Salvato il {time}'],
  lastVisitAt: ['Last visit {time}', 'Ultima visita il {time}'],
  playerGalleryEmpty: [
    'No screenshots attributed to this player.',
    'Nessuno screenshot attribuito a questo giocatore.',
  ],
  noPlayersYet: ['No players found.', 'Nessun giocatore trovato.'],
  vitalStats: ['Vitals', 'Parametri vitali'],
  saveDetails: ['Last save', 'Ultimo salvataggio'],
};
const catalog = (index: 0 | 1) =>
  Object.fromEntries(
    Object.entries(messages).map(([key, pair]) => [`games.openworld.people.${key}`, pair[index]]),
  );
export const openworldPlayerCatalogs = { en: catalog(0), it: catalog(1) };
