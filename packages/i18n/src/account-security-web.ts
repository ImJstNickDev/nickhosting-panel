export const accountSecurityWebMessages: Record<string, readonly [string, string]> = {
  'accountSecurity.repeatNewPassword': ['Repeat new password', 'Ripeti nuova password'],
  'accountSecurity.passwordMismatch': [
    'The new passwords do not match.',
    'Le nuove password non coincidono.',
  ],
  'accountSecurity.signInAgain': ['Sign in again', 'Accedi di nuovo'],
  'accountSecurity.passwordSessions': [
    'Changing your password signs out your other sessions.',
    'Cambiare la password disconnette le altre sessioni.',
  ],
  'accountSecurity.noPasskeys': ['No passkeys added', 'Nessuna passkey aggiunta'],
  'accountSecurity.passkeyFallback': ['Passkey', 'Passkey'],
  'accountSecurity.renamePasskey': ['Rename passkey: {name}', 'Rinomina passkey: {name}'],
  'accountSecurity.removePasskey': ['Remove passkey: {name}', 'Rimuovi passkey: {name}'],
  'accountSecurity.removePasskeyTitle': ['Remove this passkey?', 'Rimuovere questa passkey?'],
  'accountSecurity.removePasskeyHint': [
    'You will no longer be able to sign in with {name}.',
    'Non potrai più accedere con {name}.',
  ],
  'accountSecurity.disableTotp': [
    'Disable two-factor authentication',
    'Disattiva autenticazione a due fattori',
  ],
  'accountSecurity.disableTotpHint': [
    'Sign-in will no longer require an authenticator code. Existing recovery codes will stop working.',
    'L’accesso non richiederà più il codice dell’autenticatore. I codici di recupero esistenti non funzioneranno più.',
  ],
  'accountSecurity.replaceCodesHint': [
    'The new codes replace your existing recovery codes.',
    'I nuovi codici sostituiscono quelli di recupero esistenti.',
  ],
  'accountSecurity.setupProgress': ['Two-factor setup', 'Attivazione a due fattori'],
  'accountSecurity.confirmStep': ['Confirm identity', 'Conferma identità'],
  'accountSecurity.authenticatorStep': ['Authenticator', 'Autenticatore'],
  'accountSecurity.confirmSetup': ['Confirm it’s you', 'Conferma la tua identità'],
  'accountSecurity.confirmHint': [
    'You’ll need an authenticator app to generate sign-in codes.',
    'Ti servirà un’app di autenticazione per generare i codici di accesso.',
  ],
  'accountSecurity.continue': ['Continue', 'Continua'],
  'accountSecurity.connectAuthenticator': ['Connect your authenticator', 'Collega l’autenticatore'],
  'accountSecurity.qrLabel': ['Authenticator QR code', 'Codice QR per l’autenticatore'],
  'accountSecurity.scanHint': [
    'Add an account in your authenticator app and scan this QR code.',
    'Aggiungi un account nell’app di autenticazione e scansiona questo codice QR.',
  ],
  'accountSecurity.manualKey': ['Enter key manually', 'Inserisci la chiave manualmente'],
  'accountSecurity.manualFallback': [
    'The QR code could not load. Enter the setup key in your authenticator app.',
    'Il codice QR non è disponibile. Inserisci la chiave nell’app di autenticazione.',
  ],
  'accountSecurity.copyKey': ['Copy setup key', 'Copia chiave di configurazione'],
  'accountSecurity.codeHint': [
    'Enter the six-digit code shown in the app.',
    'Inserisci il codice a sei cifre mostrato nell’app.',
  ],
  'accountSecurity.verifyEnable': ['Verify and enable', 'Verifica e attiva'],
  'accountSecurity.setupLater': ['Set up later', 'Configura più tardi'],
  'accountSecurity.resumeSetup': ['Resume setup', 'Riprendi configurazione'],
  'accountSecurity.saveCodes': ['Save your recovery codes', 'Conserva i codici di recupero'],
  'accountSecurity.saveCodesHint': [
    'Keep them somewhere private. Use one if you lose access to your authenticator. Each code works once.',
    'Conservali in un posto sicuro. Ti serviranno se perdi l’accesso all’autenticatore. Ogni codice funziona una sola volta.',
  ],
  'accountSecurity.downloadCodes': ['Download recovery codes', 'Scarica codici di recupero'],
  'accountSecurity.done': ['Done', 'Fine'],
  'accountSecurity.copyFailed': [
    'Couldn’t copy. Select the text and copy it manually.',
    'Copia non riuscita. Seleziona il testo e copialo manualmente.',
  ],
  'accountSecurity.copyCodes': ['Copy recovery codes', 'Copia codici di recupero'],
  'accountSecurity.revokeSessionTitle': [
    'Sign out this session?',
    'Disconnettere questa sessione?',
  ],
  'accountSecurity.revokeSessionHint': [
    'This browser will need to sign in again.',
    'Questo browser dovrà accedere di nuovo.',
  ],
  'accountSecurity.revokeOthersTitle': [
    'Sign out other sessions?',
    'Disconnettere le altre sessioni?',
  ],
  'accountSecurity.revokeOthersHint': [
    'Your current session stays signed in.',
    'La sessione attuale resterà connessa.',
  ],
  'accountSecurity.sessionDates': ['Signed in', 'Accesso'],
  'accountSecurity.sessionDetails': ['Session details', 'Dettagli sessione'],
};
