import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { Selectable } from 'kysely';
import { trustedGameModules } from './game-modules.js';

type Mapping = Selectable<Database['runtime_egg_mappings']>;

/** Only compiled integration declarations can choose executable images. */
export function integrationImageCandidates(gameId: string, runtimeId: string): string[] {
  const policy = trustedGameModules
    .get(gameId)
    ?.manifest.runtimes.find((runtime) => runtime.id === runtimeId)?.imagePolicy;
  if (!policy) throw new DomainError('configuration_invalid');
  return policy.mode === 'fixed'
    ? [policy.image]
    : [...new Set(policy.rules.map((rule) => rule.image))];
}

/** A combination pins the image before its signed evidence and durable job exist. */
export function mappingProvisionImage(
  mapping: Mapping,
  binding?: unknown,
  modules = trustedGameModules,
): string {
  if (mapping.image_mode === 'static') return mapping.docker_image;
  const module = modules.get(mapping.game_id);
  if (module?.resolveProvisionImage) return module.resolveProvisionImage(mapping, binding);
  const policy = module?.manifest.runtimes.find(
    (runtime) => runtime.id === mapping.runtime_id,
  )?.imagePolicy;
  if (policy?.mode === 'fixed') return policy.image;
  // Version-dependent integrations must supply a validated immutable choice.
  throw new DomainError('configuration_invalid');
}
