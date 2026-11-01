import { DomainError } from '@nickhosting/core';
import { forgeEnhancedSupportedRelease, forgeUsesArguments } from './forge-policy.js';
import { resolveMinecraftImage } from './image-policy.js';
import {
  type MinecraftRuntimeMapping,
  minecraftRuntimeMappingSchema,
  minecraftRuntimeRequestSchema,
  type ResolvedMinecraftRuntime,
} from './runtime.js';

function unsupported(): never {
  throw new DomainError('configuration_invalid', 400, {
    reason: 'minecraft_egg_contract_unsupported',
  });
}
const jarName = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.jar$/;
function exactForge(runtime: ResolvedMinecraftRuntime) {
  if (
    runtime.profile !== 'forge' ||
    runtime.installation.kind !== 'forge-installer' ||
    !forgeEnhancedSupportedRelease(runtime.release) ||
    !minecraftRuntimeRequestSchema.safeParse({
      profile: 'forge',
      release: runtime.release,
      loaderVersion: runtime.loaderVersion,
    }).success ||
    !runtime.loaderVersion ||
    ['latest', 'recommended', 'snapshot'].includes(runtime.loaderVersion.toLowerCase())
  )
    unsupported();
  return `${runtime.release}-${runtime.loaderVersion}`;
}

/** Forge Enhanced accepts the complete Maven coordinate in FORGE_VERSION. That
 * bypasses its mutable recommended/latest resolution and preserves legacy suffixes. */
export function forgeEggBinding(input: {
  runtime: ResolvedMinecraftRuntime;
  variables: readonly { env_variable: string; default_value?: string | null }[];
  environment: Readonly<Record<string, string>>;
  staticImage?: string;
}) {
  const { runtime, variables, environment } = input;
  exactForge(runtime);
  const names = variables.map((variable) => variable.env_variable);
  const required = ['MC_VERSION', 'FORGE_VERSION', 'SERVER_JARFILE'];
  const jar =
    environment.SERVER_JARFILE ??
    variables.find((variable) => variable.env_variable === 'SERVER_JARFILE')?.default_value ??
    'server.jar';
  if (
    !jarName.test(jar) ||
    required.some((name) => !names.includes(name)) ||
    new Set(names).size !== names.length ||
    names.some(
      (name) => ![...required, 'BUILD_TYPE'].includes(name) && !Object.hasOwn(environment, name),
    )
  )
    unsupported();
  return minecraftRuntimeMappingSchema.parse({
    profile: 'forge',
    release: runtime.release,
    image: input.staticImage ?? resolveMinecraftImage(runtime).image,
    imageJavaMajor: runtime.javaMajor,
    declaredEggVariables: names,
    bindings: { release: 'MC_VERSION', loaderCoordinate: 'FORGE_VERSION' },
    fixedVariables: {
      SERVER_JARFILE: jar,
      ...(names.includes('BUILD_TYPE') ? { BUILD_TYPE: 'recommended' } : {}),
    },
    installationKind: 'forge-installer',
    artifactPaths: {
      server: forgeUsesArguments(runtime.release)
        ? `libraries/net/minecraftforge/forge/${exactForge(runtime)}/unix_args.txt`
        : jar,
      installer: 'installer.jar',
    },
    supportedProperties: [],
  });
}

export function isForgeEnhancedBinding(binding: {
  profile: string;
  installationKind: string;
  artifactPaths: Readonly<{ server?: string; installer?: string }>;
  bindings?: Readonly<{ release?: string; loaderCoordinate?: string }>;
}): boolean {
  return (
    binding.profile === 'forge' &&
    binding.installationKind === 'forge-installer' &&
    binding.artifactPaths.installer === 'installer.jar' &&
    binding.bindings?.release === 'MC_VERSION' &&
    binding.bindings.loaderCoordinate === 'FORGE_VERSION'
  );
}

export function getForgeInstalledTarget(
  runtime: ResolvedMinecraftRuntime,
  binding: MinecraftRuntimeMapping,
): { kind: 'jar'; path: string } | { kind: 'forge'; path: string } {
  const coordinate = exactForge(runtime);
  const jar = binding.fixedVariables.SERVER_JARFILE ?? 'server.jar';
  if (!isForgeEnhancedBinding(binding) || !jarName.test(jar)) unsupported();
  const modern = forgeUsesArguments(runtime.release);
  const path = modern ? `libraries/net/minecraftforge/forge/${coordinate}/unix_args.txt` : jar;
  if (binding.artifactPaths.server !== path) unsupported();
  return { kind: modern ? 'forge' : 'jar', path };
}

// Recognize only the published egg's shell branch. It is never evaluated by us:
// selection is compiled to one static invocation from the already pinned runtime.
const conditional =
  /\$\(\s*\[\[\s*!\s*-f\s+unix_args\.txt\s*\]\]\s*&&\s*printf\s+%s\s+"-jar\s+\{\{SERVER_JARFILE\}\}"\s*\|\|\s*printf\s+%s\s+"@unix_args\.txt"\s*\)/;
const jvmFlag =
  /^-(?:X[A-Za-z0-9][A-Za-z0-9.:=+,%/-]*|D[A-Za-z0-9_.-]+(?:=[A-Za-z0-9_.:+,%/-]+)?|XX:[A-Za-z0-9_:+,=%./-]+)$/;

export function forgeEggStartup(input: {
  runtime: ResolvedMinecraftRuntime;
  startup: string;
  serverJar?: string;
}): string {
  const coordinate = exactForge(input.runtime);
  const jar = input.serverJar ?? 'server.jar';
  if (!jarName.test(jar) || input.startup.length > 16_384) unsupported();
  const selected = forgeUsesArguments(input.runtime.release)
    ? `@libraries/net/minecraftforge/forge/${coordinate}/unix_args.txt`
    : `-jar ${jar}`;
  let source = input.startup.trim();
  const branch = conditional.exec(source);
  if (branch) source = source.replace(branch[0], selected);
  else source = source.replace(/\{\{SERVER_JARFILE\}\}/g, jar);
  // All remaining shell syntax and expansion is rejected, including arbitrary
  // branches, redirection, pipes, command substitution and ambient variables.
  const withoutMemory = source.replace(/-Xmx\{\{SERVER_MEMORY\}\}M/g, '-Xmx128M');
  if (source.includes('\0') || /[\r\n;|&<>`$"'{}\\]/.test(withoutMemory)) unsupported();
  const tokens = source.split(/\s+/);
  if (tokens.shift() !== 'java') unsupported();
  const marker = tokens.findIndex((token) => token === '-jar' || token.startsWith('@'));
  if (
    marker < 0 ||
    tokens
      .slice(0, marker)
      .some((token) => token !== '-Xmx{{SERVER_MEMORY}}M' && !jvmFlag.test(token))
  )
    unsupported();
  const prefix = tokens.slice(0, marker);
  const target = tokens.slice(marker);
  if (target.at(-1) === 'nogui' || target.at(-1) === '--nogui') target.pop();
  const expected = selected.split(' ');
  // An explicitly static jar launch is suitable for the legacy family only.
  if (target.length !== expected.length || target.some((token, index) => token !== expected[index]))
    unsupported();
  return [
    'java',
    ...prefix,
    ...expected,
    ...(source.match(/(?:^|\s)(--?nogui|nogui)$/) ? ['nogui'] : []),
  ].join(' ');
}

/** Bounded argument-file identity check; no recursive library scan or launch-JAR
 * download is needed to identify a modern Forge installation. */
export function assertForgeServerArguments(text: string, runtime: ResolvedMinecraftRuntime): void {
  const coordinate = exactForge(runtime);
  if (
    !forgeUsesArguments(runtime.release) ||
    Buffer.byteLength(text) > 256 * 1024 ||
    text.includes('\0')
  )
    unsupported();
  const tokens = text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join(' ')
    .split(/\s+/);
  const jar = tokens.indexOf('-jar');
  if (jar !== -1) {
    // New Forge installer releases use a generated bootstrap shim instead of
    // spelling FML arguments here. Its exact filename retains both identities.
    if (
      tokens.filter((token) => token === '-jar').length !== 1 ||
      tokens[jar + 1] !== `forge-${coordinate}-shim.jar` ||
      tokens.slice(jar + 2).some(Boolean) ||
      tokens.slice(0, jar).some((token) => token && !jvmFlag.test(token))
    )
      unsupported();
    return;
  }
  const field = (flag: string) => {
    const indices = tokens.flatMap((token, index) => (token === flag ? [index] : []));
    if (indices.length !== 1) unsupported();
    return tokens[(indices[0] ?? -1) + 1];
  };
  if (
    field('--launchTarget') !== 'forgeserver' ||
    field('--fml.mcVersion') !== runtime.release ||
    field('--fml.forgeVersion') !== runtime.loaderVersion?.split('-')[0]
  )
    unsupported();
}
