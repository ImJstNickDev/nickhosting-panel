import { randomUUID } from 'node:crypto';

export const usernamePattern = /^[a-z0-9][a-z0-9_-]{2,39}$/;

/** Generated handles never depend on display names, email addresses, or provider labels. */
export function generatedUsername(): string {
  return `user_${randomUUID().replaceAll('-', '')}`;
}
