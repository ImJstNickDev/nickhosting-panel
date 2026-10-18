import type { BigIntStats } from 'node:fs';
import { lstat } from 'node:fs/promises';

/** Ephemeral proof from a trusted local source reader. Never persisted or accepted
 * from an API payload: a later phase may reuse its hash only while identity matches. */
export interface ContentFileVerification {
  path: string;
  sha256: string;
  identity: BigIntStats;
}

export async function contentFileUnchanged(path: string, before: BigIntStats): Promise<boolean> {
  const after = await lstat(path, { bigint: true });
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.size === before.size &&
    after.mtimeNs === before.mtimeNs &&
    after.ctimeNs === before.ctimeNs
  );
}
