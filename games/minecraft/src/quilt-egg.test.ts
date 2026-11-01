import { describe, expect, it } from 'vitest';
import { isQuiltBinding, quiltEggBinding } from './quilt-egg.js';
import { type ResolvedMinecraftRuntime, validateMinecraftRuntimeMapping } from './runtime.js';

const runtime: ResolvedMinecraftRuntime = {
  profile: 'quilt',
  release: '26.3',
  releaseType: 'release',
  loaderVersion: '0.31.0-beta.5',
  installerVersion: '0.15.1',
  javaMajor: 25,
  artifacts: [],
  evidence: [],
  installation: { kind: 'quilt-installer', args: [] },
};
const variables = [
  'MC_VERSION',
  'QUILT_LOADER_VERSION',
  'QUILT_INSTALLER_VERSION',
  'SERVER_JARFILE',
].map((env_variable) => ({ env_variable }));
describe('exact Quilt egg binding', () => {
  it('binds exact versions and generated launcher without requiring the deleted installer', () => {
    const binding = quiltEggBinding({ runtime, variables, environment: {} });
    expect(binding.artifactPaths).toEqual({ server: 'server.jar' });
    expect(binding.image).toBe('ghcr.io/ptero-eggs/yolks:java_25');
    expect(isQuiltBinding(binding)).toBe(true);
    expect(validateMinecraftRuntimeMapping(runtime, binding)).toEqual({
      MC_VERSION: '26.3',
      QUILT_LOADER_VERSION: '0.31.0-beta.5',
      QUILT_INSTALLER_VERSION: '0.15.1',
      SERVER_JARFILE: 'server.jar',
    });
  });
  it('honors safe custom launcher filenames and static images', () => {
    expect(
      quiltEggBinding({
        runtime,
        variables,
        environment: { SERVER_JARFILE: 'quilt.jar' },
        staticImage: 'fixture/java:25',
      }),
    ).toMatchObject({ image: 'fixture/java:25', artifactPaths: { server: 'quilt.jar' } });
  });
  it('rejects old eggs, duplicate variables and unsafe or reserved jar paths', () => {
    for (const vars of [variables.slice(2), [...variables, { env_variable: 'MC_VERSION' }]])
      expect(() => quiltEggBinding({ runtime, variables: vars, environment: {} })).toThrow();
    for (const jar of ['../server.jar', '/server.jar', 'minecraft.jar', '.hidden.jar'])
      expect(() =>
        quiltEggBinding({ runtime, variables, environment: { SERVER_JARFILE: jar } }),
      ).toThrow();
  });
  it('rejects unresolved versions and unrelated installation types', () => {
    for (const changed of [
      { ...runtime, release: 'latest' },
      { ...runtime, loaderVersion: undefined },
      { ...runtime, installerVersion: 'snapshot' },
      { ...runtime, installation: { kind: 'server-jar' as const, args: [] } },
    ])
      expect(() => quiltEggBinding({ runtime: changed, variables, environment: {} })).toThrow();
  });
});
