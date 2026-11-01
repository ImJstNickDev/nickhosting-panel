import { describe, expect, it } from 'vitest';
import { paperEggBinding } from './paper-egg.js';
import { type ResolvedMinecraftRuntime, validateMinecraftRuntimeMapping } from './runtime.js';

const runtime: ResolvedMinecraftRuntime = {
  profile: 'paper',
  release: '1.21.11',
  releaseType: 'release',
  buildId: 132,
  javaMajor: 21,
  artifacts: [
    {
      role: 'server',
      url: 'https://fill-data.papermc.io/v1/objects/pinned/paper.jar',
      sha256: 'a'.repeat(64),
      size: 1000,
    },
  ],
  evidence: [],
  installation: { kind: 'server-jar', args: [] },
};
const variables = ['MINECRAFT_VERSION', 'BUILD_NUMBER', 'SERVER_JARFILE'].map((env_variable) => ({
  env_variable,
  default_value: 'latest',
}));
describe('PaperUpdated egg binding', () => {
  it('pins the Minecraft version, build, jar and integration image', () => {
    const binding = paperEggBinding({ runtime, variables, environment: {} });
    expect(binding).toMatchObject({
      image: 'ghcr.io/ptero-eggs/yolks:java_21',
      artifactPaths: { server: 'server.jar' },
      supportedProperties: [],
    });
    expect(validateMinecraftRuntimeMapping(runtime, binding)).toEqual({
      MINECRAFT_VERSION: '1.21.11',
      BUILD_NUMBER: '132',
      SERVER_JARFILE: 'server.jar',
    });
  });
  it('binds optional DL_PATH to the exact trusted download and preserves explicit jar/static image', () => {
    const binding = paperEggBinding({
      runtime,
      variables: [...variables, { env_variable: 'DL_PATH', default_value: '' }],
      environment: { SERVER_JARFILE: 'custom.jar', DL_PATH: 'https://example.test/untrusted.jar' },
      staticImage: 'fixture/java:21',
    });
    expect(binding).toMatchObject({
      image: 'fixture/java:21',
      artifactPaths: { server: 'custom.jar' },
    });
    expect(validateMinecraftRuntimeMapping(runtime, binding).DL_PATH).toBe(
      runtime.artifacts[0]?.url,
    );
  });
  it('preserves legitimate exact build zero rather than treating it as absent', () => {
    const zero = { ...runtime, buildId: 0 };
    const binding = paperEggBinding({ runtime: zero, variables, environment: {} });
    expect(validateMinecraftRuntimeMapping(zero, binding).BUILD_NUMBER).toBe('0');
  });
  it('requires every runtime selector and rejects ambiguous or unknown unconfigured egg variables', () => {
    for (const entries of [
      variables.slice(1),
      [...variables, { env_variable: 'MINECRAFT_VERSION' }],
      [...variables, { env_variable: 'OTHER', default_value: 'ignored' }],
    ])
      expect(() => paperEggBinding({ runtime, variables: entries, environment: {} })).toThrow();
    expect(
      paperEggBinding({
        runtime,
        variables: [...variables, { env_variable: 'OTHER' }],
        environment: { OTHER: 'frozen' },
      }).declaredEggVariables,
    ).toContain('OTHER');
  });
  it('rejects floating, incomplete, unsupported and unsafe contracts', () => {
    for (const changed of [
      { ...runtime, buildId: undefined },
      { ...runtime, release: 'latest' },
      { ...runtime, profile: 'folia' as const },
      { ...runtime, artifacts: [] },
      {
        ...runtime,
        artifacts: [
          {
            role: 'server' as const,
            sha256: 'a'.repeat(64),
            url: 'https://piston-data.mojang.com/server.jar',
          },
        ],
      },
    ])
      expect(() => paperEggBinding({ runtime: changed, variables, environment: {} })).toThrow();
    for (const jar of ['../server.jar', '.server.jar', 'dir/server.jar', 'server.jar\n', 'server'])
      expect(() =>
        paperEggBinding({ runtime, variables, environment: { SERVER_JARFILE: jar } }),
      ).toThrow();
  });
});
