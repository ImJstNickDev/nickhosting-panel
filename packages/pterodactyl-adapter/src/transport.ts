import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import type { ContainerObserver } from './container-observer.js';

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
  ) {
    super('integration_unavailable', 503, {
      provider: 'pterodactyl',
      reason,
      scope,
      outcome,
      upstreamStatus,
    });
    this.name = 'PterodactylError';
  }
}
export interface TransportOptions {
  containerObserver?: ContainerObserver;
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
export async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new Error('response_too_large');
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
      if (size > maxBytes) throw new Error('response_too_large');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}
export function createTransport(options: TransportOptions) {
  const base = validatedBaseURL(options.baseURL);
  const timeoutMs = parseInput(z.number().int().min(1).max(120000), options.timeoutMs ?? 10000);
  for (const key of [options.applicationKey, options.clientKey]) {
    if (key !== undefined && (!key.trim() || key.length > 4096 || /[\r\n]/.test(key)))
      throw new DomainError('validation_failed');
  }
  const fetcher = options.fetcher ?? fetch;
  async function request(
    scope: CredentialScope,
    path: string,
    method = 'GET',
    body?: unknown,
    raw = false,
  ): Promise<Response> {
    const key = scope === 'application' ? options.applicationKey : options.clientKey;
    if (!key) throw new PterodactylError('credential_missing', scope, 'rejected');
    const mutating = method !== 'GET';
    let response: Response;
    try {
      response = await fetcher(new URL(`api/${scope}/${path}`, base), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/vnd.pterodactyl.v1+json',
          ...(body === undefined
            ? {}
            : { 'Content-Type': raw ? 'text/plain; charset=utf-8' : 'application/json' }),
        },
        ...(body === undefined ? {} : { body: raw ? String(body) : JSON.stringify(body) }),
      });
    } catch {
      throw new PterodactylError('unavailable', scope, mutating ? 'unknown' : 'rejected');
    }
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status;
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
  ): Promise<T> {
    const response = await request(scope, path, method, body);
    try {
      return schema.parse(
        JSON.parse(Buffer.from(await readBounded(response, 4 * 1024 * 1024)).toString('utf8')),
      );
    } catch {
      throw new PterodactylError(
        'invalid_response',
        scope,
        method === 'GET' ? 'rejected' : 'unknown',
      );
    }
  }
  async function empty(
    scope: CredentialScope,
    path: string,
    method: string,
    body?: unknown,
    raw = false,
  ): Promise<void> {
    const response = await request(scope, path, method, body, raw);
    await response.body?.cancel();
  }
  async function entity<T>(
    scope: CredentialScope,
    path: string,
    schema: z.ZodType<T>,
    method = 'GET',
    body?: unknown,
  ): Promise<T> {
    return (await json(scope, path, z.object({ attributes: schema }), method, body)).attributes;
  }
  async function list<T>(scope: CredentialScope, path: string, schema: z.ZodType<T>): Promise<T[]> {
    const entries: T[] = [];
    const pageSchema = z.object({
      object: z.literal('list'),
      data: z.array(z.object({ attributes: schema })).max(1000),
      meta: z
        .object({
          pagination: z.object({
            current_page: z.number().int().positive(),
            total_pages: z.number().int().nonnegative().max(1000),
          }),
        })
        .optional(),
    });
    for (let page = 1; page <= 1000; page++) {
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
