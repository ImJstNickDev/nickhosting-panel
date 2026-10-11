import { isIP } from 'node:net';
import { DomainError } from '@nickhosting/core';
import {
  type GatewayControl,
  gatewayObservationSchema,
  gatewaySnapshotSchema,
  gatewayWakeRequestSchema,
  gatewayWakeResultSchema,
} from '@nickhosting/game-sdk';
import { z } from 'zod';

export interface GatewayControlClientOptions {
  baseUrl: string;
  gatewayId: string;
  token: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  fetcher?: typeof fetch;
}

/** Privileged control authentication never follows redirects, appears in URLs,
 * or crosses cleartext networks. Loopback HTTP supports same-host IPC/tests. */
export interface GatewayControlClient extends GatewayControl {
  /** Additional authenticated Core contracts must validate their own JSON response. */
  requestJson(action: string, body?: unknown): Promise<unknown>;
  close(): void;
}
/** Only minted from Core's authenticated, bounded explicit revision precondition.
 * It grants no routing authority or lease extension. */
export class GatewayRouteRevisionStaleError extends Error {
  constructor() {
    super('gateway_route_revision_stale');
    this.name = 'GatewayRouteRevisionStaleError';
  }
}

/** An authenticated provider cooldown is unavailable evidence, not a collision.
 * It never grants a new route, extends a lease or authorizes an external retry. */
export class GatewayProviderRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('gateway_provider_rate_limited');
    this.name = 'GatewayProviderRateLimitedError';
  }
}

export function createGatewayControlClient(
  options: GatewayControlClientOptions,
): GatewayControlClient {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new DomainError('configuration_invalid');
  }
  const hostname = base.hostname.replace(/^\[|\]$/g, '');
  const loopback = hostname === '::1' || (isIP(hostname) === 4 && hostname.startsWith('127.'));
  if (
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !z.uuid().safeParse(options.gatewayId).success ||
    !/^[A-Za-z0-9_-]{43,512}$/.test(options.token) ||
    !Number.isSafeInteger(options.requestTimeoutMs) ||
    options.requestTimeoutMs < 1 ||
    !Number.isSafeInteger(options.maxResponseBytes) ||
    options.maxResponseBytes < 1
  )
    throw new DomainError('configuration_invalid');
  const prefix = `${base.pathname.replace(/\/$/, '')}/internal/gateway/${options.gatewayId}`;
  const controllers = new Set<AbortController>();
  let closed = false;
  const request = async (action: string, body?: unknown) => {
    if (closed) throw new DomainError('integration_unavailable');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(action)) throw new DomainError('validation_failed');
    const url = new URL(base);
    url.pathname = `${prefix}/${action}`;
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs);
    timer.unref();
    let response: Response | undefined;
    try {
      response = await (options.fetcher ?? fetch)(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/json',
          ...(action === 'snapshot'
            ? { 'X-NickHosting-Gateway-Features': 'completed-sleep-v1' }
            : {}),
          ...(action === 'observations'
            ? { 'X-NickHosting-Gateway-Features': 'readiness-receipt-v1' }
            : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 204) return undefined;
      const reader = response.body?.getReader();
      if (!reader) throw new DomainError('integration_unavailable');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > options.maxResponseBytes) {
            await reader.cancel();
            throw new DomainError('integration_unavailable');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      if (!response.ok) {
        const cooldown = z
          .object({
            error: z.object({
              code: z.literal('integration_unavailable'),
              messageKey: z.literal('errors.integration_unavailable'),
              details: z
                .object({
                  gatewayControlReason: z.literal('provider_rate_limited'),
                  retryAfterMs: z.number().int().min(1).max(300000),
                })
                .strict(),
            }),
          })
          .safeParse(parsed);
        if (
          response.status === 503 &&
          [
            'snapshot',
            'inventory',
            'context',
            'proof-read',
            'proof-write',
            'observations',
          ].includes(action) &&
          cooldown.success
        )
          throw new GatewayProviderRateLimitedError(cooldown.data.error.details.retryAfterMs);

        const precondition = z
          .object({
            error: z.object({
              code: z.literal('conflict'),
              messageKey: z.literal('errors.conflict'),
            }),
          })
          .safeParse(parsed);
        const requested = z
          .object({ routeId: z.uuid(), routeRevision: z.number().int().positive() })
          .strict()
          .safeParse(body);
        if (
          response.status === 412 &&
          ['context', 'proof-read', 'proof-write'].includes(action) &&
          precondition.success &&
          (requested.success ||
            (action === 'proof-write' &&
              z
                .object({
                  routeId: z.uuid(),
                  routeRevision: z.number().int().positive(),
                  proof: z.unknown(),
                })
                .strict()
                .safeParse(body).success))
        )
          throw new GatewayRouteRevisionStaleError();
        throw new DomainError('integration_unavailable');
      }
      return parsed;
    } catch (error) {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      if (
        error instanceof GatewayRouteRevisionStaleError ||
        error instanceof GatewayProviderRateLimitedError
      )
        throw error;
      throw new DomainError('integration_unavailable');
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  };
  return {
    requestJson: request,
    close() {
      closed = true;
      for (const controller of controllers) controller.abort();
    },
    async fetchSnapshot() {
      const parsed = gatewaySnapshotSchema.safeParse(await request('snapshot'));
      if (!parsed.success || parsed.data.gatewayId !== options.gatewayId)
        throw new DomainError('integration_unavailable');
      return parsed.data;
    },
    async requestWake(input) {
      const value = gatewayWakeRequestSchema.safeParse(input);
      if (!value.success) throw new DomainError('validation_failed');
      const parsed = gatewayWakeResultSchema.safeParse(await request('wake', value.data));
      if (!parsed.success) throw new DomainError('integration_unavailable');
      return parsed.data;
    },
    async reportObservation(input) {
      const value = gatewayObservationSchema.safeParse(input);
      if (!value.success) throw new DomainError('validation_failed');
      const receipt = await request('observations', value.data);
      if (receipt === undefined) return;
      const parsed = gatewaySnapshotSchema.safeParse(receipt);
      if (!parsed.success || parsed.data.gatewayId !== options.gatewayId)
        throw new DomainError('integration_unavailable');
      return parsed.data;
    },
  };
}
