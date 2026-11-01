import { describe, expect, it } from 'vitest';
import type { ResolvedMinecraftRuntime } from './runtime.js';
import { vanillaEggBinding } from './vanilla-egg.js';

const runtime: ResolvedMinecraftRuntime = {
  profile: 'vanilla',
  release: '1.21.11',
  releaseType: 'release',
  javaMajor: 21,
  artifacts: [],
  evidence: [],
  installation: { kind: 'server-jar', args: [] },
};
const variables = [
  { env_variable: 'VANILLA_VERSION', default_value: 'latest' },
  { env_variable: 'SERVER_JARFILE', default_value: 'server.jar' },
];
describe('integration-owned Vanilla egg contract', () => {
  it('derives exact version/image and jar binding, never floating latest or supported-property claims', () => {
    expect(vanillaEggBinding({ runtime, variables, environment: {} })).toMatchObject({
      release: '1.21.11',
      image: 'ghcr.io/pterodactyl/yolks:java_21',
      bindings: { release: 'VANILLA_VERSION' },
      fixedVariables: { SERVER_JARFILE: 'server.jar' },
      supportedProperties: [],
    });
  });
  it('preserves explicitly configured jar paths and static image alternative', () => {
    expect(
      vanillaEggBinding({
        runtime,
        variables,
        environment: { SERVER_JARFILE: 'custom.jar' },
        staticImage: 'fixture/java:21',
      }),
    ).toMatchObject({ artifactPaths: { server: 'custom.jar' }, image: 'fixture/java:21' });
  });
  it('rejects unknown, ambiguous or unsafe contracts instead of guessing arbitrary defaults', () => {
    for (const changed of [
      [],
      [...variables, { env_variable: 'MINECRAFT_VERSION' }],
      [...variables, { env_variable: 'DOWNLOAD_URL', default_value: 'untrusted' }],
    ])
      expect(() => vanillaEggBinding({ runtime, variables: changed, environment: {} })).toThrow();
    expect(() =>
      vanillaEggBinding({ runtime, variables, environment: { SERVER_JARFILE: '../server.jar' } }),
    ).toThrow();
    expect(() =>
      vanillaEggBinding({ runtime: { ...runtime, profile: 'paper' }, variables, environment: {} }),
    ).toThrow();
  });
});
