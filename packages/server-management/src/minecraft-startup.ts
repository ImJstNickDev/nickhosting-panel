import {
  forgeEggStartup,
  isForgeEnhancedBinding,
  minecraftRuntimeMappingSchema,
  type ResolvedMinecraftRuntime,
} from '@nickhosting/minecraft';
import type { inspectMinecraftCombination } from './minecraft-registry.js';

type MinecraftChoice = Awaited<ReturnType<typeof inspectMinecraftCombination>>;

/** Freeze the egg's legacy/modern shell branch into the launch target selected by
 * this combination. Keep the Owner mapping template unchanged and digest-bound. */
export function minecraftProvisionStartup(
  choice: Pick<MinecraftChoice, 'row' | 'mapping'>,
): string {
  const binding = minecraftRuntimeMappingSchema.parse(choice.row.binding);
  if (!isForgeEnhancedBinding(binding)) return choice.mapping.startup;
  return forgeEggStartup({
    runtime: choice.row.resolved_runtime as ResolvedMinecraftRuntime,
    startup: choice.mapping.startup,
    serverJar: binding.fixedVariables.SERVER_JARFILE,
  });
}
