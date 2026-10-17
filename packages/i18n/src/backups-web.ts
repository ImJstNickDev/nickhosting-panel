export const backupsWebMessages: Record<string, readonly [string, string]> = {
  'backup.integrationDefault': ['Game default', 'Impostazione del gioco'],
  'backup.scheduleStopWarning': [
    'Offline backups may temporarily stop the server. Restart depends on available resources.',
    'I backup a server spento possono arrestare temporaneamente il server. Il riavvio dipende dalle risorse disponibili.',
  ],
  'backup.retention': ['Remove older automatic backups', 'Elimina i backup automatici precedenti'],
  'backup.keepLast': ['Successful backups to keep', 'Backup riusciti da conservare'],
  'backup.retentionHelp': [
    'Only successful automatic backups from this schedule are removed. Locked backups are retained.',
    'Vengono eliminati solo i backup automatici riusciti di questa pianificazione. I backup bloccati vengono conservati.',
  ],
  'backup.defaultName': ['Backup · {date}', 'Backup · {date}'],
  'backup.saved': ['The backup was saved.', 'Il backup è stato salvato.'],
  'backup.resumeFailed': [
    'Server restart failed. Open the operation for details.',
    'Riavvio del server non riuscito. Apri l’operazione per i dettagli.',
  ],
  'backup.resumeSkipped': [
    'The server was not restarted. Open the operation to check why.',
    'Il server non è stato riavviato. Apri l’operazione per verificarne il motivo.',
  ],
  'backup.cleanupFailed': [
    'The server may still have backup preparation settings applied. Open the operation before continuing.',
    'Il server potrebbe mantenere le impostazioni applicate per preparare il backup. Apri l’operazione prima di continuare.',
  ],
  'backup.retentionFailed': [
    'Older backups could not be removed. Check the operation and available backup slots.',
    'Impossibile eliminare i backup precedenti. Controlla l’operazione e gli spazi di backup disponibili.',
  ],
  'backup.quota': ['{used} / {limit} backups', '{used} / {limit} backup'],
  'backup.refresh': ['Refresh backups', 'Aggiorna backup'],
  'backup.full': [
    'Backup limit reached. Delete a backup to free a slot.',
    'Limite di backup raggiunto. Elimina un backup per liberare uno spazio.',
  ],
  'backup.emptyHelp': [
    'Save a copy of your server files before making changes.',
    'Salva una copia dei file del server prima di modificarli.',
  ],
  'backup.name': ['Name (optional)', 'Nome (facoltativo)'],
  'backup.automaticName': ['Automatic name', 'Nome automatico'],
  'backup.serverDuring': ['Server during backup', 'Server durante il backup'],
  'backup.offline': ['Stop for the backup', 'Arresta durante il backup'],
  'backup.offlineHelp': [
    'Players will disconnect. Restart afterward depends on available resources.',
    'I giocatori verranno disconnessi. Il riavvio al termine del backup dipende dalle risorse disponibili.',
  ],
  'backup.live': ['Keep running', 'Mantieni in esecuzione'],
  'backup.liveHelp': [
    'Files can change during the backup. The copy may be inconsistent.',
    'I file possono cambiare durante il backup. La copia potrebbe non essere coerente.',
  ],
  'backup.protect': [
    'Lock this backup against deletion',
    'Blocca questo backup per impedirne l’eliminazione',
  ],
  'backup.advanced': ['Advanced options', 'Opzioni avanzate'],
  'backup.excluded': ['Excluded files', 'File esclusi'],
  'backup.excludedHelp': [
    'One relative path or pattern per line. These files will not be included in this backup.',
    'Un percorso relativo o un pattern per riga. Questi file non saranno inclusi nel backup.',
  ],
  'backup.createOperation': ['Backup', 'Backup'],
  'backup.restoreOperation': ['Restore', 'Ripristino'],
  'backup.locked': ['Locked', 'Bloccato'],
  'backup.rename': ['Rename {name}', 'Rinomina {name}'],
  'backup.download': ['Download {name}', 'Scarica {name}'],
  'backup.restore': ['Restore {name}', 'Ripristina {name}'],
  'backup.lock': ['Lock {name}', 'Blocca {name}'],
  'backup.unlock': ['Unlock {name}', 'Sblocca {name}'],
  'backup.delete': ['Delete {name}', 'Elimina {name}'],
  'backup.unlockToDelete': [
    'Unlock this backup before deleting it',
    'Sblocca il backup prima di eliminarlo',
  ],
  'backup.operationBusy': [
    'Wait for the current operation to finish',
    'Attendi il termine dell’operazione in corso',
  ],
  'backup.deleteTitle': ['Delete backup?', 'Eliminare il backup?'],
  'backup.deleteHelp': [
    'This copy will be permanently deleted. Current server files will remain unchanged.',
    'Questa copia verrà eliminata definitivamente. I file attuali del server non verranno modificati.',
  ],
  'backup.renameTitle': ['Rename backup', 'Rinomina backup'],
  'backup.restoreAction': ['Restore', 'Ripristina'],
  'backup.restoreFiles': ['Existing files', 'File esistenti'],
  'backup.replace': ['Replace all files', 'Sostituisci tutti i file'],
  'backup.replaceHelp': [
    'Delete current server files, then restore the backup.',
    'Elimina i file attuali del server, poi ripristina il backup.',
  ],
  'backup.preserve': ['Keep extra files', 'Mantieni i file aggiuntivi'],
  'backup.preserveHelp': [
    'Overwrite matching files. Keep files that are not in the backup.',
    'Sovrascrivi i file con lo stesso percorso. Mantieni quelli non presenti nel backup.',
  ],
  'backup.beforeRestore': [
    'Back up current files before restoring',
    'Esegui un backup dei file attuali prima del ripristino',
  ],
  'backup.beforeRestoreFull': [
    'Free a backup slot to save the current files first.',
    'Libera uno spazio di backup per salvare prima i file attuali.',
  ],
  'backup.restoreStopped': [
    'The server will stay stopped after restoring.',
    'Il server rimarrà arrestato dopo il ripristino.',
  ],
};
