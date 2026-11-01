import { z } from 'zod';
import { fileSchema, type ServerFile } from '../../../../packages/pterodactyl-adapter/src/types.js';

const storageKey = 'nickhosting.file-listing.v1';
const maxBytes = 1024 * 1024;
const maxEntries = 5000;
const snapshotSchema = z.object({
  version: z.literal(1),
  scope: z.array(z.string()).min(1),
  serverId: z.string(),
  directory: z.string(),
  files: z.array(fileSchema).max(maxEntries),
});

function withinSizeLimit(serialized: string): boolean {
  return serialized.length <= maxBytes && new TextEncoder().encode(serialized).length <= maxBytes;
}

/** One tab-local metadata snapshot; authentication and listing freshness still require the API. */
export function readFileListing(
  scope: readonly string[] | undefined,
  serverId: string,
  directory: string,
): ServerFile[] | undefined {
  if (!scope?.length) return undefined;
  try {
    const serialized = sessionStorage.getItem(storageKey);
    if (!serialized || !withinSizeLimit(serialized)) return undefined;
    const result = snapshotSchema.safeParse(JSON.parse(serialized));
    if (!result.success) return undefined;
    const snapshot = result.data;
    if (
      snapshot.serverId !== serverId ||
      snapshot.directory !== directory ||
      snapshot.scope.length !== scope.length ||
      snapshot.scope.some((value, index) => value !== scope[index])
    ) {
      return undefined;
    }
    return snapshot.files;
  } catch {
    return undefined;
  }
}

export function writeFileListing(
  scope: readonly string[] | undefined,
  serverId: string,
  directory: string,
  data: ServerFile[],
): void {
  try {
    if (!scope?.length || data.length > maxEntries) {
      clearFileListing();
      return;
    }
    // Parsing strips unknown fields, including content or signed URLs accidentally returned by an API.
    const result = snapshotSchema.safeParse({
      version: 1,
      scope,
      serverId,
      directory,
      files: data,
    });
    if (!result.success) {
      clearFileListing();
      return;
    }
    const serialized = JSON.stringify(result.data);
    if (!withinSizeLimit(serialized)) {
      clearFileListing();
      return;
    }
    sessionStorage.setItem(storageKey, serialized);
  } catch {
    clearFileListing();
  }
}

export function clearFileListing(): void {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // Storage is optional, including when the browser denies access or exhausts its quota.
  }
}
