import { expect, it } from 'vitest';
import { minecraftDeclaredCapabilities } from './compatibility.js';
import {
  assertNeoForgeServerArguments,
  getNeoForgeInstalledTarget,
  neoforgeEggBinding,
  neoforgeEggStartup,
} from './neoforge-egg.js';
import { neoforgeJavaMajor } from './neoforge-policy.js';
import { type ResolvedMinecraftRuntime, validateMinecraftRuntimeMapping } from './runtime.js';

const variables = ['MC_VERSION', 'NEOFORGE_VERSION'].map((env_variable) => ({ env_variable }));
function runtime(release = '1.21.1', loaderVersion = '21.1.72'): ResolvedMinecraftRuntime {
  return {
    profile: 'neoforge',
    release,
    loaderVersion,
    releaseType: 'release',
    javaMajor: neoforgeJavaMajor(release),
    artifacts: [],
    evidence: [],
    installation: { kind: 'neoforge-installer', args: ['--installServer'] },
  };
}
it.each([
  ['1.20.1', '1.20.1-47.1.106', 'forge'],
  ['1.21.1', '21.1.72', 'neoforge'],
  ['26.1', '26.1.0.1-beta', 'neoforge'],
])('pins %s to exact variables and concrete output path', (release, version, artifact) => {
  const resolved = runtime(release, version);
  const binding = neoforgeEggBinding({ runtime: resolved, variables, environment: {} });
  expect(validateMinecraftRuntimeMapping(resolved, binding)).toEqual({
    MC_VERSION: release,
    NEOFORGE_VERSION: version,
  });
  const path = `libraries/net/neoforged/${artifact}/${version}/unix_args.txt`;
  expect(getNeoForgeInstalledTarget(resolved, binding)).toEqual({ kind: 'forge', path });
  expect(
    neoforgeEggStartup({
      runtime: resolved,
      startup: 'java -Xmx{{SERVER_MEMORY}}M @unix_args.txt nogui',
    }),
  ).toBe(`java -Xmx{{SERVER_MEMORY}}M @${path} nogui`);
  expect(() =>
    getNeoForgeInstalledTarget(resolved, {
      ...binding,
      artifactPaths: { ...binding.artifactPaths, server: 'unix_args.txt' },
    }),
  ).toThrow();
  const launch = release.startsWith('26')
    ? 'net.neoforged.fml.startup.Server'
    : 'cpw.mods.bootstraplauncher.BootstrapLauncher\n--launchTarget forgeserver';
  const text = `${launch}\n--fml.mcVersion ${release}\n${artifact === 'forge' ? '--fml.forgeVersion' : '--fml.neoForgeVersion'} ${artifact === 'forge' ? version.slice(7) : version}`;
  expect(() => assertNeoForgeServerArguments(text, resolved)).not.toThrow();
  for (const bad of [
    text.replace(release, 'wrong'),
    `${text}\n--fml.mcVersion ${release}`,
    text.replace(version, 'wrong'),
    'x'.repeat(256 * 1024 + 1),
  ]) {
    if (bad === text) continue;
    expect(() => assertNeoForgeServerArguments(bad, resolved)).toThrow();
  }
});
it.each([
  'java @user_jvm_args.txt @unix_args.txt',
  'java @other_args.txt',
  'java @unix_args.txt; touch bad',
  'java $(echo bad) @unix_args.txt',
  'java -jar server.jar',
  'sh -c java @unix_args.txt',
])('rejects unsafe or unknown startup %s', (startup) =>
  expect(() => neoforgeEggStartup({ runtime: runtime(), startup })).toThrow(),
);
it('rejects wrong pairs, missing or duplicate egg variables', () => {
  for (const vars of [variables.slice(1), [...variables, { env_variable: 'MC_VERSION' }]])
    expect(() =>
      neoforgeEggBinding({ runtime: runtime(), variables: vars, environment: {} }),
    ).toThrow();
  expect(() =>
    neoforgeEggBinding({ runtime: runtime('1.21.1', '21.0.1'), variables, environment: {} }),
  ).toThrow();
});
it('declares installation and shared modern Gateway capabilities', () => {
  expect(
    minecraftDeclaredCapabilities({
      profile: 'neoforge',
      release: '1.21.1',
      releaseType: 'release',
      family: 'netty',
      protocolId: 767,
    }),
  ).toMatchObject({
    installation: true,
    directConnection: true,
    gateway: true,
    readiness: true,
    wake: true,
  });
});
