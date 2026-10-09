import { DomainError } from '@nickhosting/core';
import WebSocket from 'ws';
import { z } from 'zod';
import { allowedOrigin } from './downloads.js';
import {
  PterodactylError,
  parseInput,
  segment,
  type Transport,
  type TransportOptions,
  validatedBaseURL,
} from './transport.js';

export type ConsoleEvent =
  | { type: 'console'; data: string }
  | { type: 'status'; data: 'offline' | 'starting' | 'running' | 'stopping' }
  | { type: 'stats'; data: ConsoleStats }
  | { type: 'error'; code: 'integration_unavailable' }
  | { type: 'closed' };
const statsSchema = z.object({
  memory_bytes: z.number().nonnegative(),
  cpu_absolute: z.number().nonnegative(),
  disk_bytes: z.number().nonnegative(),
  uptime: z.number().nonnegative().optional(),
  network: z
    .object({ rx_bytes: z.number().nonnegative(), tx_bytes: z.number().nonnegative() })
    .optional(),
});
export type ConsoleStats = z.infer<typeof statsSchema>;
export interface ConsoleRelayOptions {
  onEvent(event: ConsoleEvent): void;
  /** The API must recheck the current NickHosting session/server authorization. */
  authorize(): Promise<boolean>;
  canSendCommands?: boolean;
  signal?: AbortSignal;
  maxDurationMs?: number;
}
export interface ConsoleRelay {
  sendCommand(command: string): Promise<void>;
  requestLogs(): Promise<void>;
  requestStats(): Promise<void>;
  close(): void;
}
/** Connects/authenticates upstream on the backend. The handle contains no token or URL. */
export async function createConsoleRelay(
  transport: Transport,
  options: TransportOptions & { webSocketOrigins?: string[] },
  identifier: string,
  serverUUID: string,
  input: ConsoleRelayOptions,
): Promise<ConsoleRelay> {
  const duration = parseInput(
    z.number().int().min(1000).max(3600000),
    input.maxDurationMs ?? 900000,
  );
  if (input.signal?.aborted || !(await input.authorize())) throw new DomainError('forbidden');
  const base = validatedBaseURL(options.baseURL);
  const panelWSOrigin = base.origin.replace(/^http/, 'ws');
  const origins = new Set([
    panelWSOrigin,
    ...(options.webSocketOrigins ?? []).map((origin) => allowedOrigin(origin, ['ws:', 'wss:'])),
  ]);
  const tokenSchema = z.object({
    data: z.object({ token: z.string().min(1).max(16384), socket: z.string().max(4096) }),
  });
  async function credentials() {
    const response = await transport.json(
      'client',
      `servers/${segment(identifier)}/websocket`,
      tokenSchema,
    );
    try {
      const url = new URL(response.data.socket);
      if (
        !origins.has(url.origin) ||
        !['ws:', 'wss:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== `/api/servers/${serverUUID}/ws`
      )
        throw new Error('invalid_destination');
    } catch {
      throw new PterodactylError('invalid_response', 'client', 'rejected');
    }
    return response.data;
  }
  const first = await credentials();
  if (input.signal?.aborted || !(await input.authorize())) throw new DomainError('forbidden');
  const hidden = new Set([
    first.token,
    options.applicationKey,
    ...(options.clientKey ? [options.clientKey] : []),
  ]);
  const socket = new WebSocket(first.socket, {
    origin: base.origin,
    handshakeTimeout: options.timeoutMs ?? 10000,
    maxPayload: 65536,
    followRedirects: false,
  });
  let closed = false;
  let authenticated = false;
  let authorizationCheck = false;
  let refreshPending = false;
  let rateWindow = Date.now();
  let rateBytes = 0;
  let authResolve: () => void;
  let authReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    authResolve = resolve;
    authReject = reject;
  });
  function emit(event: ConsoleEvent) {
    try {
      input.onEvent(event);
    } catch {
      close();
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(authorizationTimer);
    clearTimeout(durationTimer);
    clearTimeout(authenticationTimer);
    input.signal?.removeEventListener('abort', close);
    socket.terminate();
    authReject(new PterodactylError('unavailable', 'client', 'rejected'));
    emit({ type: 'closed' });
  }
  function fail() {
    emit({ type: 'error', code: 'integration_unavailable' });
    close();
  }
  function send(event: string, args: string[] = []) {
    if (closed || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 65536)
      throw new PterodactylError('unavailable', 'client', 'rejected');
    socket.send(JSON.stringify({ event, args }));
  }
  async function assertAuthorized() {
    if (closed || !(await input.authorize())) {
      close();
      throw new DomainError('forbidden');
    }
  }
  async function refresh() {
    if (refreshPending || closed) return;
    refreshPending = true;
    try {
      await assertAuthorized();
      const next = await credentials();
      if (next.socket !== first.socket) throw new Error('changed_destination');
      hidden.add(next.token);
      send('auth', [next.token]);
    } catch {
      fail();
    } finally {
      refreshPending = false;
    }
  }
  const authenticationTimer = setTimeout(fail, options.timeoutMs ?? 10000);
  const durationTimer = setTimeout(close, duration);
  const authorizationTimer = setInterval(() => {
    if (authorizationCheck || closed) return;
    authorizationCheck = true;
    void assertAuthorized()
      .catch(fail)
      .finally(() => {
        authorizationCheck = false;
      });
  }, 15000);
  authenticationTimer.unref();
  durationTimer.unref();
  authorizationTimer.unref();
  input.signal?.addEventListener('abort', close, { once: true });
  socket.on('open', () => {
    try {
      send('auth', [first.token]);
    } catch {
      fail();
    }
  });
  socket.on('error', fail);
  socket.on('close', close);
  if (input.signal?.aborted) close();
  socket.on('message', (raw) => {
    if (closed) return;
    try {
      const text = raw.toString();
      if (Date.now() - rateWindow >= 1000) {
        rateWindow = Date.now();
        rateBytes = 0;
      }
      rateBytes += Buffer.byteLength(text);
      if (rateBytes > 1048576) {
        fail();
        return;
      }
      const event = z
        .object({ event: z.string(), args: z.array(z.unknown()).max(32) })
        .parse(JSON.parse(text));
      if (event.event === 'auth success') {
        authenticated = true;
        clearTimeout(authenticationTimer);
        authResolve();
        return;
      }
      if (event.event === 'token expiring') {
        void refresh();
        return;
      }
      if (
        event.event === 'token expired' ||
        event.event === 'jwt error' ||
        event.event === 'daemon error'
      ) {
        fail();
        return;
      }
      if (!authenticated) return;
      if (event.event === 'console output' || event.event === 'install output') {
        let line = parseInput(z.string().max(32768), event.args[0]);
        for (const secret of hidden) line = line.replaceAll(secret, '[redacted]');
        emit({ type: 'console', data: line });
      } else if (event.event === 'status') {
        emit({
          type: 'status',
          data: parseInput(z.enum(['offline', 'starting', 'running', 'stopping']), event.args[0]),
        });
      } else if (event.event === 'stats') {
        const stats = parseInput(z.string().max(16384), event.args[0]);
        emit({ type: 'stats', data: statsSchema.parse(JSON.parse(stats)) });
      }
      // auth, JWT errors, token frames and all unrecognized events are never forwarded.
    } catch {
      fail();
    }
  });
  try {
    await ready;
  } catch (error) {
    close();
    throw error;
  }
  return {
    async sendCommand(command) {
      if (!input.canSendCommands) throw new DomainError('forbidden');
      const value = parseInput(
        z
          .string()
          .min(1)
          .max(4096)
          .refine((line) => !line.includes('\0')),
        command,
      );
      await assertAuthorized();
      send('send command', [value]);
    },
    async requestLogs() {
      await assertAuthorized();
      send('send logs');
    },
    async requestStats() {
      await assertAuthorized();
      send('send stats');
    },
    close,
  };
}
