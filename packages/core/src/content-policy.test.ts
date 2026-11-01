import { describe, expect, it } from 'vitest';
import { assertConfigWritable, resolveConfig } from './config.js';
import {
  contentPolicyValues,
  legacyContentConfigKeys,
  legacyContentEnvironmentKeys,
  normalizeLegacyContentSettings,
  resolveContentPolicy,
} from './content-policy.js';

describe('global content policy and scoped integration overrides', () => {
  it('exposes one canonical setting per historical key without moving storage', () => {
    const defaults = resolveConfig();
    expect(defaults.values.contentSourceRoot).toBe('./mountdata/minecraft-sources');
    expect(defaults.values.contentWorkRoot).toBe('./mountdata/minecraft-content');
    for (const [legacy, canonical] of Object.entries(legacyContentConfigKeys)) {
      expect(defaults.values).not.toHaveProperty(legacy);
      const value = defaults.values[canonical];
      expect(resolveConfig({ [legacy]: value }).values[canonical]).toEqual(value);
      expect(resolveConfig({ [legacy]: value }).sources[canonical]).toBe('database');
    }
  });
  it('uses legacy environment locks and lets an explicit canonical environment value win', () => {
    const settings = resolveConfig(
      { minecraftSourceConcurrent: 2 },
      { NH_MINECRAFT_SOURCE_CONCURRENT: '5', NH_CONTENT_SOURCE_CONCURRENT: '7' },
    );
    expect(settings.values.contentSourceConcurrent).toBe(7);
    expect(settings.sources.contentSourceConcurrent).toBe('environment');
    expect(settings.lockedKeys).toContain('contentSourceConcurrent');
    expect(() => assertConfigWritable({ minecraftSourceConcurrent: 4 }, settings)).toThrow(
      'conflict',
    );
    expect(() => assertConfigWritable({ contentSourceConcurrent: 4 }, settings)).toThrow(
      'conflict',
    );
    for (const [canonical, legacyEnv] of Object.entries(legacyContentEnvironmentKeys)) {
      const value = settings.values[canonical as keyof typeof settings.values];
      const encoded = typeof value === 'string' ? value : JSON.stringify(value);
      const resolved = resolveConfig({}, { [legacyEnv]: encoded });
      expect(resolved.values[canonical as keyof typeof settings.values]).toEqual(value);
      expect(resolved.lockedKeys).toContain(canonical);
    }
  });
  it('normalizes aliases before merging writes, including removing a canonical override', () => {
    const old = normalizeLegacyContentSettings({
      minecraftSourceConcurrent: 3,
      instanceName: 'Existing',
    });
    expect(
      resolveConfig({ ...(old as object), contentSourceConcurrent: 6 }).values
        .contentSourceConcurrent,
    ).toBe(6);
    expect(
      normalizeLegacyContentSettings({
        minecraftSourceConcurrent: 3,
        contentSourceConcurrent: undefined,
      }),
    ).toEqual({ contentSourceConcurrent: undefined });
    expect(
      resolveConfig({ minecraftSourceConcurrent: 3, contentSourceConcurrent: 5 }).values
        .contentSourceConcurrent,
    ).toBe(5);
    expect(() => resolveConfig({ minecraftUnknown: 3 })).toThrow('configuration_invalid');
  });
  it('inherits global values and reports the actual source and environment locks', () => {
    const resolved = resolveConfig(
      { contentSourceUserBytes: 8000000 },
      { NH_CONTENT_SOURCE_CONCURRENT: '3' },
    );
    const policy = resolveContentPolicy(resolved, 'fixture-one');
    expect(policy.values.sourceUserBytes).toBe(8000000);
    expect(policy.fields.sourceUserBytes).toMatchObject({
      inherited: true,
      source: 'database',
      locked: false,
    });
    expect(policy.fields.sourceConcurrent).toMatchObject({
      value: 3,
      inherited: true,
      globalLocked: true,
      locked: false,
    });
  });
  it('clamps local ceilings and raises physical floors without widening trusted origins', () => {
    const config = resolveConfig({
      contentSourceGlobalBytes: 1000,
      contentSourceUserBytes: 800,
      contentSourceConcurrent: 4,
      contentSourceUserConcurrent: 2,
      contentSourceFreeBytes: 500,
      contentSourceFreePercent: 10,
      contentDownloadOrigins: ['https://one.example.test', 'https://two.example.test'],
      gameContentPolicies: {
        minecraft: {
          sourceGlobalBytes: 2000,
          sourceUserBytes: 400,
          sourceConcurrent: 20,
          sourceUserConcurrent: 1,
          sourceFreeBytes: 100,
          sourceFreePercent: 15,
          downloadOrigins: ['https://two.example.test', 'https://untrusted.example.test'],
        },
      },
    }).values;
    expect(contentPolicyValues(config, 'minecraft')).toEqual({
      sourceGlobalBytes: 1000,
      sourceUserBytes: 400,
      sourceConcurrent: 4,
      sourceUserConcurrent: 1,
      sourceFreeBytes: 500,
      sourceFreePercent: 15,
      downloadOrigins: ['https://two.example.test'],
    });
    expect(contentPolicyValues(config, 'fixture-two').sourceUserBytes).toBe(800);
  });
  it('supports zero free-space margin and disables a local content origin without resetting it', () => {
    const resolved = resolveConfig(
      {},
      {
        NH_GAME_CONTENT_POLICIES: JSON.stringify({
          minecraft: { sourceFreeBytes: 0, downloadOrigins: [] },
        }),
      },
    );
    const policy = resolveContentPolicy(resolved, 'minecraft');
    expect(policy.values.downloadOrigins).toEqual([]);
    expect(policy.fields.downloadOrigins).toMatchObject({
      inherited: false,
      locked: true,
      source: 'environment',
    });
    expect(() => assertConfigWritable({ gameContentPolicies: {} }, resolved)).toThrow('conflict');
  });
});
