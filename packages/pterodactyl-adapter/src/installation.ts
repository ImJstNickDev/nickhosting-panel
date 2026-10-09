import type { ConsoleRelay, ConsoleRelayOptions } from './console.js';
import type { ContainerObserver } from './container-observer.js';
import type { StopConfirmationOptions } from './power.js';
import { PterodactylError } from './transport.js';
import type { ApplicationServer } from './types.js';

interface Boundary {
  getApplicationServer(id: number): Promise<ApplicationServer>;
  relayConsole(identifier: string, options: ConsoleRelayOptions): Promise<ConsoleRelay>;
  reinstall(identifier: string): Promise<void>;
}
/** Panel clears installing on daemon reset too; status alone cannot prove completion. */
export async function confirmInstallation(
  adapter: Boundary,
  applicationId: number,
  identifier: string,
  options: StopConfirmationOptions,
  reinstall = false,
  timeoutMs = 300000,
  observer?: ContainerObserver,
): Promise<{ confirmed: boolean }> {
  if (!observer) throw new PterodactylError('invalid_request', 'application', 'rejected');
  await observer.preflight();
  let connected = true,
    armed = !reinstall,
    handled = false;
  let proof: Promise<void> | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const relay = await adapter.relayConsole(identifier, {
    authorize: options.authorize,
    maxDurationMs: Math.max(1000, timeoutMs),
    onEvent: (event) => {
      if (event.type === 'closed' || event.type === 'error') {
        connected = false;
        finish();
        return;
      }
      if (!connected || !armed || handled || event.type !== 'installation') return;
      handled = true;
      void (async () => {
        try {
          const server = await adapter.getApplicationServer(applicationId);
          if (
            !connected ||
            server.identifier !== identifier ||
            server.status ||
            ![true, 1].includes(server.container.installed) ||
            !(await observer.stopped(server.uuid, 'installer')) ||
            !(await options.authorize()) ||
            !connected
          )
            return;
          proof = options.onConfirmed();
          await proof;
        } catch {
          /* No status, interrupted stream or callback failure is a success proof. */
        } finally {
          finish();
        }
      })();
    },
  });
  const timer = setTimeout(() => {
    connected = false;
    finish();
  }, timeoutMs);
  try {
    if (!connected || !(await options.authorize()))
      throw new PterodactylError('permission_denied', 'client', 'rejected');
    if (reinstall) {
      armed = true;
      try {
        await adapter.reinstall(identifier);
      } catch (error) {
        if (error instanceof PterodactylError && error.outcome === 'rejected') throw error;
        // An unknown response may still produce a verifiable completion event.
      }
    }
    await done;
    if (proof) {
      await proof;
      return { confirmed: true };
    }
    return { confirmed: false };
  } finally {
    connected = false;
    clearTimeout(timer);
    relay.close();
  }
}
