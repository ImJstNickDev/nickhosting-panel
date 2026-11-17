import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { satisfactoryApiError } from './api-errors.js';
import { type SatisfactorySessionEvent, streamSatisfactorySessions } from './sessions-stream.js';

export {
  type SatisfactoryGameState,
  satisfactoryGameStateSchema,
  satisfactorySaveHeaderSchema,
  satisfactorySessionsSchema,
} from './api-schemas.js';

import {
  type SatisfactoryGameState,
  satisfactoryGameStateSchema,
  satisfactorySessionsSchema,
} from './api-schemas.js';
export interface SatisfactoryApiTransport {
  streamRequest?(
    body: { function: string; data?: Record<string, unknown> },
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>;
  /** The caller provides an authenticated, certificate-verified per-server transport. */
  request(
    body: { function: string; data?: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<unknown>;
}
export class SatisfactoryApi {
  constructor(private readonly transport: SatisfactoryApiTransport) {}
  private async call(
    name: string,
    data?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.transport.request(
      { function: name, ...(data ? { data } : {}) },
      signal,
    );
    if (response === undefined) return undefined;
    const envelope = z
      .object({ data: z.unknown().optional(), errorCode: z.string().optional() })
      .safeParse(response);
    if (!envelope.success)
      throw new DomainError('integration_unavailable', 503, { reason: 'satisfactory_api_failed' });
    if (envelope.data.errorCode) throw satisfactoryApiError(envelope.data.errorCode);
    return envelope.data.data;
  }
  private authenticationToken(value: unknown): string {
    const parsed = z
      .object({
        authenticationToken: z
          .string()
          .min(1)
          .max(8192)
          .regex(/^[\x21-\x7e]+$/),
      })
      .safeParse(value);
    if (!parsed.success) throw new DomainError('integration_unavailable');
    return parsed.data.authenticationToken;
  }
  async passwordlessLogin(privilege: 'InitialAdmin', signal?: AbortSignal): Promise<string> {
    return this.authenticationToken(
      await this.call('PasswordlessLogin', { MinimumPrivilegeLevel: privilege }, signal),
    );
  }
  async passwordLogin(password: string, signal?: AbortSignal): Promise<string> {
    return this.authenticationToken(
      await this.call(
        'PasswordLogin',
        { MinimumPrivilegeLevel: 'Administrator', Password: password },
        signal,
      ),
    );
  }
  async claim(name: string, password: string, signal?: AbortSignal): Promise<string> {
    return this.authenticationToken(
      await this.call('ClaimServer', { ServerName: name, AdminPassword: password }, signal),
    );
  }
  async setClientPassword(password: string, signal?: AbortSignal): Promise<void> {
    await this.call('SetClientPassword', { Password: password }, signal);
  }
  async generateApplicationToken(signal?: AbortSignal): Promise<string> {
    const response = z
      .object({ commandResult: z.string().max(65536) })
      .safeParse(await this.call('RunCommand', { Command: 'server.GenerateAPIToken' }, signal));
    if (!response.success) throw new DomainError('integration_unavailable');
    // Read the native command's token, never construct one. Ignore human text,
    // and reject ambiguous output rather than storing the wrong credential.
    const candidates = response.data.commandResult.match(/[A-Za-z0-9+/]+=*\.[a-fA-F0-9]+/g) ?? [];
    const tokens = [...new Set(candidates.filter(isSatisfactoryApplicationToken))];
    const token = tokens[0];
    if (tokens.length !== 1 || !token) throw new DomainError('integration_unavailable');
    return token;
  }
  /** Native verification binds the raw fingerprint to Administrator and the
   * player ID supplied by the certificate-pinned transport. Only HTTP 204 maps
   * to undefined; a JSON success-shaped response is not verification. */
  async verifyConsoleAdministrator(fingerprint: string, signal?: AbortSignal): Promise<boolean> {
    if (!/^[a-f\d]{128}$/i.test(fingerprint)) return false;
    return (
      (await this.transport.request(
        {
          function: 'VerifyAuthenticationToken',
          data: { AuthenticationToken: fingerprint, PrivilegeLevel: 'Administrator' },
        },
        signal,
      )) === undefined
    );
  }
  async state(signal?: AbortSignal): Promise<SatisfactoryGameState> {
    const result = z
      .object({ serverGameState: satisfactoryGameStateSchema })
      .safeParse(await this.call('QueryServerState', undefined, signal));
    if (!result.success)
      throw new DomainError('integration_unavailable', 503, {
        reason: 'satisfactory_state_invalid',
      });
    return result.data.serverGameState;
  }
  async health(signal?: AbortSignal): Promise<boolean> {
    const result = z
      .object({ health: z.enum(['healthy', 'slow']), serverCustomData: z.string() })
      .safeParse(await this.call('HealthCheck', { ClientCustomData: '' }, signal));
    return result.success;
  }
  async save(name: string, signal?: AbortSignal): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new DomainError('validation_failed');
    await this.call('SaveGame', { SaveName: name }, signal);
  }
  async createWorld(sessionName: string, signal?: AbortSignal): Promise<void> {
    await this.call(
      'CreateNewGame',
      {
        NewGameData: {
          SessionName: sessionName,
          StartingLocation: '',
          SkipOnboarding: true,
          AdvancedGameSettings: {},
          CustomOptionsOnlyForModding: {},
        },
      },
      signal,
    );
  }
  async loadWorld(
    saveName: string,
    enableAdvancedGameSettings: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call(
      'LoadGame',
      { SaveName: saveName, EnableAdvancedGameSettings: enableAdvancedGameSettings },
      signal,
    );
  }
  async applyAdvancedSettings(
    settings: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call('ApplyAdvancedGameSettings', { AppliedAdvancedGameSettings: settings }, signal);
  }
  async shutdown(signal?: AbortSignal): Promise<void> {
    await this.call('Shutdown', undefined, signal);
  }
  async saveAndStop(name: string, signal?: AbortSignal): Promise<void> {
    if ((await this.state(signal)).isGameRunning) await this.save(name, signal);
    await this.shutdown(signal);
  }
  async options(signal?: AbortSignal): Promise<{
    serverOptions: Record<string, string>;
    pendingServerOptions: Record<string, string>;
  }> {
    const result = z
      .object({
        serverOptions: z.record(z.string(), z.string()),
        pendingServerOptions: z.record(z.string(), z.string()),
      })
      .safeParse(await this.call('GetServerOptions', undefined, signal));
    if (!result.success) throw new DomainError('integration_unavailable');
    return result.data;
  }
  /** Fresh native save metadata, validated with the same schema as offline reads. */
  async sessions(signal?: AbortSignal): Promise<z.infer<typeof satisfactorySessionsSchema>> {
    return satisfactorySessionsSchema.parse(
      await this.call('EnumerateSessions', undefined, signal),
    );
  }
  async *streamSessions(signal?: AbortSignal): AsyncGenerator<SatisfactorySessionEvent> {
    if (!this.transport.streamRequest) throw new DomainError('integration_unavailable');
    yield* streamSatisfactorySessions(
      this.transport.streamRequest({ function: 'EnumerateSessions' }, signal),
    );
  }
  /** A first-time setup without a world must remain online. Historical names or
   * snapshots cannot establish that a save still exists on this backend. */
  async canAutoSleep(state: SatisfactoryGameState, signal?: AbortSignal): Promise<boolean> {
    if (state.numConnectedPlayers !== 0) return false;
    // saveAndStop persists an active world before shutdown, even its first save.
    if (state.isGameRunning) return true;
    try {
      const current = await this.sessions(signal);
      return current.sessions.some((session) => session.saveHeaders.length > 0);
    } catch {
      // Unknown world availability vetoes sleep without losing live readiness.
      return false;
    }
  }
  async advancedSettings(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return z
      .record(z.string(), z.unknown())
      .parse(await this.call('GetAdvancedGameSettings', undefined, signal));
  }
  async applyOptions(options: Record<string, string>, signal?: AbortSignal): Promise<void> {
    const parsed = z.record(z.string().min(1).max(256), z.string().max(4096)).parse(options);
    if (Object.keys(parsed).length > 128) throw new DomainError('validation_failed');
    await this.call('ApplyServerOptions', { UpdatedServerOptions: parsed }, signal);
  }
}

export function isSatisfactoryApplicationToken(token: string): boolean {
  if (token.length > 8192 || !/^[A-Za-z0-9+/]+=*\.[a-fA-F0-9]+$/.test(token)) return false;
  try {
    return (
      JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64').toString('utf8')).pl ===
      'APIToken'
    );
  } catch {
    return false;
  }
}
