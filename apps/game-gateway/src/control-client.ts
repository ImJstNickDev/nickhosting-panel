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
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new DomainError('integration_unavailable');
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
      return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
    } catch {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
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
      await request('observations', value.data);
    },
  };
}
