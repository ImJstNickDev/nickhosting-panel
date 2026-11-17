/** Offline authentication depends on a verified native credential format and
 * fingerprint algorithm. This is not a runtime, update or readiness allowlist. */
export const satisfactoryOfflineAuthenticationBuild = 513885;

export function supportsSatisfactoryOfflineAuthentication(build: number): boolean {
  return build === satisfactoryOfflineAuthenticationBuild;
}
