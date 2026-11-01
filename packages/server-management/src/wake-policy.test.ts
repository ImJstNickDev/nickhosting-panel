import { defaultPlatformConfig, resolveConfig } from '@nickhosting/core';
import { describe, expect, it } from 'vitest';
import { resolveAutoWakeValues } from './wake-policy.js';

describe('independent auto-wake policy', () => {
  it('inherits platform, game, runtime and Owner server values, retaining false', () => {
    const values = {
      ...defaultPlatformConfig,
      gameAutoWakePolicies: {
        minecraft: {
          gameEnabled: false,
          runtimeEnabled: { vanilla: true },
          userAccess: null,
          runtimeUserAccess: {},
        },
      },
    };
    expect(resolveAutoWakeValues(values, 'other', 'any', null)).toMatchObject({
      effectiveEnabled: true,
      source: 'default',
    });
    expect(resolveAutoWakeValues(values, 'minecraft', 'paper', null)).toMatchObject({
      effectiveEnabled: false,
      source: 'game',
    });
    expect(resolveAutoWakeValues(values, 'minecraft', 'vanilla', null)).toMatchObject({
      effectiveEnabled: true,
      source: 'runtime',
    });
    expect(
      resolveAutoWakeValues(values, 'minecraft', 'vanilla', { owner_auto_wake_override: false }),
    ).toMatchObject({ effectiveEnabled: false, source: 'server' });
  });
  it('ignores stored user overrides when Owner hides the setting', () => {
    expect(
      resolveAutoWakeValues(defaultPlatformConfig, 'minecraft', 'vanilla', {
        owner_auto_wake_user_access: 'hidden',
        auto_wake_override: false,
      }),
    ).toMatchObject({ effectiveEnabled: true, overrideEnabled: false });
  });
  it('disable-only cannot resurrect a disabled Owner baseline, and reset inherits it', () => {
    const state = {
      owner_auto_wake_user_access: 'disable-only' as const,
      owner_auto_wake_override: false,
    };
    expect(
      resolveAutoWakeValues(defaultPlatformConfig, 'minecraft', 'vanilla', {
        ...state,
        auto_wake_override: true,
      }).effectiveEnabled,
    ).toBe(false);
    expect(
      resolveAutoWakeValues(defaultPlatformConfig, 'minecraft', 'vanilla', {
        ...state,
        owner_auto_wake_override: true,
        auto_wake_override: false,
      }).effectiveEnabled,
    ).toBe(false);
    expect(
      resolveAutoWakeValues(defaultPlatformConfig, 'minecraft', 'vanilla', {
        ...state,
        owner_auto_wake_override: true,
        auto_wake_override: null,
      }).effectiveEnabled,
    ).toBe(true);
  });
  it('environment values override database policies and invalid modes fail', () => {
    expect(
      resolveConfig({ defaultAutoWakeEnabled: true }, { NH_DEFAULT_AUTO_WAKE_ENABLED: 'false' })
        .values.defaultAutoWakeEnabled,
    ).toBe(false);
    expect(() => resolveConfig({}, { NH_AUTO_WAKE_USER_ACCESS: 'shorten-only' })).toThrow();
    expect(() => resolveConfig({}, { NH_DEFAULT_AUTO_WAKE_ENABLED: 'yes' })).toThrow();
  });
});
