import { DomainError } from '@nickhosting/core';

/** Vanilla's supported Java baseline. Loader profiles resolve their own requirements.
 * A server artifact and protocol/installation evidence remain separate prerequisites. */
export const vanillaJavaRanges = [
  { min: '1.0', max: '1.16.5', javaMajor: 8 },
  { min: '1.17', max: '1.17.1', javaMajor: 16 },
  { min: '1.18', max: '1.20.4', javaMajor: 17 },
  { min: '1.20.5', max: '1.21.11', javaMajor: 21 },
  { min: '26.1', javaMajor: 25 },
] as const;
function compare(left: string, right: string) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
export function vanillaJavaMajor(
  release: string,
  releaseType: 'release' | 'snapshot' | 'old_alpha' | 'old_beta',
  officialMajor?: number,
): number {
  let declared: number | undefined;
  if (releaseType === 'old_alpha' || releaseType === 'old_beta') declared = 8;
  else if (releaseType === 'release' && /^\d+\.\d+(?:\.\d+)?$/.test(release)) {
    declared = vanillaJavaRanges.find(
      (range) =>
        compare(release, range.min) >= 0 && (!('max' in range) || compare(release, range.max) <= 0),
    )?.javaMajor;
  }
  // Snapshots are not ordered as releases; Mojang's hash-verified metadata is authoritative.
  if (declared === undefined) {
    if (officialMajor !== undefined) return officialMajor;
    throw new DomainError('integration_unavailable', 503, { reason: 'minecraft_java_unknown' });
  }
  if (officialMajor !== undefined && officialMajor !== declared)
    throw new DomainError('integration_unavailable', 503, {
      reason: 'minecraft_java_policy_mismatch',
    });
  return declared;
}
