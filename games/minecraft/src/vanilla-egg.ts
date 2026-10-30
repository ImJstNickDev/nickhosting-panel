import { DomainError } from '@nickhosting/core';
import { resolveMinecraftImage } from './image-policy.js';
import { minecraftRuntimeMappingSchema, type ResolvedMinecraftRuntime } from './runtime.js';

/** Standard upstream Vanilla egg contract. No installer script is copied or executed here.
 * Unknown/custom eggs keep the explicit advanced binding path and require verification. */
export function vanillaEggBinding(input: {
  runtime: ResolvedMinecraftRuntime;
  variables: readonly { env_variable: string; default_value?: string | null }[];
  environment: Readonly<Record<string, string>>;
  staticImage?: string;
}) {
  const { runtime, variables, environment } = input;
  const names = variables.map((variable) => variable.env_variable);
  const releases = ['VANILLA_VERSION', 'MINECRAFT_VERSION'].filter((name) => names.includes(name));
  if (
    runtime.profile !== 'vanilla' ||
    releases.length !== 1 ||
    !names.includes('SERVER_JARFILE') ||
    new Set(names).size !== names.length ||
    names.some(
      (name) =>
        ![releases[0], 'SERVER_JARFILE'].includes(name) && !Object.hasOwn(environment, name),
    )
  )
    throw new DomainError('configuration_invalid', 400, {
      reason: 'minecraft_egg_contract_unsupported',
    });
  const releaseVariable = releases[0];
  if (!releaseVariable) throw new DomainError('configuration_invalid');
  // Freeze an explicitly configured jar path or the standard egg default; never arbitrary defaults.
  const jar =
    environment.SERVER_JARFILE ??
    variables.find((v) => v.env_variable === 'SERVER_JARFILE')?.default_value ??
    'server.jar';
  if (!/^[A-Za-z0-9_.-]+\.jar$/.test(jar) || jar.startsWith('.'))
    throw new DomainError('configuration_invalid', 400, {
      reason: 'minecraft_egg_contract_unsupported',
    });
  return minecraftRuntimeMappingSchema.parse({
    profile: 'vanilla',
    release: runtime.release,
    image: input.staticImage ?? resolveMinecraftImage(runtime).image,
    imageJavaMajor: runtime.javaMajor,
    declaredEggVariables: names,
    bindings: { release: releaseVariable },
    fixedVariables: { SERVER_JARFILE: jar },
    installationKind: 'server-jar',
    artifactPaths: { server: jar },
    // Actual installed-property attestation remains the trusted verification runner's job.
    supportedProperties: [],
  });
}
