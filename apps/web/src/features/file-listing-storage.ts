export const fileListingStorageKey = 'nickhosting.file-listing.v1';

export function clearFileListing(): void {
  try {
    sessionStorage.removeItem(fileListingStorageKey);
  } catch {
    // Storage is optional, including when the browser denies access or exhausts its quota.
  }
}
