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
  /** Fresh managed-identity proof from this exact lifecycle attempt, never a cache. */
  verifiedServer?: ApplicationServer;
  /** Fixed stage names and durations only; logger failures cannot affect power. */
  onStage?(
    stage:
      | 'observer_preflight'
      | 'server_metadata'
      | 'egg_metadata'
      | 'console_session'
      | 'final_handoff'
      | 'power_request'
      | 'terminal_confirmation',
    durationMs: number,
    outcome: 'ok' | 'error',
  ): void;
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
  relayConsole(
    identifier: string,
    options: ConsoleRelayOptions,
    serverUUID: string,
  ): Promise<ConsoleRelay>;
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
  const timed = async <T>(
    stage: Parameters<NonNullable<StopConfirmationOptions['onStage']>>[0],
    work: () => Promise<T>,
  ): Promise<T> => {
    const began = performance.now();
    let outcome: 'ok' | 'error' = 'error';
    try {
      const result = await work();
      outcome = 'ok';
      return result;
    } finally {
      try {
        options.onStage?.(stage, Math.round(performance.now() - began), outcome);
      } catch {}
    }
  };
  await timed('observer_preflight', () => observer.preflight());
  const server =
    options.verifiedServer ??
    (await timed('server_metadata', () => adapter.getApplicationServer(applicationId)));
  if (
    (options.verifiedServer && server.id !== applicationId) ||
    server.identifier !== identifier ||
    !supportsStopConfirmation(
      await timed('egg_metadata', () => adapter.getEgg(server.nest, server.egg)),
    )
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
  const relay = await timed('console_session', () =>
    adapter.relayConsole(
      identifier,
      {
        authorize: options.authorize,
        onEvent,
        maxDurationMs: Math.max(1000, timeoutMs),
      },
      server.uuid,
    ),
  );
  const timer = setTimeout(() => {
    ended = true;
    finish();
  }, timeoutMs);
  let powerError: unknown;
  try {
    if (ended || !(await options.authorize()))
      throw new PterodactylError('permission_denied', 'client', 'rejected');
    await timed('final_handoff', async () => {
      await options.beforePower?.();
    });
    armed = true;
    try {
      await timed('power_request', () => adapter.power(identifier, 'stop'));
    } catch (error) {
      powerError = error;
      if (error instanceof PterodactylError && error.outcome === 'rejected') throw error;
    }
    await timed('terminal_confirmation', () => complete);
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
