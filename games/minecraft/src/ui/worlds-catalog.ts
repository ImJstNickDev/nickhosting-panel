/** Minecraft Worlds owns its complete English/Italian vocabulary. */
export const minecraftWorldsMessages: Record<string, [string, string]> = {
  'worlds.caseCollision': [
    'A folder named {name} already exists. Use that exact name to replace it, or choose a different name.',
    'Esiste già una cartella chiamata {name}. Usa lo stesso nome per sostituirla oppure scegli un nome diverso.',
  ],
  'worlds.cannotChange': [
    'This world is not verified for the server version.',
    'Questo mondo non è verificato per la versione del server.',
  ],
  'worlds.configured': [
    'Selected world: {name}. This folder is not listed.',
    'Mondo selezionato: {name}. Questa cartella non è elencata.',
  ],
  'worlds.search': ['Search worlds', 'Cerca mondi'],
  'worlds.refresh': ['Refresh worlds', 'Aggiorna mondi'],
  'worlds.refreshing': ['Refreshing worlds…', 'Aggiornamento dei mondi…'],
  'worlds.import': ['Import world', 'Importa mondo'],
  'worlds.select': ['Select world', 'Seleziona mondo'],
  'worlds.delete': ['Delete world', 'Elimina mondo'],
  'worlds.replace': ['Replace world', 'Sostituisci mondo'],
  'worlds.download': ['Download ZIP', 'Scarica ZIP'],
  'worlds.actionFor': ['{action}: {name}', '{action}: {name}'],
  'worlds.selected': ['Selected', 'Selezionato'],
  'worlds.status.verified': ['Compatible', 'Compatibile'],
  'worlds.status.incompatible': ['Incompatible version', 'Versione incompatibile'],
  'worlds.status.unavailable': ['Not verified', 'Non verificato'],
  'worlds.selectedCannotDelete': [
    'Select another world before deleting this one.',
    'Seleziona un altro mondo prima di eliminare questo.',
  ],
  'worlds.empty': ['No saved worlds found.', 'Nessun mondo salvato trovato.'],
  'worlds.noMatches': ['No worlds match your search.', 'Nessun mondo corrisponde alla ricerca.'],
  'worlds.unavailable': [
    'World information is unavailable. Refresh to check again.',
    'Informazioni sui mondi non disponibili. Aggiorna per riprovare.',
  ],
  'worlds.notInstalled': [
    'Install the server to manage worlds.',
    'Installa il server per gestire i mondi.',
  ],
  'worlds.unsupported': [
    'World management is unavailable for this version.',
    'La gestione dei mondi non è disponibile per questa versione.',
  ],
  'worlds.stopFirst': [
    'Stop the server before changing or downloading worlds.',
    'Arresta il server prima di modificare o scaricare i mondi.',
  ],
  'worlds.stateUnknown': [
    'Wait for the server to be confirmed offline before changing or downloading worlds.',
    'Attendi che il server risulti offline prima di modificare o scaricare i mondi.',
  ],
  'worlds.readOnly': [
    'You have read-only access to worlds.',
    'Hai accesso in sola lettura ai mondi.',
  ],
  'worlds.compatibilityUnavailable': [
    'Version compatibility cannot be checked. World changes are unavailable.',
    'Impossibile verificare la compatibilità della versione. Modifiche ai mondi non disponibili.',
  ],
  'worlds.selectionUnknown': [
    'The selected world could not be determined.',
    'Impossibile determinare il mondo selezionato.',
  ],
  'worlds.uncertain': [
    'The request outcome is unknown. Recover the same request before making another change.',
    'Esito della richiesta sconosciuto. Recupera la stessa richiesta prima di apportare altre modifiche.',
  ],
  'worlds.recover': ['Recover request', 'Recupera richiesta'],
  'worlds.zip': ['World ZIP', 'ZIP del mondo'],
  'worlds.chooseZip': ['Choose ZIP', 'Scegli ZIP'],
  'worlds.changeZip': ['Change ZIP', 'Cambia ZIP'],
  'worlds.dropZip': ['or drop one world ZIP here', 'oppure trascina qui uno ZIP del mondo'],
  'worlds.invalidZip': ['Choose one non-empty ZIP file.', 'Scegli un solo file ZIP non vuoto.'],
  'worlds.folder': ['Folder name', 'Nome cartella'],
  'worlds.folderHint': [
    '1–64 letters, numbers, hyphens or underscores. Start with a letter or number.',
    'Da 1 a 64 lettere, numeri, trattini o trattini bassi. Inizia con una lettera o un numero.',
  ],
  'worlds.hashing': ['Checking file…', 'Verifica del file…'],
  'worlds.uploading': ['Uploading ZIP…', 'Caricamento dello ZIP…'],
  'worlds.checking': [
    'Waiting for upload verification…',
    'In attesa della verifica del caricamento…',
  ],
  'worlds.cancelUpload': ['Cancel upload', 'Annulla caricamento'],
  'worlds.cancelled': [
    'Upload cancelled. Choose the ZIP again to continue.',
    'Caricamento annullato. Scegli di nuovo lo ZIP per continuare.',
  ],
  'worlds.uploaded': [
    'ZIP uploaded. Import it to add the world.',
    'ZIP caricato. Importalo per aggiungere il mondo.',
  ],
  'worlds.existing': [
    '{name} already exists. Continuing will ask you to confirm its replacement.',
    '{name} esiste già. Continuando dovrai confermarne la sostituzione.',
  ],
  'worlds.reviewReplacement': ['Review replacement', 'Rivedi sostituzione'],
  'worlds.confirm.select': ['Use {name} on {server}?', 'Vuoi usare {name} su {server}?'],
  'worlds.nextStart': [
    'The world changes at the next start. The server stays stopped.',
    'Il mondo cambia al prossimo avvio. Il server resta arrestato.',
  ],
  'worlds.confirm.delete': [
    'Delete the {name} world folder from {server}? Its saved world data will be removed.',
    'Vuoi eliminare la cartella del mondo {name} da {server}? I suoi dati salvati saranno rimossi.',
  ],
  'worlds.confirm.replace': [
    'Replace the {name} world folder on {server} with this ZIP? Its existing world data will be removed.',
    'Vuoi sostituire la cartella del mondo {name} su {server} con questo ZIP? I dati del mondo esistente saranno rimossi.',
  ],
  'worlds.backup': ['Create a verified backup first', 'Crea prima un backup verificato'],
  'worlds.pagination': ['World pages', 'Pagine mondi'],
  'worlds.previous': ['Previous', 'Precedente'],
  'worlds.next': ['Next', 'Successiva'],
  'worlds.page': ['{page} of {total}', '{page} di {total}'],
};
