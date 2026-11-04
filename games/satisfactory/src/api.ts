import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
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
    if (!envelope.success || envelope.data.errorCode)
      throw new DomainError('integration_unavailable', 503, { reason: 'satisfactory_api_failed' });
    return envelope.data.data;
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
