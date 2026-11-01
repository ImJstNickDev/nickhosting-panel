import { DomainError } from '@nickhosting/core';
import { z } from 'zod';

export const satisfactoryGameStateSchema = z.object({
  activeSessionName: z.string(),
  numConnectedPlayers: z.number().int().nonnegative(),
  playerLimit: z.number().int().nonnegative(),
  techTier: z.number().int().nonnegative(),
  activeSchematic: z.string(),
  gamePhase: z.string(),
  isGameRunning: z.boolean(),
  totalGameDuration: z.number().nonnegative(),
  isGamePaused: z.boolean(),
  averageTickRate: z.number().finite(),
  autoLoadSessionName: z.string(),
});
export type SatisfactoryGameState = z.infer<typeof satisfactoryGameStateSchema>;
export interface SatisfactoryApiTransport {
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
  async applyOptions(options: Record<string, string>, signal?: AbortSignal): Promise<void> {
    const parsed = z.record(z.string().min(1).max(256), z.string().max(4096)).parse(options);
    if (Object.keys(parsed).length > 128) throw new DomainError('validation_failed');
    await this.call('ApplyServerOptions', { UpdatedServerOptions: parsed }, signal);
  }
}
