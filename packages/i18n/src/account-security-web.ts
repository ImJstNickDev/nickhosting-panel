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
