import { DomainError } from '@nickhosting/core';
import { resolveMinecraftImage } from './image-policy.js';
import {
  minecraftRuntimeMappingSchema,
  minecraftRuntimeRequestSchema,
  type ResolvedMinecraftRuntime,
} from './runtime.js';

/** FabricUpdated installer contract: the installer renames its generated launcher
 * to server.jar and the Minecraft jar to minecraft-server.jar. Other/custom eggs
 * can still supply an explicit advanced binding instead of using this helper. */
export function fabricEggBinding(input: {
  runtime: ResolvedMinecraftRuntime;
  variables: readonly { env_variable: string; default_value?: string | null }[];
  environment: Readonly<Record<string, string>>;
  staticImage?: string;
}) {
  const { runtime, variables, environment } = input;
  const names = variables.map((variable) => variable.env_variable);
  const bound = ['MC_VERSION', 'LOADER_VERSION', 'FABRIC_VERSION'];
  const versions = [runtime.release, runtime.loaderVersion, runtime.installerVersion];
  if (
    runtime.profile !== 'fabric' ||
    runtime.installation.kind !== 'fabric-installer' ||
    !minecraftRuntimeRequestSchema.safeParse({
      profile: runtime.profile,
      release: runtime.release,
      loaderVersion: runtime.loaderVersion,
      installerVersion: runtime.installerVersion,
    }).success ||
    versions.some(
      (version) => !version || ['latest', 'snapshot'].includes(version.toLowerCase()),
    ) ||
    bound.some((name) => !names.includes(name)) ||
    new Set(names).size !== names.length ||
    names.some(
      (name) =>
        !bound.includes(name) && name !== 'SERVER_JARFILE' && !Object.hasOwn(environment, name),
    ) ||
    (environment.SERVER_JARFILE !== undefined && environment.SERVER_JARFILE !== 'server.jar')
  )
    throw new DomainError('configuration_invalid', 400, {
      reason: 'minecraft_egg_contract_unsupported',
    });
  return minecraftRuntimeMappingSchema.parse({
    profile: 'fabric',
    release: runtime.release,
    image: input.staticImage ?? resolveMinecraftImage(runtime).image,
    imageJavaMajor: runtime.javaMajor,
    declaredEggVariables: names,
    bindings: {
      release: 'MC_VERSION',
      loaderVersion: 'LOADER_VERSION',
      installerVersion: 'FABRIC_VERSION',
    },
    fixedVariables: names.includes('SERVER_JARFILE') ? { SERVER_JARFILE: 'server.jar' } : {},
    installationKind: 'fabric-installer',
    artifactPaths: { server: 'server.jar', installer: 'fabric-installer.jar' },
    supportedProperties: [],
  });
}
