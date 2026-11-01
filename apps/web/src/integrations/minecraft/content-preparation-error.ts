import { domainErrorCodes } from '../../../../../packages/core/src/errors.js';
import { apiError } from '../../api/client.js';

const codes = new Set<string>(domainErrorCodes);

/** Persisted jobs expose codes; foreground requests expose the same localized API error. */
export function contentPreparationErrorKey(error: unknown): string {
  if (typeof error === 'string') {
    if (codes.has(error)) return `errors.${error}`;
    if (error === 'client_only') return 'games.minecraft.mods.incompatibility.client-only';
    return 'web.errors.request';
  }
  const normalized = apiError(error);
  return normalized.messageKey === 'web.errors.request' &&
    normalized.code !== 'internal_error' &&
    codes.has(normalized.code)
    ? `errors.${normalized.code}`
    : normalized.messageKey;
}
