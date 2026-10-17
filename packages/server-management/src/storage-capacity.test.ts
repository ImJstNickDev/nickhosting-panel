import { describe, expect, it } from 'vitest';
import { assertServerStorageCapacity, serverStorageLimitBytes } from './storage-capacity.js';

describe('server disk quotas are distinct from bounded transfer budgets', () => {
  it('represents unlimited explicitly without inventing a finite fallback', () => {
    expect(serverStorageLimitBytes(0)).toBeNull();
    expect(() => assertServerStorageCapacity(0, 4 * 1024 ** 4)).not.toThrow();
  });
  it('preserves finite quota boundaries and rejects unsafe capacity arithmetic', () => {
    expect(serverStorageLimitBytes(1024)).toBe(1024 ** 3);
    expect(() => assertServerStorageCapacity(1, 1_048_576)).not.toThrow();
    expect(() => assertServerStorageCapacity(1, 1_048_577)).toThrow();
    for (const value of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER])
      expect(() => serverStorageLimitBytes(value)).toThrow();
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      expect(() => assertServerStorageCapacity(0, value)).toThrow();
  });
});
