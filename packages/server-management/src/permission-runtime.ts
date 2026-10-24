import type { ManagementRuntime } from './runtime.js';

/** Domain file operations keep all native identity/lock/session fences while
 * authorizing their declared capability instead of granting arbitrary Files access. */
export function permissionRuntime(
  runtime: ManagementRuntime,
  resource: string,
  writeAction = 'write',
): ManagementRuntime {
  const read = `${resource}.read`,
    write = `${resource}.${writeAction}`;
  return {
    ...runtime,
    access: (context, id, mutate, work, timing, permission = mutate ? write : read) =>
      runtime.access(context, id, mutate, work, timing, permission),
    fileReadAccess: (context, id, work, timing, permission = read) =>
      runtime.fileReadAccess(context, id, work, timing, permission),
    fileReadScope: (context, id, work, signal, permission = read) =>
      runtime.fileReadScope(context, id, work, signal, permission),
    fileMutationAccess: (context, id, work, timing, permission = write) =>
      runtime.fileMutationAccess(context, id, work, timing, permission),
    uploadBatchAccess: (context, id, work, prepare, timing, transfer, permission = write) =>
      runtime.uploadBatchAccess(context, id, work, prepare, timing, transfer, permission),
    authorizeTransfer: (
      context,
      id,
      mutate,
      connection,
      timing,
      expected,
      cleanup,
      permission = mutate ? write : read,
    ) =>
      runtime.authorizeTransfer(
        context,
        id,
        mutate,
        connection,
        timing,
        expected,
        cleanup,
        permission,
      ),
  };
}
