import { resolveRuntimeImage, runtimeImagePolicySchema } from '@nickhosting/game-sdk';
import type { ResolvedMinecraftRuntime } from './runtime.js';

/** Pterodactyl upstream build matrix, checked 2026-10-10:
 * https://github.com/pterodactyl/yolks/blob/master/.github/workflows/java.yml
 * These are image declarations, not compatibility certifications or installer images.
 * Explicit majors prevent silently guessing a tag for a future Java requirement.
 */
export const minecraftImagePolicy = runtimeImagePolicySchema.parse({
  mode: 'rules',
  rules: [8, 11, 16, 17, 18, 19, 21, 22, 23, 24, 25].map((major) => ({
    id: `java-${major}`,
    requirements: { javaMajor: String(major) },
    image: `ghcr.io/pterodactyl/yolks:java_${major}`,
  })),
});

/** FabricUpdated uses the maintained ptero-eggs Yolks family. Only explicitly
 * declared tags are eligible; the selected egg must still advertise the image.
 * https://github.com/ptero-eggs/yolks/blob/main/.github/workflows/java.yml
 */
export const minecraftFabricImagePolicy = runtimeImagePolicySchema.parse({
  mode: 'rules',
  rules: [8, 11, 16, 17, 21, 22, 23, 24, 25].map((major) => ({
    id: `java-${major}`,
    requirements: { javaMajor: String(major) },
    image: `ghcr.io/ptero-eggs/yolks:java_${major}`,
  })),
});

export function minecraftRuntimeImagePolicy(profile: ResolvedMinecraftRuntime['profile']) {
  return profile === 'fabric' ? minecraftFabricImagePolicy : minecraftImagePolicy;
}

/** Runtime resolution already validates the exact release/build/loader against
 * upstream metadata. Use its Java requirement rather than comparing Minecraft
 * releases as SemVer or ignoring a loader's additional requirements.
 */
export function resolveMinecraftImage(runtime: ResolvedMinecraftRuntime) {
  return resolveRuntimeImage(minecraftRuntimeImagePolicy(runtime.profile), {
    gameVersion: runtime.release,
    requirements: { javaMajor: String(runtime.javaMajor) },
  });
}
