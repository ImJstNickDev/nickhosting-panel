import { DomainError } from '@nickhosting/core';
import { resolveMinecraftImage } from './image-policy.js';
import { neoforgeArtifact, neoforgeMinecraftVersion } from './neoforge-policy.js';
import {
  type MinecraftRuntimeMapping,
  minecraftRuntimeMappingSchema,
  type ResolvedMinecraftRuntime,
} from './runtime.js';

function unsupported(): never {
  throw new DomainError('configuration_invalid', 400, {
    reason: 'minecraft_egg_contract_unsupported',
  });
}
function exact(runtime: ResolvedMinecraftRuntime) {
  if (
    runtime.profile !== 'neoforge' ||
    runtime.installation.kind !== 'neoforge-installer' ||
    !runtime.loaderVersion ||
    neoforgeMinecraftVersion(runtime.loaderVersion) !== runtime.release
  )
    unsupported();
  return { version: runtime.loaderVersion, artifact: neoforgeArtifact(runtime.release) };
}
function installedPath(runtime: ResolvedMinecraftRuntime) {
  const { version, artifact } = exact(runtime);
  return `libraries/net/neoforged/${artifact}/${version}/unix_args.txt`;
}
export function neoforgeEggBinding(input: {
  runtime: ResolvedMinecraftRuntime;
  variables: readonly { env_variable: string; default_value?: string | null }[];
  environment: Readonly<Record<string, string>>;
  staticImage?: string;
}) {
  const { runtime, variables, environment } = input;
  const { version, artifact } = exact(runtime);
  const names = variables.map((variable) => variable.env_variable);
  const required = ['MC_VERSION', 'NEOFORGE_VERSION'];
  if (
    required.some((name) => !names.includes(name)) ||
    new Set(names).size !== names.length ||
    names.some((name) => !required.includes(name) && !Object.hasOwn(environment, name))
  )
    unsupported();
  return minecraftRuntimeMappingSchema.parse({
    profile: 'neoforge',
    release: runtime.release,
    image: input.staticImage ?? resolveMinecraftImage(runtime).image,
    imageJavaMajor: runtime.javaMajor,
    declaredEggVariables: names,
    bindings: { release: 'MC_VERSION', loaderVersion: 'NEOFORGE_VERSION' },
    fixedVariables: {},
    installationKind: 'neoforge-installer',
    artifactPaths: {
      server: installedPath(runtime),
      installer: `${artifact}-${version}-installer.jar`,
    },
    supportedProperties: [],
  });
}
export function isNeoForgeBinding(binding: {
  profile: string;
  installationKind: string;
  artifactPaths: Readonly<{ server?: string; installer?: string }>;
  bindings?: Readonly<{ release?: string; loaderVersion?: string }>;
}): boolean {
  return (
    binding.profile === 'neoforge' &&
    binding.installationKind === 'neoforge-installer' &&
    binding.bindings?.release === 'MC_VERSION' &&
    binding.bindings.loaderVersion === 'NEOFORGE_VERSION'
  );
}
export function getNeoForgeInstalledTarget(
  runtime: ResolvedMinecraftRuntime,
  binding: MinecraftRuntimeMapping,
): { kind: 'forge'; path: string } {
  const path = installedPath(runtime);
  const { artifact, version } = exact(runtime);
  if (
    !isNeoForgeBinding(binding) ||
    binding.artifactPaths.server !== path ||
    binding.artifactPaths.installer !== `${artifact}-${version}-installer.jar`
  )
    unsupported();
  return { kind: 'forge', path };
}
const jvmFlag =
  /^-(?:X[A-Za-z0-9][A-Za-z0-9.:=+,%/-]*|D[A-Za-z0-9_.-]+(?:=[A-Za-z0-9_.:+,%/-]+)?|XX:[A-Za-z0-9_:+,=%./-]+)$/;
/** Pin the root symlink to the selected installer's concrete output. Never
 * evaluate shell snippets or accept a mutable additional JVM argument file. */
export function neoforgeEggStartup(input: {
  runtime: ResolvedMinecraftRuntime;
  startup: string;
}): string {
  const path = installedPath(input.runtime);
  const source = input.startup.trim();
  if (
    source.length > 16_384 ||
    /[\0\r\n;|&<>`$"'{}\\]/.test(source.replace(/-Xmx\{\{SERVER_MEMORY\}\}M/g, '-Xmx128M'))
  )
    unsupported();
  const tokens = source.split(/\s+/);
  if (tokens.shift() !== 'java') unsupported();
  const marker = tokens.findIndex((token) => token.startsWith('@'));
  if (
    marker < 0 ||
    tokens
      .slice(0, marker)
      .some((token) => token !== '-Xmx{{SERVER_MEMORY}}M' && !jvmFlag.test(token))
  )
    unsupported();
  const target = tokens.slice(marker);
  if (target.at(-1) === 'nogui' || target.at(-1) === '--nogui') target.pop();
  if (target.length !== 1 || !['@unix_args.txt', `@${path}`].includes(target[0] ?? ''))
    unsupported();
  return [
    'java',
    ...tokens.slice(0, marker),
    `@${path}`,
    ...(source.match(/(?:^|\s)(--?nogui|nogui)$/) ? ['nogui'] : []),
  ].join(' ');
}
/** Identity fields observed in published 1.20.1, 20.2, 21.1 and 21.11 installer
 * argument templates. This checks installed output; it does not run installers. */
export function assertNeoForgeServerArguments(
  text: string,
  runtime: ResolvedMinecraftRuntime,
): void {
  const { version, artifact } = exact(runtime);
  if (Buffer.byteLength(text) > 256 * 1024 || text.includes('\0')) unsupported();
  const tokens = text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join(' ')
    .split(/\s+/);
  const field = (flag: string) => {
    const indices = tokens.flatMap((token, index) => (token === flag ? [index] : []));
    if (indices.length !== 1) unsupported();
    return tokens[(indices[0] ?? -1) + 1];
  };
  if (
    tokens.includes('-jar') ||
    tokens.filter(
      (token) =>
        token === 'net.neoforged.fml.startup.Server' ||
        token === 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    ).length !== 1
  )
    unsupported();
  const legacy = artifact === 'forge';
  if (
    field('--fml.mcVersion') !== runtime.release ||
    field(legacy ? '--fml.forgeVersion' : '--fml.neoForgeVersion') !==
      (legacy ? version.slice('1.20.1-'.length) : version)
  )
    unsupported();
  if (tokens.includes('net.neoforged.fml.startup.Server')) {
    if (
      legacy ||
      tokens.includes('--launchTarget') ||
      tokens.includes('cpw.mods.bootstraplauncher.BootstrapLauncher')
    )
      unsupported();
  } else if (
    !tokens.includes('cpw.mods.bootstraplauncher.BootstrapLauncher') ||
    field('--launchTarget') !== 'forgeserver'
  )
    unsupported();
}
