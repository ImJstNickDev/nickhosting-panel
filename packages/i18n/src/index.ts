import { type DomainErrorCode, safeError } from '@nickhosting/core';
import { en, it, type MessageKey } from './catalogs.js';

export { en, it, type MessageKey } from './catalogs.js';
export const supportedLocales = ['en', 'it'] as const;
export type Locale = (typeof supportedLocales)[number];
export type MessageParameters = Readonly<Record<string, string | number>>;
export type Catalog = Readonly<Record<string, string>>;

function supported(value: string | undefined | null): Locale | undefined {
  const base = value?.trim().toLowerCase().split(/[-_]/)[0];
  return base === 'en' || base === 'it' ? base : undefined;
}

/** Explicit account preference wins, then quality-sorted Accept-Language, then English. */
export function resolveLocale(
  preference?: string | null,
  acceptLanguage?: string | null,
  fallback?: string | null,
): Locale {
  const preferred = supported(preference);
  if (preferred) return preferred;
  const choices = (acceptLanguage ?? '')
    .split(',')
    .map((entry, index) => {
      const [tag, quality] = entry.trim().split(';');
      const q =
        quality === undefined
          ? 1
          : /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(quality.trim())
            ? Number(quality.trim().slice(2))
            : 0;
      return { locale: supported(tag), q, index };
    })
    .filter((choice) => choice.locale && choice.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return choices[0]?.locale ?? supported(fallback) ?? 'en';
}

function placeholders(message: string): string[] {
  return [
    ...new Set(
      [...message.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1] ?? ''),
    ),
  ].sort();
}

export function assertCatalogParity(source: Catalog, translated: Catalog): void {
  const sourceKeys = Object.keys(source).sort();
  if (JSON.stringify(sourceKeys) !== JSON.stringify(Object.keys(translated).sort()))
    throw new Error('catalog_key_mismatch');
  for (const key of sourceKeys) {
    const original = source[key];
    const localized = translated[key];
    if (
      !original ||
      !localized ||
      JSON.stringify(placeholders(original)) !== JSON.stringify(placeholders(localized))
    )
      throw new Error('catalog_placeholder_mismatch');
  }
}

function interpolate(message: string, parameters: MessageParameters): string {
  return message.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, key: string) => {
    const value = parameters[key];
    if (value === undefined) throw new Error('translation_parameter_missing');
    return String(value);
  });
}

/** Shared server catalogs; M6 can consume the same identifiers from its React catalog adapter. */
export class CatalogRegistry {
  private readonly catalogs: Record<Locale, Record<string, string>> = { en: {}, it: {} };

  register(namespace: string, catalogs: { en: Catalog; it: Catalog }): void {
    if (!/^[a-z][a-z0-9.-]*$/.test(namespace)) throw new Error('invalid_catalog_namespace');
    assertCatalogParity(catalogs.en, catalogs.it);
    for (const key of Object.keys(catalogs.en)) {
      if (!key.startsWith(`${namespace}.`) || Object.hasOwn(this.catalogs.en, key))
        throw new Error('invalid_catalog_key');
    }
    Object.assign(this.catalogs.en, catalogs.en);
    Object.assign(this.catalogs.it, catalogs.it);
  }

  translate(
    locale: string | null | undefined,
    key: string,
    parameters: MessageParameters = {},
  ): string {
    const chosen = resolveLocale(locale);
    const message = this.catalogs[chosen][key] ?? this.catalogs.en[key];
    if (!message) throw new Error('translation_key_missing');
    return interpolate(message, parameters);
  }
}

assertCatalogParity(en, it);
export const catalogs: Readonly<Record<Locale, Catalog>> = { en, it };

export function translate(
  locale: string | null | undefined,
  key: MessageKey,
  parameters: MessageParameters = {},
): string {
  const chosen = resolveLocale(locale);
  return interpolate(catalogs[chosen][key] ?? en[key], parameters);
}

export function localizeError(
  error: unknown,
  locale?: string | null,
): {
  code: DomainErrorCode;
  messageKey: `errors.${DomainErrorCode}`;
  message: string;
  status: number;
} {
  const safe = safeError(error);
  return { ...safe, message: translate(locale, safe.messageKey) };
}

const authErrorKeys: Readonly<Record<string, MessageKey>> = {
  INVITATION_INVALID: 'errors.invitation_invalid',
  invitation_invalid: 'errors.invitation_invalid',
  account_not_linked: 'auth.account_conflict',
  unable_to_link_account: 'auth.account_conflict',
  state_mismatch: 'auth.invalid_code',
  INVALID_EMAIL_OR_PASSWORD: 'auth.invalid_credentials',
  INVALID_PASSWORD: 'auth.invalid_credentials',
  USER_NOT_FOUND: 'auth.invalid_credentials',
  EMAIL_NOT_VERIFIED: 'auth.email_not_verified',
  USER_ALREADY_EXISTS: 'auth.account_conflict',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'auth.account_conflict',
  ACCOUNT_ALREADY_LINKED: 'auth.account_conflict',
  OAUTH_ACCOUNT_ALREADY_LINKED: 'auth.account_conflict',
  INVALID_TOKEN: 'auth.invalid_code',
  TOKEN_EXPIRED: 'auth.invalid_code',
  INVALID_TWO_FACTOR_COOKIE: 'auth.invalid_code',
  INVALID_CODE: 'auth.invalid_code',
  INVALID_BACKUP_CODE: 'auth.recovery_invalid',
  SESSION_EXPIRED: 'auth.session_expired',
  PASSWORD_TOO_SHORT: 'auth.password_too_short',
  PASSWORD_TOO_LONG: 'auth.password_too_long',
  SOCIAL_PROVIDER_NOT_FOUND: 'auth.oauth_unavailable',
  FAILED_TO_GET_USER_INFO: 'auth.oauth_unavailable',
  ACCOUNT_NOT_LINKED: 'auth.link_required',
  FRESH_SESSION_REQUIRED: 'auth.step_up_required',
  CHALLENGE_NOT_FOUND: 'auth.passkey_unavailable',
  AUTHENTICATION_FAILED: 'auth.passkey_unavailable',
  FAILED_TO_VERIFY_AUTHENTICATION: 'auth.passkey_unavailable',
  TOO_MANY_REQUESTS: 'errors.rate_limited',
  UNAUTHORIZED: 'errors.unauthenticated',
  FORBIDDEN: 'errors.forbidden',
};

/** Unknown provider errors never expose raw provider English messages or private metadata. */
export function localizeAuthError(
  code: string,
  locale?: string | null,
): { messageKey: MessageKey; message: string } {
  const key = authErrorKeys[code] ?? 'errors.internal_error';
  return { messageKey: key, message: translate(locale, key) };
}

export type MailKind = 'verify' | 'reset' | 'invite' | 'link';
export function renderMail(input: {
  kind: MailKind;
  locale?: string | null;
  url: string;
  instanceName: string;
}): { subject: string; text: string } {
  const url = new URL(input.url);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    /[\r\n]/.test(input.instanceName)
  )
    throw new Error('invalid_mail_parameters');
  const parameters = { instanceName: input.instanceName, url: input.url };
  return {
    subject: translate(input.locale, `mail.${input.kind}.subject`, parameters),
    text: translate(input.locale, `mail.${input.kind}.body`, parameters),
  };
}

export function formatNumber(
  value: number,
  locale?: string | null,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(resolveLocale(locale), options).format(value);
}
export function formatDateTime(
  value: Date,
  locale?: string | null,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(resolveLocale(locale), options).format(value);
}
export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  locale?: string | null,
): string {
  return new Intl.RelativeTimeFormat(resolveLocale(locale), { numeric: 'auto' }).format(
    value,
    unit,
  );
}
