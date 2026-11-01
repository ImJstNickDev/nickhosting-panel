import { describe, expect, it } from 'vitest';
import { fabricEggBinding } from './fabric-egg.js';
import { type ResolvedMinecraftRuntime, validateMinecraftRuntimeMapping } from './runtime.js';

const runtime: ResolvedMinecraftRuntime = {
  profile: 'fabric',
  release: '26.1',
  releaseType: 'release',
  loaderVersion: '0.18.4',
  installerVersion: '1.1.1',
  javaMajor: 25,
  artifacts: [],
  evidence: [],
  installation: { kind: 'fabric-installer', args: [] },
};
const variables = [
  { env_variable: 'MC_VERSION', default_value: 'latest' },
  { env_variable: 'LOADER_VERSION', default_value: 'latest' },
  { env_variable: 'FABRIC_VERSION', default_value: 'latest' },
];

describe('integration-owned FabricUpdated egg contract', () => {
  it('binds exact versions despite floating egg defaults and records the installed launcher path', () => {
    const binding = fabricEggBinding({ runtime, variables, environment: {} });
    expect(binding).toMatchObject({
      image: 'ghcr.io/ptero-eggs/yolks:java_25',
      installationKind: 'fabric-installer',
      artifactPaths: { server: 'server.jar', installer: 'fabric-installer.jar' },
      supportedProperties: [],
    });
    expect(validateMinecraftRuntimeMapping(runtime, binding)).toEqual({
      MC_VERSION: '26.1',
      LOADER_VERSION: '0.18.4',
      FABRIC_VERSION: '1.1.1',
    });
  });

  it.each([
    ['1.16.5', 8],
    ['1.17.1', 17],
    ['1.20.4', 17],
    ['1.21.11', 21],
  ])('uses the resolved Java requirement for %s', (release, javaMajor) => {
    expect(
      fabricEggBinding({ runtime: { ...runtime, release, javaMajor }, variables, environment: {} })
        .image,
    ).toBe(`ghcr.io/ptero-eggs/yolks:java_${javaMajor}`);
  });

  it('supports static images and fixes an optional jar variable to the script output', () => {
    const binding = fabricEggBinding({
      runtime,
      variables: [...variables, { env_variable: 'SERVER_JARFILE', default_value: 'other.jar' }],
      environment: {},
      staticImage: 'fixture/fabric:25',
    });
    expect(binding.image).toBe('fixture/fabric:25');
    expect(validateMinecraftRuntimeMapping(runtime, binding).SERVER_JARFILE).toBe('server.jar');
  });

  it('requires explicit Owner values for extra egg variables instead of adopting defaults', () => {
    const custom = [...variables, { env_variable: 'JVM_FLAGS', default_value: '-unknown' }];
    expect(() => fabricEggBinding({ runtime, variables: custom, environment: {} })).toThrow();
    expect(
      fabricEggBinding({ runtime, variables: custom, environment: { JVM_FLAGS: '' } })
        .declaredEggVariables,
    ).toContain('JVM_FLAGS');
  });

  it('rejects missing/duplicate variables and paths contradicting the installer script', () => {
    for (const changed of [[], variables.slice(1), [...variables, { env_variable: 'MC_VERSION' }]])
      expect(() => fabricEggBinding({ runtime, variables: changed, environment: {} })).toThrow();
    for (const jar of ['../server.jar', '/server.jar', 'custom.jar', 'minecraft-server.jar'])
      expect(() =>
        fabricEggBinding({ runtime, variables, environment: { SERVER_JARFILE: jar } }),
      ).toThrow();
  });

  it('rejects unresolved versions and unrelated installation contracts', () => {
    for (const changed of [
      { ...runtime, profile: 'vanilla' as const },
      { ...runtime, installation: { kind: 'server-jar' as const, args: [] } },
      { ...runtime, release: 'latest' },
      { ...runtime, loaderVersion: 'snapshot' },
      { ...runtime, installerVersion: 'latest' },
      { ...runtime, installerVersion: undefined },
      { ...runtime, loaderVersion: undefined },
      { ...runtime, installerVersion: '../1.1.1' },
    ])
      expect(() => fabricEggBinding({ runtime: changed, variables, environment: {} })).toThrow();
  });
});
