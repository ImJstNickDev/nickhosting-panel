import type { ConsoleEvent, ConsoleRelay, ConsoleRelayOptions } from './console.js';
import type { ContainerObserver } from './container-observer.js';
import { PterodactylError } from './transport.js';
import type { ApplicationServer, Egg } from './types.js';

/** Panel ^C means native Docker stop; other caret values are asynchronous signals. */
export function supportsStopConfirmation(egg: Pick<Egg, 'config' | 'relationships'>): boolean {
  const stop = egg.relationships?.config?.attributes?.stop ?? egg.config?.stop;
  return (
    typeof stop === 'string' &&
    stop.trim().length > 0 &&
    (!stop.startsWith('^') || stop.toUpperCase() === '^C')
  );
}
export interface StopConfirmationOptions {
  authorize(): Promise<boolean>;
  /** Final permission fence immediately before a new power request. Ongoing
   * console authorization must not confuse its expiry with proof invalidation. */
  beforePower?(): Promise<void>;
  /** Durably persist the proof before this method can report confirmed. */
  onConfirmed(): Promise<void>;
}
interface Boundary {
  getApplicationServer(id: number): Promise<ApplicationServer>;
  getEgg(nestId: number, eggId: number): Promise<Egg>;
  relayConsole(identifier: string, options: ConsoleRelayOptions): Promise<ConsoleRelay>;
  power(identifier: string, action: 'stop'): Promise<void>;
}
/** A missed proof stays uncertain. No polling/cache age can substitute for this sequence. */
export async function stopWithConfirmation(
  adapter: Boundary,
  applicationId: number,
  identifier: string,
  options: StopConfirmationOptions,
  timeoutMs = 60000,
  observer?: ContainerObserver,
): Promise<{ confirmed: boolean }> {
  if (!observer) throw new PterodactylError('invalid_request', 'application', 'rejected');
  await observer.preflight();
  const server = await adapter.getApplicationServer(applicationId);
  if (
    server.identifier !== identifier ||
    !supportsStopConfirmation(await adapter.getEgg(server.nest, server.egg))
  )
    throw new PterodactylError('invalid_request', 'application', 'rejected');
  let armed = false,
    stopping = false,
    ended = false,
    proof: Promise<void> | undefined;
  let confirmed = false;
  let finish!: () => void;
  const complete = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onEvent = (event: ConsoleEvent) => {
    if (ended) return;
    if (event.type === 'closed' || event.type === 'error') {
      ended = true;
      finish();
      return;
    }
    if (!armed || event.type !== 'status') return;
    if (event.data === 'stopping') stopping = true;
    else if (event.data === 'offline' && stopping) {
      ended = true;
      proof = (async () => {
        if (!(await observer.stopped(server.uuid, 'server'))) return;
        await options.onConfirmed();
        confirmed = true;
      })();
      void proof.then(finish, finish);
    } else stopping = false;
  };
  const relay = await adapter.relayConsole(identifier, {
    authorize: options.authorize,
    onEvent,
    maxDurationMs: Math.max(1000, timeoutMs),
  });
  const timer = setTimeout(() => {
    ended = true;
    finish();
  }, timeoutMs);
  let powerError: unknown;
  try {
    if (ended || !(await options.authorize()))
      throw new PterodactylError('permission_denied', 'client', 'rejected');
    await options.beforePower?.();
    armed = true;
    try {
      await adapter.power(identifier, 'stop');
    } catch (error) {
      powerError = error;
      if (error instanceof PterodactylError && error.outcome === 'rejected') throw error;
    }
    await complete;
    if (proof) {
      await proof;
      return { confirmed };
    }
    if (powerError) throw powerError;
    return { confirmed: false };
  } finally {
    ended = true;
    clearTimeout(timer);
    relay.close();
  }
}
