import { DomainError } from '@nickhosting/core';
import { resolveMinecraftImage } from './image-policy.js';
import {
  minecraftRuntimeMappingSchema,
  minecraftRuntimeRequestSchema,
  type ResolvedMinecraftRuntime,
  trustedMinecraftArtifactUrl,
} from './runtime.js';

/** Folia's legacy-v2 egg must advertise DL_PATH so installation can use the
 * exact hash-pinned Fill v3 artifact without its substring/latest fallbacks. */
export function foliaEggBinding(input: {
  runtime: ResolvedMinecraftRuntime;
  variables: readonly { env_variable: string; default_value?: string | null }[];
  environment: Readonly<Record<string, string>>;
  staticImage?: string;
}) {
  const { runtime, variables, environment } = input;
  const names = variables.map((variable) => variable.env_variable);
  const required = ['MINECRAFT_VERSION', 'BUILD_NUMBER', 'SERVER_JARFILE', 'DL_PATH'];
  const artifact = runtime.artifacts.find((entry) => entry.role === 'server');
  const jar = environment.SERVER_JARFILE ?? 'server.jar';
  if (
    runtime.profile !== 'folia' ||
    runtime.installation.kind !== 'server-jar' ||
    !minecraftRuntimeRequestSchema.safeParse({
      profile: 'folia',
      release: runtime.release,
      buildId: runtime.buildId,
    }).success ||
    runtime.buildId === undefined ||
    ['latest', 'snapshot'].includes(runtime.release.toLowerCase()) ||
    required.some((name) => !names.includes(name)) ||
    new Set(names).size !== names.length ||
    names.some((name) => !required.includes(name) && !Object.hasOwn(environment, name)) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.jar$/.test(jar) ||
    !jar.endsWith('.jar') ||
    !artifact?.sha256 ||
    !/^[a-f0-9]{64}$/i.test(artifact.sha256)
  )
    throw new DomainError('configuration_invalid', 400, {
      reason: 'minecraft_egg_contract_unsupported',
    });
  trustedMinecraftArtifactUrl(artifact.url);
  if (new URL(artifact.url).origin !== 'https://fill-data.papermc.io')
    throw new DomainError('configuration_invalid', 400, {
      reason: 'minecraft_egg_contract_unsupported',
    });
  return minecraftRuntimeMappingSchema.parse({
    profile: 'folia',
    release: runtime.release,
    image: input.staticImage ?? resolveMinecraftImage(runtime).image,
    imageJavaMajor: runtime.javaMajor,
    declaredEggVariables: names,
    bindings: {
      release: 'MINECRAFT_VERSION',
      buildId: 'BUILD_NUMBER',
      serverArtifactUrl: 'DL_PATH',
    },
    fixedVariables: { SERVER_JARFILE: jar },
    installationKind: 'server-jar',
    artifactPaths: { server: jar },
    supportedProperties: [],
  });
}
