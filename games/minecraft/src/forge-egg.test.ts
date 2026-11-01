import { expect, it } from 'vitest';
import {
  assertForgeServerArguments,
  forgeEggBinding,
  forgeEggStartup,
  getForgeInstalledTarget,
  isForgeEnhancedBinding,
} from './forge-egg.js';
import { forgeJavaMajor } from './forge-policy.js';
import { type ResolvedMinecraftRuntime, validateMinecraftRuntimeMapping } from './runtime.js';

const variables = ['MC_VERSION', 'FORGE_VERSION', 'SERVER_JARFILE', 'BUILD_TYPE'].map(
  (env_variable) => ({ env_variable, default_value: 'server.jar' }),
);
function runtime(release = '1.21.4', loaderVersion = '54.1.16'): ResolvedMinecraftRuntime {
  return {
    profile: 'forge',
    release,
    releaseType: 'release',
    javaMajor: forgeJavaMajor(release),
    loaderVersion,
    artifacts: [],
    installation: { kind: 'forge-installer', args: ['--installServer'] },
    evidence: [],
  };
}
const startup =
  'java -Xms128M -XX:MaxRAMPercentage=95.0 -Dterminal.jline=false -Dterminal.ansi=true $( [[  ! -f unix_args.txt ]] && printf %s "-jar {{SERVER_JARFILE}}" || printf %s "@unix_args.txt" )';
it.each([
  ['1.7.10', '10.13.4.1614-1.7.10'],
  ['1.12.2', '14.23.5.2860'],
  ['1.21.4', '54.1.16'],
])('binds exact %s/%s with no mutable version selectors', (release, loader) => {
  const resolved = runtime(release, loader);
  const binding = forgeEggBinding({ runtime: resolved, variables, environment: {} });
  expect(validateMinecraftRuntimeMapping(resolved, binding)).toEqual({
    MC_VERSION: release,
    FORGE_VERSION: `${release}-${loader}`,
    SERVER_JARFILE: 'server.jar',
    BUILD_TYPE: 'recommended',
  });
  expect(isForgeEnhancedBinding(binding)).toBe(true);
  expect(getForgeInstalledTarget(resolved, binding)).toEqual(
    release === '1.21.4'
      ? { kind: 'forge', path: 'libraries/net/minecraftforge/forge/1.21.4-54.1.16/unix_args.txt' }
      : { kind: 'jar', path: 'server.jar' },
  );
});
it('compiles only the known shell branch and preserves static JVM arguments', () => {
  const legacy = forgeEggStartup({ runtime: runtime('1.12.2', '14.23.5.2860'), startup });
  expect(legacy).toBe(
    'java -Xms128M -XX:MaxRAMPercentage=95.0 -Dterminal.jline=false -Dterminal.ansi=true -jar server.jar',
  );
  const modern = forgeEggStartup({ runtime: runtime(), startup });
  expect(modern).toBe(
    'java -Xms128M -XX:MaxRAMPercentage=95.0 -Dterminal.jline=false -Dterminal.ansi=true @libraries/net/minecraftforge/forge/1.21.4-54.1.16/unix_args.txt',
  );
  expect(forgeEggStartup({ runtime: runtime(), startup: modern })).toBe(modern);
  expect(
    forgeEggStartup({
      runtime: runtime(),
      startup: startup.replace('-XX:MaxRAMPercentage=95.0', '-Xmx{{SERVER_MEMORY}}M'),
    }),
  ).toContain('-Xmx{{SERVER_MEMORY}}M');
  expect(
    forgeEggStartup({
      runtime: runtime('1.12.2', '14.23.5.2860'),
      startup: 'java -Xms128M -jar {{SERVER_JARFILE}} nogui',
      serverJar: 'custom.jar',
    }),
  ).toBe('java -Xms128M -jar custom.jar nogui');
});
it.each([
  `${startup}; echo bad`,
  startup.replace('unix_args.txt ]]', 'other_args.txt ]]'),
  'java $(curl example.test) -jar server.jar',
  'java -Dfoo=$SECRET -jar server.jar',
  'java -jar ../server.jar',
  'java -jar server.jar && touch bad',
  'java @other_args.txt',
  'sh -c java -jar server.jar',
])('rejects unknown startup syntax %s', (value) => {
  expect(() =>
    forgeEggStartup({ runtime: runtime('1.12.2', '14.23.5.2860'), startup: value }),
  ).toThrow();
});
it('rejects a modern jar invocation and invalid variable/layout contracts', () => {
  expect(() => forgeEggStartup({ runtime: runtime(), startup: 'java -jar server.jar' })).toThrow();
  for (const jar of ['../server.jar', 'bad name.jar', 'server.txt'])
    expect(() =>
      forgeEggBinding({ runtime: runtime(), variables, environment: { SERVER_JARFILE: jar } }),
    ).toThrow();
  expect(() =>
    forgeEggBinding({ runtime: runtime(), variables: variables.slice(1), environment: {} }),
  ).toThrow();
  const binding = forgeEggBinding({ runtime: runtime(), variables, environment: {} });
  expect(() =>
    getForgeInstalledTarget(runtime(), {
      ...binding,
      artifactPaths: { ...binding.artifactPaths, server: 'unix_args.txt' },
    }),
  ).toThrow();
});
it('recognizes recent exact bootstrap shims without requiring old FML fields', () => {
  expect(() =>
    assertForgeServerArguments(
      '-Djava.net.preferIPv6Addresses=system -jar forge-1.21.4-54.1.16-shim.jar\n',
      runtime(),
    ),
  ).not.toThrow();
  for (const text of [
    '-jar forge-1.21.4-54.1.15-shim.jar',
    '-jar ../forge-1.21.4-54.1.16-shim.jar',
    '-jar forge-1.21.4-54.1.16-shim.jar -jar evil.jar',
  ])
    expect(() => assertForgeServerArguments(text, runtime())).toThrow();
});
it('checks modern arguments once from exact FML fields, rejects changed or repeated identities', () => {
  const text =
    '-p libraries/net/minecraftforge/forge/1.21.4-54.1.16/forge-1.21.4-54.1.16-server.jar\n--launchTarget forgeserver\n--fml.forgeVersion 54.1.16\n--fml.mcVersion 1.21.4\n';
  expect(() => assertForgeServerArguments(text, runtime())).not.toThrow();
  for (const changed of [
    text.replace('54.1.16\n', '54.1.15\n'),
    text.replace('forgeserver', 'forgeclient'),
    `${text}--fml.mcVersion 1.21.4`,
    'x'.repeat(256 * 1024 + 1),
  ])
    expect(() => assertForgeServerArguments(changed, runtime())).toThrow();
});
