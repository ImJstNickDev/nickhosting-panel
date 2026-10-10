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

/** Runtime resolution already validates the exact release/build/loader against
 * upstream metadata. Use its Java requirement rather than comparing Minecraft
 * releases as SemVer or applying Vanilla ranges to a different loader.
 */
export function resolveMinecraftImage(runtime: ResolvedMinecraftRuntime) {
  return resolveRuntimeImage(minecraftImagePolicy, {
    gameVersion: runtime.release,
    requirements: { javaMajor: String(runtime.javaMajor) },
  });
}
