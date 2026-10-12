import { PterodactylError } from './transport.js';

// Proof is attached to error identity, not a provider outcome/status. The marker
// stays internal to the adapter; consumers may only inspect it through the barrel.
const notDispatched = new WeakSet<Error>();

export function uploadNotDispatched(error: unknown): Error {
  const failure =
    error instanceof Error ? error : new PterodactylError('unavailable', 'client', 'rejected');
  notDispatched.add(failure);
  return failure;
}

/** True only when the upload adapter proved it never invoked the Wings POST. */
export function isUploadNotDispatched(error: unknown): error is Error {
  return error instanceof Error && notDispatched.has(error);
}
