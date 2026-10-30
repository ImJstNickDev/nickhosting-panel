import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveContentStoragePath, runtimeStorageRoot } from './storage.js';

describe('logical content storage', () => {
  it('preserves container/default paths without consulting process or private environment', () => {
    expect(runtimeStorageRoot()).toBe(resolve('mountdata'));
    expect(resolveContentStoragePath('./mountdata/sources')).toBe(resolve('mountdata/sources'));
  });
  it('maps a logical path to one explicitly approved host root', () => {
    expect(
      resolveContentStoragePath('./mountdata/test-assets/m4-sources', {
        NH_MOUNTDATA_ROOT: '/mnt/test-volume/nickhosting',
      }),
    ).toBe('/mnt/test-volume/nickhosting/test-assets/m4-sources');
  });
  it('refuses roots or settings that could escape the designated directory', () => {
    for (const value of ['', '/', '.', ' bad', 'bad\nroot'])
      expect(() => runtimeStorageRoot({ NH_MOUNTDATA_ROOT: value })).toThrow();
    for (const value of [
      './mountdata',
      './mountdata/../outside',
      './mountdata/a/../../outside',
      '/mnt/test-volume/anything',
      './mountdata/./sources',
      './mountdata/sources\0',
    ])
      expect(() => resolveContentStoragePath(value)).toThrow();
  });
});
