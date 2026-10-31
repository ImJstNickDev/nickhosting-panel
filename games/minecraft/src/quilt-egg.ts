import { DomainError } from '@nickhosting/core';
import { resolveMinecraftImage } from './image-policy.js';
import {
  minecraftRuntimeMappingSchema,
  minecraftRuntimeRequestSchema,
  type ResolvedMinecraftRuntime,
} from './runtime.js';

/** Imported exact-version Quilt egg: generated launcher plus minecraft.jar, installer deleted. */
export function quiltEggBinding(input: {
  runtime: ResolvedMinecraftRuntime;
  variables: readonly { env_variable: string; default_value?: string | null }[];
  environment: Readonly<Record<string, string>>;
  staticImage?: string;
}) {
  const { runtime, variables, environment } = input;
  const names = variables.map((variable) => variable.env_variable);
  const bound = ['MC_VERSION', 'QUILT_LOADER_VERSION', 'QUILT_INSTALLER_VERSION', 'SERVER_JARFILE'];
  const jar = environment.SERVER_JARFILE ?? 'server.jar';
  if (
    runtime.profile !== 'quilt' ||
    runtime.installation.kind !== 'quilt-installer' ||
    !minecraftRuntimeRequestSchema.safeParse({
      profile: runtime.profile,
      release: runtime.release,
      loaderVersion: runtime.loaderVersion,
      installerVersion: runtime.installerVersion,
    }).success ||
    [runtime.release, runtime.loaderVersion, runtime.installerVersion].some(
      (value) =>
        !value ||
        ['latest', 'snapshot'].includes(value.toLowerCase()) ||
        !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value),
    ) ||
    bound.some((name) => !names.includes(name)) ||
    new Set(names).size !== names.length ||
    names.some((name) => !bound.includes(name) && !Object.hasOwn(environment, name)) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.jar$/.test(jar) ||
    jar === 'minecraft.jar'
  )
    throw new DomainError('configuration_invalid', 400, {
      reason: 'minecraft_egg_contract_unsupported',
    });
  return minecraftRuntimeMappingSchema.parse({
    profile: 'quilt',
    release: runtime.release,
    image: input.staticImage ?? resolveMinecraftImage(runtime).image,
    imageJavaMajor: runtime.javaMajor,
    declaredEggVariables: names,
    bindings: {
      release: 'MC_VERSION',
      loaderVersion: 'QUILT_LOADER_VERSION',
      installerVersion: 'QUILT_INSTALLER_VERSION',
    },
    fixedVariables: { SERVER_JARFILE: jar },
    installationKind: 'quilt-installer',
    artifactPaths: { server: jar },
    supportedProperties: [],
  });
}
export function isQuiltBinding(binding: {
  profile: string;
  installationKind: string;
  artifactPaths: Readonly<{ server?: string; installer?: string }>;
}): boolean {
  return (
    binding.profile === 'quilt' &&
    binding.installationKind === 'quilt-installer' &&
    typeof binding.artifactPaths.server === 'string' &&
    /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.jar$/.test(binding.artifactPaths.server) &&
    binding.artifactPaths.server !== 'minecraft.jar' &&
    binding.artifactPaths.installer === undefined
  );
}
