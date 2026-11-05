import { describe, expect, it } from 'vitest';
import { manifestReadLimit, matchesManifestName, parseManifest } from './manifest-parser.js';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const plugin = {
  FileVersion: 3,
  FriendlyName: 'Factory tools',
  SemVersion: '1.2.3',
  RequiredOnRemote: false,
  Plugins: [
    { Name: 'SML', Enabled: true, SemVersion: '^3.9.0', Optional: false, BasePlugin: false },
  ],
};
const profile = {
  name: 'Factory',
  mods: { SML: { version: '^3.9.0', enabled: true }, Paused: { version: '2.0.0', enabled: false } },
  required_targets: ['LinuxServer'],
};
const lock = {
  version: 1,
  mods: {
    SML: {
      version: '3.9.0',
      dependencies: { Engine: '^1.0' },
      targets: { LinuxServer: { hash: '123', link: 'https://example.invalid/mod.zip' } },
    },
  },
};
describe('Satisfactory manifest projections', () => {
  it('recognizes only established filenames', () => {
    expect(
      ['SML.uplugin', 'Factory.smmprofile', 'profiles.json', 'nick_hosting-lock.json'].every(
        matchesManifestName,
      ),
    ).toBe(true);
    expect(['package.json', 'profile.json', 'installations.json'].some(matchesManifestName)).toBe(
      false,
    );
  });
  it('preserves descriptor dependency flags and remote requirements without resolving them', () => {
    const result = parseManifest(bytes(plugin), 'SML.uplugin');
    expect(result.kind).toBe('plugin');
    expect(result.sections[0]?.fields).toContainEqual({ label: 'requiredOnRemote', value: false });
    expect(result.sections[0]?.items[0]).toEqual({
      reference: 'SML',
      version: '^3.9.0',
      enabled: true,
      flags: [
        { label: 'optional', value: false },
        { label: 'basePlugin', value: false },
      ],
    });
    expect(
      parseManifest(bytes({ FileVersion: 3, Plugins: [{ Name: 'Engine' }] }), 'Engine.uplugin')
        .sections[0]?.items[0]?.enabled,
    ).toBeUndefined();
  });
  it('reads SMM3 exported intent separately from untrusted lock resolution', () => {
    const result = parseManifest(
      bytes({ profile, lockfile: lock, metadata: { gameVersion: 500000 } }),
      'Factory.smmprofile',
    );
    expect(result.sections[0]?.items[1]).toEqual({
      reference: 'Paused',
      version: '2.0.0',
      enabled: false,
    });
    expect(result.sections[0]?.fields).toContainEqual({ label: 'gameBuild', value: 500000 });
    expect(result.sections[0]?.items[0]?.version).toBe('^3.9.0');
  });
  it('reads ficsit-cli profile collections without prototype-key effects', () => {
    const data = JSON.parse(
      '{"version":0,"selected_profile":"__proto__","profiles":{"__proto__":{"name":"Factory","mods":{}}}}',
    );
    const result = parseManifest(bytes(data), 'profiles.json');
    expect(result.sections[0]?.title).toBe('__proto__');
    expect(result.sections[0]?.fields).toContainEqual({ label: 'selected', value: true });
    expect(
      parseManifest(bytes({ version: 0, selected_profile: '', profiles: {} }), 'profiles.json')
        .sections,
    ).toEqual([]);
  });
  it('shows resolved versions, dependencies and target names, without exposing executable links', () => {
    const item = parseManifest(bytes(lock), 'nick_hosting-lock.json').sections[0]?.items[0];
    expect(item).toEqual({
      reference: 'SML',
      version: '3.9.0',
      details: 'Engine: ^1.0',
      targets: 'LinuxServer',
    });
    expect(JSON.stringify(item)).not.toContain('https:');
  });
  it('rejects unsupported versions, shapes, malformed text and wrong scalar types', () => {
    expect(() => parseManifest(bytes({ ...plugin, FileVersion: 4 }), 'A.uplugin')).toThrow(
      'unsupported_manifest',
    );
    expect(() => parseManifest(bytes({ ...lock, version: 2 }), 'nick_hosting-lock.json')).toThrow(
      'unsupported_manifest',
    );
    for (const value of [
      null,
      [],
      {},
      { FileVersion: 3, RequiredOnRemote: 'false' },
      { FileVersion: 3, Plugins: [{ Name: 'A', Enabled: 'true' }] },
    ]) {
      expect(() => parseManifest(bytes(value), 'A.uplugin')).toThrow();
    }
    expect(() => parseManifest(new Uint8Array([0xff]), 'A.uplugin')).toThrow('invalid_manifest');
    expect(() =>
      parseManifest(
        bytes({ profile: { ...profile, mods: { A: { version: '*', enabled: 'false' } } } }),
        'A.smmprofile',
      ),
    ).toThrow('invalid_manifest');
  });
  it('bounds bytes, row collections and long scalar fields', () => {
    expect(() => parseManifest(new Uint8Array(manifestReadLimit), 'A.uplugin')).toThrow(
      'manifest_too_large',
    );
    expect(() =>
      parseManifest(
        bytes({ FileVersion: 3, Plugins: Array.from({ length: 513 }, () => ({ Name: 'A' })) }),
        'A.uplugin',
      ),
    ).toThrow('invalid_manifest');
    expect(() =>
      parseManifest(bytes({ FileVersion: 3, Description: 'x'.repeat(8193) }), 'A.uplugin'),
    ).toThrow('invalid_manifest');
  });
});
