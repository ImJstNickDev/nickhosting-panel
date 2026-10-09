import { DomainError } from '@nickhosting/core';
import { PterodactylError, type RemoteOutcome } from './transport.js';

export interface TransferOptions {
  signal?: AbortSignal;
  /** Re-read the current session and server permission; never a captured boolean. */
  authorize?: () => Promise<void>;
  /** Inactivity bound, reset by progress. There is deliberately no total duration limit. */
  idleTimeoutMs?: number;
  authorizationIntervalMs?: number;
}

export function createTransferGuard(input: TransferOptions, outcome: RemoteOutcome) {
  const idleMs = input.idleTimeoutMs ?? 30_000;
  const authMs = input.authorizationIntervalMs ?? 1000;
  if (!Number.isSafeInteger(idleMs) || idleMs < 1 || !Number.isSafeInteger(authMs) || authMs < 1)
    throw new DomainError('validation_failed');
  const controller = new AbortController();
  const failure = () => new PterodactylError('unavailable', 'client', outcome);
  let idle: ReturnType<typeof setTimeout>;
  let interval: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let lastCheck = 0;
  let checking: Promise<void> | undefined;
  const abort = () => controller.abort(failure());
  const progress = () => {
    clearTimeout(idle);
    if (!closed) {
      idle = setTimeout(abort, idleMs);
      idle.unref();
    }
  };
  const authorize = async (force = false) => {
    controller.signal.throwIfAborted();
    if (!input.authorize) return;
    if (!checking && (force || Date.now() - lastCheck >= authMs)) {
      checking = input
        .authorize()
        .then(() => {
          lastCheck = Date.now();
        })
        .catch(() => {
          abort();
          throw failure();
        })
        .finally(() => {
          checking = undefined;
        });
    }
    await checking;
    controller.signal.throwIfAborted();
  };
  const onAbort = () => abort();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) abort();
  progress();
  if (input.authorize) {
    interval = setInterval(() => {
      void authorize().catch(() => {});
    }, authMs);
    interval.unref();
  }
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    controller.signal.throwIfAborted();
    let listener: () => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      listener = () => reject(failure());
      controller.signal.addEventListener('abort', listener, { once: true });
    });
    try {
      return await Promise.race([work(), interrupted]);
    } finally {
      controller.signal.removeEventListener('abort', listener);
    }
  };
  const close = () => {
    closed = true;
    clearTimeout(idle);
    clearInterval(interval);
    input.signal?.removeEventListener('abort', onAbort);
  };
  return { signal: controller.signal, abort, progress, authorize, run, close, failure };
}
