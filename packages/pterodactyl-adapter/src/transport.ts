import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import type { ContainerObserver } from './container-observer.js';
import {
  assertProviderReadActive,
  createProviderReadAttribution,
  isBackgroundProviderRead,
} from './provider-read-attribution.js';

export type CredentialScope = 'application' | 'client';
export type RemoteOutcome = 'rejected' | 'unknown';
export class PterodactylError extends DomainError {
  constructor(
    readonly reason:
      | 'credential_missing'
      | 'permission_denied'
      | 'not_found'
      | 'invalid_request'
      | 'rate_limited'
      | 'unavailable'
      | 'invalid_response',
    readonly scope: CredentialScope,
    readonly outcome: RemoteOutcome,
    readonly upstreamStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super('integration_unavailable', 503, {
      provider: 'pterodactyl',
      reason,
      scope,
      outcome,
      upstreamStatus,
      retryAfterMs,
    });
    this.name = 'PterodactylError';
  }
}
export interface TransportOptions {
  containerObserver?: ContainerObserver;
  coordinator?: ReturnType<typeof createTransportCoordinator>;
  baseURL: string;
  applicationKey: string;
  clientKey?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}
export function validatedBaseURL(value: string): URL {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    url.pathname = `${url.pathname.replace(/\/$/, '')}/`;
    return url;
  } catch {
    throw new DomainError('validation_failed');
  }
}
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DomainError('validation_failed');
  return parsed.data;
}
export function numericId(value: number): number {
  return parseInput(z.number().int().positive(), value);
}
export function segment(value: string): string {
  return encodeURIComponent(
    parseInput(
      z
        .string()
        .min(1)
        .max(191)
        .regex(/^[A-Za-z0-9_-]+$/),
      value,
    ),
  );
}
/** Relative paths only. Encoded separators/dot-segments are rejected before any provider call. */
export function relativePath(value: string, allowRoot = false): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    /[\\%]/.test(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.split('/').some((part) => part === '.' || part === '..' || part === '')
  ) {
    if (allowRoot && value === '') return '/';
    throw new DomainError('validation_failed');
  }
  return `/${value}`;
}
export class ResponseTooLargeError extends Error {
  constructor() {
    super('response_too_large');
  }
}
export async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new ResponseTooLargeError();
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new ResponseTooLargeError();
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}
interface RequestScope {
  activeRequests: number;
  cooldownUntil: number;
  pendingJson: Map<string, Promise<string>>;
  publishedRateLimit?: { limit: number; at: number };
}
/** Share between adapters for one application process. It stores no plaintext credentials. */
export function createTransportCoordinator(
  runtime?: 'api' | 'worker',
  budget?: {
    acquire(binding: string, background: boolean): Promise<number>;
    observe(binding: string, limit: number, cooldownMs: number): Promise<void>;
  },
) {
  const scopes = new Map<string, RequestScope>();
  return {
    ...createProviderReadAttribution(runtime),
    budget,
    scope(identity: string, credentialScope: CredentialScope): RequestScope {
      const existing = scopes.get(identity);
      if (existing) return existing;
      if (scopes.size >= 1024) {
        for (const [key, state] of scopes) {
          if (
            state.cooldownUntil <= Date.now() &&
            state.pendingJson.size === 0 &&
            state.activeRequests === 0
          ) {
            scopes.delete(key);
            break;
          }
        }
      }
      const state: RequestScope = { activeRequests: 0, cooldownUntil: 0, pendingJson: new Map() };
      // Saturation never discards an in-flight request or bypasses an active cooldown.
      if (scopes.size >= 1024)
        throw new PterodactylError('unavailable', credentialScope, 'rejected');
      scopes.set(identity, state);
      return state;
    },
  };
}
/** A provider cannot make local callers wait indefinitely or supply arbitrary error text. */
function retryDelay(value: string | null, now: number): number {
  let duration = Number.NaN;
  if (value !== null && /^\d+$/.test(value.trim())) duration = Number(value) * 1000;
  else if (value !== null && /^[A-Za-z]{3}, /.test(value)) duration = Date.parse(value) - now;
  return Number.isFinite(duration) ? Math.min(300_000, Math.max(1000, duration)) : 60_000;
}
/** These routes also have server-wide limits in Panel, independent of the API
 * credential. Headers do not identify which nested limiter returned a 429. An
 * ambiguous resource response therefore cannot freeze unrelated Client traffic;
 * a 429 from an ordinary route still establishes the credential-wide cooldown. */
function resourceLimit(path: string, method: string): string | undefined {
  const match = /^servers\/([^/?]+)\/(.+?)(?:\?.*)?$/.exec(path);
  if (!match) return;
  const [, server, resource] = match;
  if (method === 'GET' && resource === 'websocket') return `${server}:websocket`;
  if (method !== 'POST') return;
  if (/^backups\/[^/]+\/restore$/.test(resource ?? '')) return `${server}:backup-restore`;
  // Backup creation has its own service-level throttle, separate from restore.
  if (resource === 'backups') return `${server}:backup-create`;
  if (
    ['databases', 'files/pull', 'schedules', 'network/allocations', 'users'].includes(
      resource ?? '',
    )
  )
    return `${server}:${resource}`;
}
export function createTransport(options: TransportOptions) {
  const base = validatedBaseURL(options.baseURL);
  const timeoutMs = parseInput(z.number().int().min(1).max(120000), options.timeoutMs ?? 10000);
  for (const key of [options.applicationKey, options.clientKey]) {
    if (key !== undefined && (!key.trim() || key.length > 4096 || /[\r\n]/.test(key)))
      throw new DomainError('validation_failed');
  }
  const fetcher = options.fetcher ?? fetch;
  const coordinator = options.coordinator ?? createTransportCoordinator();
  function binding(scope: CredentialScope) {
    const credential = scope === 'application' ? options.applicationKey : options.clientKey;
    return createHash('sha256')
      .update(JSON.stringify([base.href, scope, credential]))
      .digest('hex');
  }
  const applicationBinding = binding('application');
  const clientBinding = binding('client');
  // NickPanel configures one Application principal per provider. Rotating its
  // key does not reset Pterodactyl's user-level budget. Auth caches stay keyed by credential.
  const providerBudgetBinding = createHash('sha256').update(base.href).digest('hex');
  function state(scope: CredentialScope) {
    return coordinator.scope(scope === 'application' ? applicationBinding : clientBinding, scope);
  }
  async function request(
    scope: CredentialScope,
    path: string,
    method = 'GET',
    body?: unknown,
    raw = false,
    requestOptions?: { timeoutMs?: number; readOnly?: true },
  ): Promise<Response> {
    assertProviderReadActive();
    const key = scope === 'application' ? options.applicationKey : options.clientKey;
    if (!key) throw new PterodactylError('credential_missing', scope, 'rejected');
    const requestScope = state(scope);
    const resource = scope === 'client' ? resourceLimit(path, method) : undefined;
    const resourceScope = resource
      ? coordinator.scope(
          createHash('sha256')
            .update(JSON.stringify([base.href, 'resource', resource]))
            .digest('hex'),
          scope,
        )
      : undefined;
    const remaining =
      Math.max(requestScope.cooldownUntil, resourceScope?.cooldownUntil ?? 0) - Date.now();
    if (remaining > 0)
      throw new PterodactylError('rate_limited', scope, 'rejected', 429, remaining);
    const mutating = method !== 'GET' && !requestOptions?.readOnly;
    const budget = scope === 'application' ? coordinator.budget : undefined;
    if (budget) {
      const delayMs = await budget.acquire(
        providerBudgetBinding,
        !mutating && isBackgroundProviderRead(),
      );
      if (delayMs > 0) throw new PterodactylError('rate_limited', scope, 'rejected', 429, delayMs);
    }
    assertProviderReadActive();
    const invalidatedReads = mutating
      ? [
          requestScope.pendingJson,
          ...(options.clientKey
            ? [state(scope === 'application' ? 'client' : 'application').pendingJson]
            : []),
        ]
      : [];
    // A final identity read after a mutation must not join a pre-mutation observation.
    for (const reads of invalidatedReads) reads.clear();
    let response: Response;
    requestScope.activeRequests++;
    try {
      const url = new URL(`api/${scope}/${path}`, base);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${key}`,
        Accept: 'application/vnd.pterodactyl.v1+json',
        ...(body === undefined
          ? {}
          : { 'Content-Type': raw ? 'text/plain; charset=utf-8' : 'application/json' }),
      };
      const init: RequestInit = {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(
          requestOptions?.timeoutMs !== undefined
            ? parseInput(z.number().int().min(1).max(120000), requestOptions.timeoutMs)
            : timeoutMs,
        ),
        headers,
        ...(body === undefined ? {} : { body: raw ? String(body) : JSON.stringify(body) }),
      };
      const agent = coordinator.providerReadAgent(scope, method, path, url);
      if (agent) headers['User-Agent'] = agent;
      response = await fetcher(url, init);
    } catch {
      throw new PterodactylError('unavailable', scope, mutating ? 'unknown' : 'rejected');
    } finally {
      requestScope.activeRequests--;
      for (const reads of invalidatedReads) reads.clear();
    }
    const status = response.status;
    const retryAfterMs =
      status === 429 ? retryDelay(response.headers.get('retry-after'), Date.now()) : undefined;
    if (retryAfterMs !== undefined) {
      const limited = resourceScope ?? requestScope;
      limited.cooldownUntil = Math.max(limited.cooldownUntil, Date.now() + retryAfterMs);
    }
    if (budget) {
      const advertised = Number(response.headers.get('x-ratelimit-limit'));
      const limit =
        Number.isSafeInteger(advertised) && advertised > 0 && advertised <= 1_000_000
          ? advertised
          : 0;
      const prior = requestScope.publishedRateLimit;
      if (retryAfterMs || (limit && (prior?.limit !== limit || Date.now() - prior.at >= 60_000))) {
        if (limit) requestScope.publishedRateLimit = { limit, at: Date.now() };
        await budget.observe(providerBudgetBinding, limit, retryAfterMs ?? 0);
      }
    }
    if (!response.ok) {
      await response.body?.cancel();
      const reason =
        status === 401 || status === 403
          ? 'permission_denied'
          : status === 404
            ? 'not_found'
            : status === 429
              ? 'rate_limited'
              : status >= 400 && status < 500 && status !== 408
                ? 'invalid_request'
                : 'unavailable';
      throw new PterodactylError(
        reason,
        scope,
        mutating && (status >= 500 || status === 408) ? 'unknown' : 'rejected',
        status,
        retryAfterMs,
      );
    }
    return response;
  }
  async function json<T>(
    scope: CredentialScope,
    path: string,
    schema: z.ZodType<T>,
    method = 'GET',
    body?: unknown,
    coalesce = true,
    requestOptions?: { timeoutMs?: number; readOnly?: true },
  ): Promise<T> {
    async function readJson(): Promise<string> {
      // Request errors preserve rate-limit metadata and mutation uncertainty.
      const response = await request(scope, path, method, body, false, requestOptions);
      try {
        return Buffer.from(await readBounded(response, 4 * 1024 * 1024)).toString('utf8');
      } catch {
        throw new PterodactylError(
          'invalid_response',
          scope,
          method === 'GET' || requestOptions?.readOnly ? 'rejected' : 'unknown',
        );
      }
    }
    let text: string;
    if (coalesce && method === 'GET' && body === undefined) {
      const pendingJson = state(scope).pendingJson;
      // A background leader can be deferred while an interactive read still has quota.
      // Background callers may join a foreground read; the reverse must retain its own admission.
      const background =
        scope === 'application' && coordinator.budget && isBackgroundProviderRead();
      const identity = background ? `background:${path}` : path;
      let pending = pendingJson.get(path) ?? (background ? pendingJson.get(identity) : undefined);
      if (!pending) {
        pending = readJson();
        if (pendingJson.size < 1024) pendingJson.set(identity, pending);
        const current = pending;
        const clear = () => {
          if (pendingJson.get(identity) === current) pendingJson.delete(identity);
        };
        void pending.then(clear, clear);
      }
      text = await pending;
    } else text = await readJson();
    try {
      // Each caller owns its parsed object and schema validation, including coalesced reads.
      return schema.parse(JSON.parse(text));
    } catch {
      throw new PterodactylError(
        'invalid_response',
        scope,
        method === 'GET' || requestOptions?.readOnly ? 'rejected' : 'unknown',
      );
    }
  }
  async function empty(
    scope: CredentialScope,
    path: string,
    method: string,
    body?: unknown,
    raw = false,
    requestOptions?: { timeoutMs: number },
  ): Promise<void> {
    const response = await request(scope, path, method, body, raw, requestOptions);
    await response.body?.cancel();
  }
  async function entity<T>(
    scope: CredentialScope,
    path: string,
    schema: z.ZodType<T>,
    method = 'GET',
    body?: unknown,
    coalesce = true,
  ): Promise<T> {
    return (await json(scope, path, z.object({ attributes: schema }), method, body, coalesce))
      .attributes;
  }
  async function list<T>(
    scope: CredentialScope,
    path: string,
    schema: z.ZodType<T>,
    maxPages = 1000,
  ): Promise<T[]> {
    const entries: T[] = [];
    const pageSchema = z.object({
      object: z.literal('list'),
      data: z.array(z.object({ attributes: schema })).max(1000),
      meta: z
        .object({
          pagination: z.object({
            current_page: z.number().int().positive(),
            total_pages: z.number().int().nonnegative().max(maxPages),
          }),
        })
        .optional(),
    });
    for (let page = 1; page <= maxPages; page++) {
      // Never follow provider-supplied links, which could send credentials to another host.
      const result = await json(
        scope,
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
        pageSchema,
      );
      entries.push(...result.data.map((item) => item.attributes));
      const pagination = result.meta?.pagination;
      if (pagination && pagination.current_page !== page)
        throw new PterodactylError('invalid_response', scope, 'rejected');
      if (!pagination || page >= pagination.total_pages) return entries;
    }
    throw new PterodactylError('invalid_response', scope, 'rejected');
  }
  return { request, json, empty, entity, list };
}
export type Transport = ReturnType<typeof createTransport>;
