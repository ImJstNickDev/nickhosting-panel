import { DomainError } from '@nickhosting/core';
import WebSocket from 'ws';
import { z } from 'zod';
import { type ConsoleCredentialOptions, createConsoleCredentials } from './console-credentials.js';
import { createConsoleOutboundBudget, encodeConsoleFrame } from './console-limits.js';
import { allowedOrigin } from './downloads.js';
import {
  PterodactylError,
  parseInput,
  segment,
  type Transport,
  validatedBaseURL,
} from './transport.js';

export type ConsoleEvent =
  | { type: 'console'; data: string; source?: 'installation' }
  | { type: 'status'; data: 'offline' | 'starting' | 'running' | 'stopping' }
  | { type: 'stats'; data: ConsoleStats }
  | { type: 'installation'; phase: 'started' | 'completed' }
  | { type: 'error'; code: 'integration_unavailable'; reason?: 'rate_limited' }
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
  /** Separate current write permission, in addition to stream read authorization. */
  authorizeCommand?(): Promise<boolean>;
  signal?: AbortSignal;
  maxDurationMs?: number;
}
export interface ConsoleRelay {
  /** Resolves after socket dispatch, not a Wings command acknowledgement (none
   * exists). A later upstream throttle is reported as a stream error, never replayed. */
  sendCommand(command: string): Promise<void>;
  requestLogs(): Promise<void>;
  requestStats(): Promise<void>;
  close(): void;
}
/** Connects/authenticates upstream on the backend. The handle contains no token or URL. */
export async function createConsoleRelay(
  transport: Transport,
  options: ConsoleCredentialOptions,
  identifier: string,
  serverUUID: string,
  input: ConsoleRelayOptions,
  mode: 'console' | 'installation' = 'console',
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
  const credentialSchema = z.object({
    token: z.string().min(1).max(16384),
    socket: z.string().max(4096),
  });
  const credentialPath =
    mode === 'installation'
      ? `extensions/nickhosting/servers/${segment(identifier)}/installation-websocket`
      : `servers/${segment(identifier)}/websocket`;
  function validateCredentials(value: unknown) {
    try {
      const data = credentialSchema.parse(value);
      encodeConsoleFrame('auth', [data.token]);
      const url = new URL(data.socket);
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
      return data;
    } catch {
      throw new PterodactylError('invalid_response', 'client', 'rejected');
    }
  }
  const credentials = createConsoleCredentials(
    transport,
    options,
    credentialPath,
    serverUUID,
    async () =>
      (await transport.json('client', credentialPath, z.object({ data: credentialSchema }))).data,
    validateCredentials,
  );
  const first = await credentials.read();
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
    perMessageDeflate: false,
    followRedirects: false,
  });
  let closed = false;
  let authenticated = false;
  let authorizationCheck = false;
  let refreshPending = false;
  let rateWindow = Date.now();
  let rateBytes = 0;
  let currentToken = first.token;
  let terminalError: PterodactylError | undefined;
  const outbound = createConsoleOutboundBudget();
  const pendingWrites = new Set<(error: Error) => void>();
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
    authReject(terminalError ?? new PterodactylError('unavailable', 'client', 'rejected'));
    for (const reject of pendingWrites)
      reject(terminalError ?? new PterodactylError('unavailable', 'client', 'unknown'));
    pendingWrites.clear();
    emit({ type: 'closed' });
  }
  function fail(reason?: 'rate_limited') {
    if (closed) return;
    terminalError = new PterodactylError(reason ?? 'unavailable', 'client', 'unknown');
    emit({ type: 'error', code: 'integration_unavailable', ...(reason ? { reason } : {}) });
    close();
  }
  async function send(event: string, args: string[] = []) {
    if (terminalError) throw terminalError;
    if (closed || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 65536)
      throw new PterodactylError('unavailable', 'client', 'rejected');
    const wire = outbound(event, args);
    await new Promise<void>((resolve, reject) => {
      pendingWrites.add(reject);
      const complete = (error?: Error) => {
        pendingWrites.delete(reject);
        if (error) reject(new PterodactylError('unavailable', 'client', 'unknown'));
        else if (terminalError) reject(terminalError);
        else resolve();
      };
      try {
        socket.send(wire, complete);
      } catch {
        complete(new Error('socket_write_failed'));
      }
    });
  }
  async function assertAuthorized() {
    if (terminalError) throw terminalError;
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
      const next = await credentials.read(currentToken);
      if (next.socket !== first.socket) throw new Error('changed_destination');
      hidden.add(next.token);
      currentToken = next.token;
      await send('auth', [next.token]);
    } catch {
      fail();
    } finally {
      refreshPending = false;
    }
  }
  const authenticationTimer = setTimeout(() => {
    credentials.invalidate(currentToken);
    fail();
  }, options.timeoutMs ?? 10000);
  const durationTimer = setTimeout(close, duration);
  const authorizationTimer = setInterval(() => {
    if (authorizationCheck || closed) return;
    authorizationCheck = true;
    void assertAuthorized()
      .catch(() => fail())
      .finally(() => {
        authorizationCheck = false;
      });
  }, 15000);
  authenticationTimer.unref();
  durationTimer.unref();
  authorizationTimer.unref();
  input.signal?.addEventListener('abort', close, { once: true });
  socket.on('open', () => {
    void send('auth', [first.token]).catch(() => fail());
  });
  socket.on('error', () => fail());
  socket.on('close', close);
  if (input.signal?.aborted) close();
  socket.on('message', (raw, isBinary) => {
    if (closed) return;
    try {
      if (isBinary) {
        fail();
        return;
      }
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
        .object({ event: z.string().max(128), args: z.array(z.unknown()).max(32).default([]) })
        .parse(JSON.parse(text));
      if (event.event === 'throttled') {
        // Wings supplies an event name or "global", but no command ID/ACK.
        // Do not claim acceptance or replay a possibly dispatched command.
        fail('rate_limited');
        return;
      }
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
        credentials.invalidate(currentToken);
        fail();
        return;
      }
      if (!authenticated) return;
      if (
        mode === 'installation' &&
        !['install output', 'install started', 'install completed'].includes(event.event)
      )
        return;
      if (
        event.event === 'console output' ||
        event.event === 'install output' ||
        event.event === 'daemon message'
      ) {
        let line = parseInput(z.string().max(32768), event.args[0]);
        for (const secret of hidden) line = line.replaceAll(secret, '[redacted]');
        emit({
          type: 'console',
          data: line,
          ...(event.event === 'install output' ? { source: 'installation' as const } : {}),
        });
      } else if (event.event === 'status') {
        emit({
          type: 'status',
          data: parseInput(z.enum(['offline', 'starting', 'running', 'stopping']), event.args[0]),
        });
      } else if (event.event === 'install started') {
        emit({ type: 'installation', phase: 'started' });
      } else if (event.event === 'install completed') {
        // This is a completion notification, never an installation-success claim.
        emit({ type: 'installation', phase: 'completed' });
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
      if (mode === 'installation' || !input.canSendCommands) throw new DomainError('forbidden');
      const value = parseInput(
        z
          .string()
          .min(1)
          .max(4096)
          .refine((line) => !line.includes('\0')),
        command,
      );
      await assertAuthorized();
      if (input.authorizeCommand && !(await input.authorizeCommand()))
        throw new DomainError('forbidden');
      await send('send command', [value]);
    },
    async requestLogs() {
      if (mode === 'installation') throw new DomainError('forbidden');
      await assertAuthorized();
      await send('send logs');
    },
    async requestStats() {
      if (mode === 'installation') throw new DomainError('forbidden');
      await assertAuthorized();
      await send('send stats');
    },
    close,
  };
}
