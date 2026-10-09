export const domainErrorCodes = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'invitation_invalid',
  'invitation_expired',
  'invitation_revoked',
  'invitation_exhausted',
  'setup_completed',
  'setup_token_invalid',
  'support_invalid',
  'support_expired',
  'configuration_invalid',
  'secret_invalid',
  'integration_unavailable',
  'internal_error',
] as const;

export type DomainErrorCode = (typeof domainErrorCodes)[number];

const defaultStatuses: Record<DomainErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  invitation_invalid: 400,
  invitation_expired: 410,
  invitation_revoked: 410,
  invitation_exhausted: 409,
  setup_completed: 409,
  setup_token_invalid: 403,
  support_invalid: 403,
  support_expired: 403,
  configuration_invalid: 400,
  secret_invalid: 500,
  integration_unavailable: 503,
  internal_error: 500,
};

/** Only code/messageKey are public. Details are diagnostic and must be redacted. */
export class DomainError extends Error {
  readonly messageKey: `errors.${DomainErrorCode}`;

  constructor(
    readonly code: DomainErrorCode,
    readonly status = defaultStatuses[code],
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(code);
    this.name = 'DomainError';
    this.messageKey = `errors.${code}`;
  }
}

export function safeError(error: unknown): {
  code: DomainErrorCode;
  messageKey: `errors.${DomainErrorCode}`;
  status: number;
} {
  const known = error instanceof DomainError ? error : new DomainError('internal_error');
  return { code: known.code, messageKey: known.messageKey, status: known.status };
}
