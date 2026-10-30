/** Minecraft Worlds owns its complete English/Italian vocabulary. */
export const minecraftWorldsMessages: Record<string, [string, string]> = {
  'worlds.caseCollision': [
    'A folder named {name} already exists. Use that exact name to replace it, or choose a different name.',
    'Esiste già una cartella chiamata {name}. Usa lo stesso nome per sostituirla oppure scegli un nome diverso.',
  ],
  'worlds.liveCollision': [
    '{name} already exists or is the active world. Choose a different folder name while the server is running.',
    '{name} esiste già o è il mondo attivo. Scegli un nome diverso mentre il server è acceso.',
  ],
  'worlds.cannotChange': [
    'This world is not verified for the server version.',
    'Questo mondo non è verificato per la versione del server.',
  ],
  'worlds.cannotDelete': [
    'World metadata could not be read. Use Files to inspect this folder.',
    'Impossibile leggere i metadati del mondo. Controlla questa cartella in File.',
  ],
  'worlds.configured': [
    'Selected world: {name}. This folder is not listed.',
    'Mondo selezionato: {name}. Questa cartella non è elencata.',
  ],
  'worlds.catalog.browse': ['Find worlds', 'Trova mondi'],
  'worlds.catalog.search': ['Search CurseForge worlds', 'Cerca mondi su CurseForge'],
  'worlds.catalog.files': ['Files for {name}', 'File di {name}'],
  'worlds.catalog.back': ['Back to results', 'Torna ai risultati'],
  'worlds.catalog.view': ['View project', 'Apri progetto'],
  'worlds.catalog.choose': ['Use this file', 'Usa questo file'],
  'worlds.catalog.downloading': ['Downloading world…', 'Download del mondo…'],
  'worlds.catalog.unavailable': [
    'Automatic download is not available for this file.',
    'Download automatico non disponibile per questo file.',
  ],
  'worlds.catalog.notConfigured': [
    'CurseForge is not configured. Ask the Owner to check the API key and content download settings.',
    'CurseForge non è configurato. Chiedi all’Owner di controllare la chiave API e le impostazioni di download dei contenuti.',
  ],
  'worlds.catalog.empty': ['No worlds found.', 'Nessun mondo trovato.'],
  'worlds.catalog.noFiles': [
    'No downloadable world files found.',
    'Nessun file mondo scaricabile trovato.',
  ],
  'worlds.catalog.otherVersion': [
    'Declared for Minecraft {versions}. This server uses {current}.',
    'Dichiarato per Minecraft {versions}. Questo server usa {current}.',
  ],
  'worlds.catalog.versionUnknown': [
    'Minecraft version not specified',
    'Versione Minecraft non specificata',
  ],
  'worlds.catalog.external': [
    'Open MinecraftMaps in a new tab, then import the downloaded ZIP.',
    'Apri MinecraftMaps in una nuova scheda, poi importa lo ZIP scaricato.',
  ],
  'worlds.catalog.ready': [
    'World downloaded. Import it to add it to the server.',
    'Mondo scaricato. Importalo per aggiungerlo al server.',
  ],
  'worlds.catalog.loading': ['Loading worlds', 'Caricamento dei mondi'],
  'worlds.search': ['Search worlds', 'Cerca mondi'],
  'worlds.refresh': ['Refresh worlds', 'Aggiorna mondi'],
  'worlds.refreshing': ['Refreshing worlds…', 'Aggiornamento dei mondi…'],
  'worlds.import': ['Import world', 'Importa mondo'],
  'worlds.importing': ['Importing world…', 'Importazione del mondo…'],
  'worlds.transferredFiles': ['{completed} of {total} files', '{completed} di {total} file'],
  'worlds.select': ['Select world', 'Seleziona mondo'],
  'worlds.delete': ['Delete world', 'Elimina mondo'],
  'worlds.replace': ['Replace world', 'Sostituisci mondo'],
  'worlds.download': ['Download ZIP', 'Scarica ZIP'],
  'worlds.actionFor': ['{action}: {name}', '{action}: {name}'],
  'worlds.selected': ['Selected', 'Selezionato'],
  'worlds.status.verified': ['Compatible', 'Compatibile'],
  'worlds.status.incompatible': ['Incompatible version', 'Versione incompatibile'],
  'worlds.status.unknown': ['Compatibility unknown', 'Compatibilità sconosciuta'],
  'worlds.status.invalid': ['Invalid world data', 'Dati del mondo non validi'],
  'worlds.status.unavailable': ['Metadata unavailable', 'Metadati non disponibili'],
  'worlds.versionUnknown': ['Version unknown', 'Versione sconosciuta'],
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
    'Stop the server to select, replace, download or back up a world.',
    'Arresta il server per selezionare, sostituire, scaricare o eseguire il backup di un mondo.',
  ],
  'worlds.stateUnknown': [
    'Wait for the server to finish starting or stopping before importing a world.',
    'Attendi il termine dell’avvio o dell’arresto del server prima di importare un mondo.',
  ],
  'worlds.readOnly': [
    'You have read-only access to worlds.',
    'Hai accesso in sola lettura ai mondi.',
  ],
  'worlds.compatibilityUnavailable': [
    'Version compatibility cannot be checked. Worlds can be imported, but cannot be selected.',
    'Impossibile verificare la compatibilità della versione. Puoi importare mondi, ma non selezionarli.',
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
  'worlds.source': ['World source', 'Sorgente del mondo'],
  'worlds.chooseFolder': ['Choose folder', 'Scegli cartella'],
  'worlds.worldFolder': ['World folder', 'Cartella del mondo'],
  'worlds.preparing': ['Preparing folder…', 'Preparazione della cartella…'],
  'worlds.invalidFolder': [
    'Choose the world folder containing level.dat.',
    'Scegli la cartella del mondo contenente level.dat.',
  ],
  'worlds.folderLimit': [
    'This folder exceeds the import size or file-count limit.',
    'Questa cartella supera il limite di dimensione o numero di file per l’importazione.',
  ],
  'worlds.folderFailed': [
    'The folder could not be prepared. Choose it again to retry.',
    'Impossibile preparare la cartella. Selezionala di nuovo per riprovare.',
  ],
  'worlds.zip': ['World ZIP', 'ZIP del mondo'],
  'worlds.chooseZip': ['Choose ZIP', 'Scegli ZIP'],
  'worlds.dropZip': ['or drop one world ZIP here', 'oppure trascina qui uno ZIP del mondo'],
  'worlds.invalidZip': ['Choose one non-empty ZIP file.', 'Scegli un solo file ZIP non vuoto.'],
  'worlds.folder': ['Folder name', 'Nome cartella'],
  'worlds.folderHint': [
    '1–64 letters, numbers, hyphens or underscores. Start with a letter or number.',
    'Da 1 a 64 lettere, numeri, trattini o trattini bassi. Inizia con una lettera o un numero.',
  ],
  'worlds.hashing': ['Checking file…', 'Verifica del file…'],
  'worlds.uploading': ['Uploading world…', 'Caricamento del mondo…'],
  'worlds.checking': [
    'Waiting for upload verification…',
    'In attesa della verifica del caricamento…',
  ],
  'worlds.cancelUpload': ['Cancel upload', 'Annulla caricamento'],
  'worlds.cancelled': [
    'Upload cancelled. Choose the ZIP or folder again to continue.',
    'Caricamento annullato. Scegli di nuovo lo ZIP o la cartella per continuare.',
  ],
  'worlds.uploaded': [
    'World uploaded. Import it to add it to the server.',
    'Mondo caricato. Importalo per aggiungerlo al server.',
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
    'Replace the {name} world folder on {server} with the imported world? Its existing world data will be removed.',
    'Vuoi sostituire la cartella del mondo {name} su {server} con il mondo importato? I dati del mondo esistente saranno rimossi.',
  ],
  'worlds.backup': ['Create a verified backup first', 'Crea prima un backup verificato'],
  'worlds.pagination': ['World pages', 'Pagine mondi'],
  'worlds.previous': ['Previous', 'Precedente'],
  'worlds.next': ['Next', 'Successiva'],
  'worlds.page': ['{page} of {total}', '{page} di {total}'],
};
