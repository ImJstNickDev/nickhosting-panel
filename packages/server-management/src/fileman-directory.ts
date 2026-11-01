import { DomainError } from '@nickhosting/core';
import type { FilemanJobServices } from '@nickhosting/game-sdk';
import type { GuardedDirectoryDelete } from '@nickhosting/pterodactyl-adapter';
import type { GameLifecycleContext } from './lifecycle.js';
import { providerFileIdentity } from './provider-file-operations.js';

/** This method deliberately accepts only a root directory: there is no unchecked
 * ancestor/symlink traversal. Blueprint binds a receipt to this exact observation,
 * and retries return that receipt instead of deleting a newly recreated folder. */
export async function removeFilemanDirectory(
  context: GameLifecycleContext,
  input: Parameters<NonNullable<FilemanJobServices['removeDirectory']>>[0],
) {
  if (!/^[^/\\\p{C}]+$/u.test(input.target) || ['.', '..'].includes(input.target))
    throw new DomainError('validation_failed');
  const identity = await providerFileIdentity(context.db, context.server);
  const identifier = identity.identifier;
  const jobId = context.operation().job_id;
  const phase = 'fileman.directory.remove';
  const prior = context.operation().plan.fileDirectoryRemoval as
    | { request?: GuardedDirectoryDelete; completed?: boolean }
    | undefined;
  let request = prior?.request;
  if (request) {
    if (
      request.operationId !== jobId ||
      request.target.path !== input.target ||
      request.guard.path !== input.guardFile ||
      Object.entries(identity).some(
        ([key, value]) => request?.identity[key as keyof typeof identity] !== value,
      )
    )
      throw new DomainError('conflict');
    if (prior?.completed) return;
  } else {
    await context.authorize();
    const snapshot = await context.adapter.inspectFileOperation(identifier, {
      target: input.target,
      guardFile: input.guardFile,
    });
    if (
      Object.entries(identity).some(
        ([key, value]) => snapshot.identity[key as keyof typeof identity] !== value,
      )
    )
      throw new DomainError('provenance_mismatch');
    input.validateGuard(snapshot.guard.contents);
    request = {
      operationId: jobId,
      identity,
      target: snapshot.target,
      guard: { path: snapshot.guard.path, sha256: snapshot.guard.sha256 },
    };
    await context.update({
      plan: { ...context.operation().plan, fileDirectoryRemoval: { request, completed: false } },
    });
  }
  const expected = request;
  await context.effect(phase, async () => {
    const receipt = await context.adapter.guardedDeleteDirectory(identifier, expected);
    if (receipt.state !== 'confirmed') throw new DomainError('operation_uncertain');
  });
  await context.update({
    plan: {
      ...context.operation().plan,
      fileDirectoryRemoval: { request: expected, completed: true },
    },
  });
}
