import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { providerIdentitySchema } from './blueprint.js';
import {
  PterodactylError,
  parseInput,
  relativePath,
  segment,
  type Transport,
} from './transport.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .superRefine((path, context) => {
    try {
      relativePath(path);
      if (Buffer.byteLength(path, 'utf8') > 4096 || /\p{C}/u.test(path)) throw new Error();
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid relative path' });
    }
  });
const targetSchema = z.strictObject({ path: pathSchema, observation: digest });
const guardSchema = z.strictObject({ path: pathSchema, sha256: digest });
const inspectionInput = z.strictObject({ target: pathSchema, guardFile: pathSchema });
const inspectionSchema = z.strictObject({
  identity: providerIdentitySchema,
  target: targetSchema,
  guard: guardSchema.extend({ contents: z.string().max(1048576) }),
});
const deletionInput = z.strictObject({
  operationId: z.uuid(),
  identity: providerIdentitySchema,
  target: targetSchema,
  guard: guardSchema,
});
const receiptSchema = z.strictObject({
  operationId: z.uuid(),
  state: z.enum(['confirmed', 'uncertain']),
  identity: providerIdentitySchema,
  target: targetSchema,
});
const capabilitySchema = z.strictObject({
  inspection: z.literal(true),
  guardedDelete: z.literal(true),
  archiveCommit: z.literal(true),
});
export type FileOperationInspection = z.infer<typeof inspectionSchema>;
export type GuardedDirectoryDelete = z.infer<typeof deletionInput>;
export type FileOperationReceipt = z.infer<typeof receiptSchema>;
const endpoint = (identifier: string, action: string) =>
  `extensions/nickhosting/servers/${segment(identifier)}/${action}`;

export function getFileOperationCapabilities(transport: Transport, identifier: string) {
  return transport.json(
    'client',
    endpoint(identifier, 'file-operation-capabilities'),
    capabilitySchema,
  );
}

export async function inspectFileOperation(
  transport: Transport,
  identifier: string,
  input: { target: string; guardFile: string },
): Promise<FileOperationInspection> {
  const body = parseInput(inspectionInput, input);
  try {
    const result = await transport.json(
      'client',
      endpoint(identifier, 'file-inspection'),
      inspectionSchema,
      'POST',
      body,
    );
    if (result.target.path !== body.target || result.guard.path !== body.guardFile)
      throw new PterodactylError('invalid_response', 'client', 'rejected');
    return result;
  } catch (error) {
    // Read-only POST has no uncertain filesystem side effect.
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
}

export async function guardedDeleteDirectory(
  transport: Transport,
  identifier: string,
  input: GuardedDirectoryDelete,
): Promise<FileOperationReceipt> {
  const body = parseInput(deletionInput, input);
  if (body.target.path === body.guard.path || body.guard.path.startsWith(`${body.target.path}/`))
    throw new DomainError('validation_failed');
  const receipt = await transport.json(
    'client',
    endpoint(identifier, 'guarded-delete'),
    receiptSchema,
    'POST',
    body,
  );
  if (
    receipt.operationId !== body.operationId ||
    receipt.target.path !== body.target.path ||
    receipt.target.observation !== body.target.observation ||
    Object.entries(body.identity).some(
      ([key, value]) => receipt.identity[key as keyof typeof receipt.identity] !== value,
    )
  )
    throw new PterodactylError('invalid_response', 'client', 'unknown');
  return receipt;
}

const archiveInput = z.strictObject({
  operationId: z.uuid(),
  identity: providerIdentitySchema,
  destinationRoot: pathSchema,
  archiveSha256: digest,
  files: z
    .array(
      z.strictObject({
        path: pathSchema,
        size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .min(1)
    .max(10000),
});
const archiveReceipt = z.strictObject({
  operationId: z.uuid(),
  state: z.enum(['confirmed', 'uncertain']),
  identity: providerIdentitySchema,
  destinationRoot: pathSchema,
  archiveSha256: digest,
});
export type FileArchiveCommit = z.infer<typeof archiveInput>;
export type FileArchiveReceipt = z.infer<typeof archiveReceipt>;
export async function commitFileArchive(
  transport: Transport,
  identifier: string,
  input: FileArchiveCommit,
): Promise<FileArchiveReceipt> {
  const body = parseInput(archiveInput, input);
  if (
    body.destinationRoot.includes('/') ||
    body.destinationRoot.startsWith('.nickhosting-import-') ||
    body.files.some((file) => !file.path.startsWith(`${body.destinationRoot}/`)) ||
    new Set(body.files.map((file) => file.path)).size !== body.files.length ||
    Buffer.byteLength(JSON.stringify(body), 'utf8') > 4194304
  )
    throw new DomainError('validation_failed');
  const receipt = await transport.json(
    'client',
    endpoint(identifier, 'archive-commit'),
    archiveReceipt,
    'POST',
    body,
    false,
    { timeoutMs: 90000 },
  );
  if (
    receipt.operationId !== body.operationId ||
    receipt.destinationRoot !== body.destinationRoot ||
    receipt.archiveSha256 !== body.archiveSha256 ||
    Object.entries(body.identity).some(
      ([key, value]) => receipt.identity[key as keyof typeof receipt.identity] !== value,
    )
  )
    throw new PterodactylError('invalid_response', 'client', 'unknown');
  return receipt;
}
