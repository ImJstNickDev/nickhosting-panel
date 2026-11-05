import { describe, expect, it } from 'vitest';
import {
  resolveSatisfactoryModLimits,
  satisfactoryModLimitsSchema,
  satisfactoryModWorkingHeadroomBytes,
} from './mods-limits.js';

describe('Satisfactory coherent staging limits', () => {
  it('supports multi-GiB modpacks within one derived reservation', () => {
    const limits = resolveSatisfactoryModLimits();
    expect(limits.outputBytes).toBe(2 * 1024 ** 3);
    expect(limits.maxFiles).toBe(100000);
    expect(limits.workingBytes).toBe(
      limits.outputBytes +
        limits.archiveBytes +
        limits.metadataBytes +
        satisfactoryModWorkingHeadroomBytes,
    );
  });
  it('caps by actual server disk without rejecting larger servers', () => {
    expect(resolveSatisfactoryModLimits({}, { outputBytesCap: 50 * 1024 ** 3 }).outputBytes).toBe(
      2 * 1024 ** 3,
    );
    expect(resolveSatisfactoryModLimits({}, { outputBytesCap: 1024 ** 3 }).outputBytes).toBe(
      1024 ** 3,
    );
  });
  it.each(['0', '-1', '1.5', 'Infinity', '1e9', '17179869185'])(
    'rejects invalid configured output %s',
    (value) => {
      expect(() =>
        resolveSatisfactoryModLimits({ NH_SATISFACTORY_MOD_MAX_BYTES: value }),
      ).toThrow();
    },
  );
  it('rejects a caller budget detached from the reserved working bytes', () => {
    expect(
      satisfactoryModLimitsSchema.safeParse({ ...resolveSatisfactoryModLimits(), workingBytes: 1 })
        .success,
    ).toBe(false);
  });
});
