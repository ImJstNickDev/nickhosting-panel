import { z } from 'zod';
import type { FilemanReadService } from './fileman-read.js';

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !/[\\\p{C}]/u.test(value) &&
      value.split('/').every((part) => part && part !== '.' && part !== '..'),
  );
export const filemanTransferManifestSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
    destinationRoot: path,
    files: z
      .array(
        z.strictObject({
          path,
          size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .min(1)
      .max(20000),
  })
  .superRefine((value, context) => {
    const paths = new Set(value.files.map((file) => file.path.toLowerCase()));
    if (
      paths.size !== value.files.length ||
      !Number.isSafeInteger(value.files.reduce((n, f) => n + f.size, 0)) ||
      value.files.some(
        (file) =>
          !file.path.startsWith(`${value.destinationRoot}/`) ||
          file.path
            .split('/')
            .slice(0, -1)
            .some((_, index) =>
              paths.has(
                file.path
                  .split('/')
                  .slice(0, index + 1)
                  .join('/')
                  .toLowerCase(),
              ),
            ),
      )
    )
      context.addIssue({ code: 'custom', message: 'invalid_transfer_manifest' });
  });
export type FilemanTransferManifest = z.infer<typeof filemanTransferManifestSchema>;
export interface FilemanTransferReceipt {
  id: string;
  digest: string;
  files: number;
  bytes: number;
}
export interface FilemanArchiveSource {
  sourceSha256: string;
  contentLength: number;
  open(): ReadableStream<Uint8Array>;
  completion: Promise<{ files: { path: string; size: number; sha256: string }[]; bytes: number }>;
  cancel?(reason?: unknown): void;
}
export interface FilemanArchiveRecoveryProof extends FilemanTransferManifest {
  /** Trusted retained source, usable only after durable proof of no dispatch. */
  archive?: FilemanArchiveSource;
}
export interface FilemanArchiveRecoveryInput extends FilemanArchiveRecoveryProof {
  beforePublish(manifest: FilemanTransferManifest): Promise<void>;
  beforeWrite?: () => Promise<void>;
}
/** Host-injected service for compiled game integrations. No browser-provided
 * local path, provider credential or synthetic interactive session is accepted.
 * Uploads create a new destination tree; the caller owns game-specific staging,
 * replacement consent and selection. One manifest per operation, reused unchanged
 * on recovery. An interrupted write is never blindly replayed. */
export interface FilemanJobServices {
  /** One job-phase metadata scope, with uncached file bytes and shared read authority.
   * Create a new scope after a mutation; the host reauthorizes every external effect. */
  readScope?(): FilemanReadService;
  /** Delete one inactive top-level directory. The game interprets its small
   * configuration file; Fileman owns the identity, effect receipt and transport. */
  removeDirectory?(input: {
    target: string;
    guardFile: string;
    validateGuard(contents: string): void;
  }): Promise<void>;
  /** Bulk tree transfer. Core owns staging, provider transport and recovery;
   * the compiled integration owns file selection and its final content guard. */
  uploadArchive?(input: {
    id: string;
    destinationRoot: string;
    sourceSha256: string;
    files: readonly { path: string; size: number }[];
    contentLength: number;
    open(): ReadableStream<Uint8Array>;
    completion: Promise<{ files: { path: string; size: number; sha256: string }[]; bytes: number }>;
    cancel?(reason?: unknown): void;
    beforePublish(manifest: FilemanTransferManifest): Promise<void>;
    beforeWrite?: () => Promise<void>;
  }): Promise<FilemanTransferReceipt & { manifest: FilemanTransferManifest }>;
  /** Read-only proof of the retained request or the exact never-dispatched source. */
  assertArchiveResumable?(input: FilemanArchiveRecoveryProof): Promise<void>;
  /** Reconcile the retained provider request without uploading again, or admit the
   * exact retained source only when the host proves no upload was dispatched. */
  resumeArchive?(
    input: FilemanArchiveRecoveryInput,
  ): Promise<FilemanTransferReceipt & { manifest: FilemanTransferManifest }>;
  uploadStaged(
    input: FilemanTransferManifest & {
      open(path: string): Promise<ReadableStream<Uint8Array>>;
      beforeWrite?: () => Promise<void>;
    },
  ): Promise<FilemanTransferReceipt>;
}
