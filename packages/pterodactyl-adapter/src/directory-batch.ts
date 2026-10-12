import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import {
  PterodactylError,
  parseInput,
  readBounded,
  relativePath,
  segment,
  type Transport,
} from './transport.js';
import { fileSchema } from './types.js';

const settingsSchema = z.strictObject({
  directoryBatchLimit: z.number().int().min(1).max(64),
  directoryConcurrency: z.number().int().min(1).max(4),
  directoryTimeoutSeconds: z.number().int().min(1).max(10),
});
const resultSchema = z.union([
  z.strictObject({ directory: z.string(), files: z.array(fileSchema).max(10000) }),
  z.strictObject({
    directory: z.string(),
    error: z.enum(['not_found', 'forbidden', 'unavailable', 'too_large', 'deadline_exceeded']),
  }),
]);
const responseSchema = z.strictObject({ results: z.array(resultSchema).min(1).max(64) });
export type DirectoryBatchSettings = z.infer<typeof settingsSchema>;
export type DirectoryBatchResult = z.infer<typeof resultSchema>;
const endpoint = (identifier: string, operation: string) =>
  `extensions/nickhosting/servers/${segment(identifier)}/${operation}`;

/** Explicit experimental probe: older extensions report their native 404, without fallback. */
export function getDirectoryBatchSettings(transport: Transport, identifier: string) {
  return transport.json('client', endpoint(identifier, 'directory-settings'), settingsSchema);
}

/** Metadata only. No recursion, download preparation, per-path retries or implicit discovery. */
export async function listDirectoriesBatch(
  transport: Transport,
  identifier: string,
  directories: string[],
): Promise<DirectoryBatchResult[]> {
  const paths = parseInput(z.array(z.string()).min(1).max(64), directories);
  if (new Set(paths).size !== paths.length) throw new DomainError('validation_failed');
  for (const path of paths) {
    // Match the extension's byte and Unicode validation without normalizing caller paths.
    if (Buffer.byteLength(path, 'utf8') > 4096 || /\p{C}/u.test(path))
      throw new DomainError('validation_failed');
    relativePath(path, true);
  }
  let response: Response;
  try {
    response = await transport.request('client', endpoint(identifier, 'directory-list'), 'POST', {
      directories: paths,
    });
  } catch (error) {
    // POST carries a query, not a filesystem mutation: a lost response has no uncertain effect.
    if (error instanceof PterodactylError && error.outcome === 'unknown')
      throw new PterodactylError(
        error.reason,
        error.scope,
        'rejected',
        error.upstreamStatus,
        error.retryAfterMs,
      );
    throw error;
  }
  try {
    // This batch alone allows 8 MiB; ordinary adapter JSON responses retain their 4 MiB cap.
    const payload: unknown = JSON.parse(
      Buffer.from(await readBounded(response, 8 * 1024 * 1024)).toString('utf8'),
    );
    const { results } = responseSchema.parse(payload);
    if (
      results.length !== paths.length ||
      results.some((result, index) => result.directory !== paths[index])
    )
      throw new Error('Directory batch does not match the request');
    return results;
  } catch {
    throw new PterodactylError('invalid_response', 'client', 'rejected');
  }
}
