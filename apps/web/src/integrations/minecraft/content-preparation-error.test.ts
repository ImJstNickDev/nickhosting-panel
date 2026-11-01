import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client.js';
import { contentPreparationErrorKey } from './content-preparation-error.js';

describe('content preparation failure messages', () => {
  it('uses the same public reason for persisted job codes and foreground API errors', () => {
    for (const code of ['resources_unavailable', 'content_storage_unavailable', 'rate_limited']) {
      expect(contentPreparationErrorKey(code)).toBe(`errors.${code}`);
      expect(contentPreparationErrorKey(new ApiError(code, `errors.${code}`))).toBe(
        `errors.${code}`,
      );
      expect(contentPreparationErrorKey({ code })).toBe(`errors.${code}`);
    }
  });
  it('preserves the client-only explanation and never displays private provider messages', () => {
    expect(contentPreparationErrorKey('client_only')).toBe(
      'games.minecraft.mods.incompatibility.client-only',
    );
    expect(contentPreparationErrorKey('Download denied: https://private.test/token')).toBe(
      'web.errors.request',
    );
    expect(contentPreparationErrorKey(new Error('secret diagnostic'))).toBe('web.errors.request');
  });
});
