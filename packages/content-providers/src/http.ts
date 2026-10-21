import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DomainError } from '@nickhosting/core';
import {
  artifactSchema,
  type ContentArtifact,
  type ContentHttp,
  fail,
  unavailable,
} from './contracts.js';
import type { ModpackDownload } from './modpack-recipes.js';

const blocked = new BlockList();
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blockedV6.addSubnet(address, prefix, 'ipv6');
export function isPublicDownloadAddress(address: string): boolean {
  const family = isIP(address);
  if (!family || address.includes('%')) return false;
  return !(family === 4 ? blocked : blockedV6).check(address, family === 4 ? 'ipv4' : 'ipv6');
}
export function validateDownloadUrl(input: string, allowedOrigins: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    fail('download_url');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !allowedOrigins.includes(url.origin) ||
    isIP(url.hostname.replace(/^\[|\]$/g, ''))
  )
    fail('download_origin');
  return url;
}
class RetryableResponse extends Error {}
const downloadRedirectStatuses = new Set([301, 302, 303, 307, 308]);
const maxDownloadRedirects = 3;
export interface SafeContentHttpOptions {
  allowedOrigins: readonly string[];
  userAgent: string;
  maxJsonBytes?: number;
  maxDownloadBytes?: number;
  timeoutMs?: number;
  attempts?: number;
}
/** DNS is validated and pinned into every TLS connection. Metadata never follows
 * redirects; archive downloads may follow at most three independently approved hops. */
export class SafeContentHttp implements ContentHttp {
  private readonly options: Required<SafeContentHttpOptions>;
  constructor(options: SafeContentHttpOptions) {
    this.options = {
      maxJsonBytes: 8 * 1024 ** 2,
      maxDownloadBytes: 8 * 1024 ** 3,
      timeoutMs: 120000,
      attempts: 3,
      ...options,
    };
    if (
      !options.userAgent ||
      !options.allowedOrigins.length ||
      !Number.isInteger(this.options.attempts) ||
      this.options.attempts < 1 ||
      this.options.attempts > 5 ||
      [this.options.maxJsonBytes, this.options.maxDownloadBytes, this.options.timeoutMs].some(
        (v) => !Number.isSafeInteger(v) || v < 1,
      )
    )
      fail('http_configuration');
    for (const origin of options.allowedOrigins)
      if (validateDownloadUrl(origin, options.allowedOrigins).origin !== origin)
        fail('http_origin');
  }
  private async response(
    input: string,
    headers: Readonly<Record<string, string>> = {},
    signal?: AbortSignal,
    downloadRedirects = false,
    jsonBody?: string,
  ): Promise<IncomingMessage> {
    const url = validateDownloadUrl(input, this.options.allowedOrigins);
    if (
      Object.keys(headers).some((k) => !['x-api-key', 'accept'].includes(k.toLowerCase())) ||
      Object.values(headers).some((v) => /[\r\n]/.test(v))
    )
      fail('http_headers');
    signal?.throwIfAborted();
    const addresses = await new Promise<{ address: string; family: number }[]>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('content_timeout')),
          this.options.timeoutMs,
        );
        timer.unref();
        lookup(url.hostname, { all: true, verbatim: true })
          .then(resolve, reject)
          .finally(() => clearTimeout(timer));
      },
    );
    if (!addresses.length || addresses.some((a) => !isPublicDownloadAddress(a.address)))
      fail('download_address');
    const address = addresses[0];
    if (!address) fail('download_address');
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: jsonBody === undefined ? 'GET' : 'POST',
          agent: false,
          family: address.family,
          signal,
          headers: {
            ...headers,
            'User-Agent': this.options.userAgent,
            'Accept-Encoding': 'identity',
            ...(jsonBody === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(jsonBody),
                }),
          },
          lookup: (_host, _options, callback) => callback(null, address.address, address.family),
        },
        (res) => {
          if (downloadRedirects && downloadRedirectStatuses.has(res.statusCode ?? 0)) {
            resolve(res);
            return;
          }
          if (res.statusCode !== 200) {
            res.destroy();
            if (res.statusCode === 429 || (res.statusCode ?? 0) >= 500)
              reject(new RetryableResponse());
            else
              reject(
                new DomainError('integration_unavailable', 503, {
                  reason: 'content_http_refused',
                  providerStatus: res.statusCode,
                }),
              );
            return;
          }
          if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
            res.destroy();
            reject(
              new DomainError('integration_unavailable', 503, {
                reason: 'content_encoding_refused',
              }),
            );
            return;
          }
          resolve(res);
        },
      );
      req.setTimeout(this.options.timeoutMs, () => req.destroy(new Error('content_timeout')));
      // Absolute deadline also covers peers that keep sending one byte per timeout interval.
      const deadline = setTimeout(
        () => req.destroy(new Error('content_timeout')),
        this.options.timeoutMs,
      );
      deadline.unref();
      req.on('close', () => clearTimeout(deadline));
      req.on('error', reject);
      req.end(jsonBody);
    });
  }
  private async downloadResponse(input: string, signal?: AbortSignal): Promise<IncomingMessage> {
    let url = validateDownloadUrl(input, this.options.allowedOrigins);
    const visited = new Set<string>();
    for (let redirects = 0; ; redirects++) {
      signal?.throwIfAborted();
      if (visited.has(url.href)) unavailable('download_redirect_loop');
      visited.add(url.href);
      // Downloads never carry provider API keys, including same-origin hops.
      const response = await this.response(url.href, {}, signal, true);
      if (response.statusCode === 200) return response;
      response.destroy();
      const location = response.headers.location;
      if (redirects >= maxDownloadRedirects || !location || location.length > 8192)
        unavailable('download_redirect_refused');
      let target: URL;
      try {
        target = new URL(location, url);
      } catch {
        return unavailable('download_redirect_refused');
      }
      // Reuse the existing HTTPS/origin/credential restrictions and re-resolve
      // all addresses through response() before opening the next pinned socket.
      url = validateDownloadUrl(target.href, this.options.allowedOrigins);
    }
  }
  private async retry<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; attempt < this.options.attempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        signal?.throwIfAborted();
        const code = (error as NodeJS.ErrnoException).code;
        if (
          !(error instanceof RetryableResponse) &&
          !['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code ?? '') &&
          !(error instanceof Error && error.message === 'content_timeout')
        )
          throw error;
        if (attempt + 1 === this.options.attempts) unavailable('provider_unavailable');
        await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
    return unavailable('provider_unavailable');
  }
  async json(
    url: string,
    options: { headers?: Readonly<Record<string, string>>; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    return JSON.parse(await this.text(url, options)) as unknown;
  }
  async text(
    url: string,
    options: { headers?: Readonly<Record<string, string>>; signal?: AbortSignal } = {},
  ): Promise<string> {
    return this.metadata(url, options);
  }
  async jsonPost(
    url: string,
    body: unknown,
    options: { headers?: Readonly<Record<string, string>>; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const encoded = JSON.stringify(body);
    if (!encoded || Buffer.byteLength(encoded) > 256 * 1024) fail('metadata_request_size');
    return JSON.parse(await this.metadata(url, options, encoded)) as unknown;
  }
  private async metadata(
    url: string,
    options: { headers?: Readonly<Record<string, string>>; signal?: AbortSignal },
    jsonBody?: string,
  ): Promise<string> {
    return this.retry(async () => {
      const response = await this.response(url, options.headers, options.signal, false, jsonBody);
      let size = 0;
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of response) {
          size += chunk.length;
          if (size > this.options.maxJsonBytes) fail('metadata_size');
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString('utf8');
      } finally {
        response.destroy();
      }
    }, options.signal);
  }
  async download(
    input: ContentArtifact,
    destination: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ sha256: string; size: number }> {
    const artifact = artifactSchema.parse(input);
    return this.streamDownload(artifact, destination, options, artifact.integrity !== 'spiget-tls');
  }
  /** Recipe downloads have their own bounded policy; the existing artifact contract stays strict. */
  async downloadModpack(
    artifact: ModpackDownload,
    destination: string,
    options: {
      signal?: AbortSignal;
      maxBytes?: number;
      onSize?: (bytes: number) => Promise<void>;
    } = {},
  ): Promise<{ sha256: string; size: number }> {
    const lengths: Record<string, number> = { md5: 32, sha1: 40, sha256: 64, sha512: 128 };
    if (
      !Array.isArray(artifact.urls) ||
      !artifact.urls.length ||
      artifact.urls.length > 8 ||
      (artifact.size !== undefined &&
        (!Number.isSafeInteger(artifact.size) || artifact.size < 0)) ||
      !artifact.hashes ||
      Object.entries(artifact.hashes).some(
        ([name, value]) =>
          !lengths[name] ||
          typeof value !== 'string' ||
          value.length !== lengths[name] ||
          !/^[a-f0-9]+$/.test(value),
      )
    )
      fail('modpack_download');
    return this.streamDownload(
      { ...artifact, size: artifact.size ?? this.options.maxDownloadBytes },
      destination,
      options,
      artifact.size !== undefined,
    );
  }
  private async streamDownload(
    artifact: { size: number; hashes: Record<string, string | undefined>; urls: string[] },
    destination: string,
    options: {
      signal?: AbortSignal;
      maxBytes?: number;
      onSize?: (bytes: number) => Promise<void>;
    },
    exactSize: boolean,
  ): Promise<{ sha256: string; size: number }> {
    if (artifact.size > this.options.maxDownloadBytes) fail('download_size');
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    )
      fail('download_size');
    const maximum = Math.min(artifact.size, options.maxBytes ?? this.options.maxDownloadBytes);
    if (!Number.isSafeInteger(maximum) || maximum < 0 || (exactSize && artifact.size > maximum))
      fail('download_size');
    // All alternatives must be approved before any request, including unused fallback URLs.
    for (const url of artifact.urls) validateDownloadUrl(url, this.options.allowedOrigins);
    return this.retry(async () => {
      const response = await this.downloadResponse(artifact.urls[0] as string, options.signal);
      let size = 0;
      let expectedSize: number | undefined;
      let writing = false;
      let responseError = response.errored;
      response.on('error', (error) => {
        responseError = error;
      });
      const hashes = new Map(
        Object.keys({ ...artifact.hashes, sha256: '' }).map((name) => [name, createHash(name)]),
      );
      const guard = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > (expectedSize ?? maximum)) {
            callback(new DomainError('validation_failed', 400, { reason: 'download_size' }));
            return;
          }
          for (const hash of hashes.values()) hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        const length = response.headers['content-length'];
        if (length !== undefined) {
          if (typeof length !== 'string' || !/^(0|[1-9]\d*)$/.test(length)) fail('download_size');
          expectedSize = Number(length);
          if (
            !Number.isSafeInteger(expectedSize) ||
            expectedSize > maximum ||
            (exactSize && expectedSize !== artifact.size)
          )
            fail('download_size');
        }
        // Join admission even if the peer fails meanwhile: reservation must not
        // finish after the caller has already cleaned up the staging attempt.
        if (options.onSize) await options.onSize(expectedSize ?? maximum);
        if (responseError) throw responseError;
        options.signal?.throwIfAborted();
        if (response.destroyed) unavailable('download_interrupted');
        writing = true;
        await pipeline(
          response,
          guard,
          createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
          { signal: options.signal },
        );
        if (exactSize && size !== artifact.size) fail('download_size');
        if (expectedSize !== undefined && size !== expectedSize) fail('download_size');
        const actual = Object.fromEntries(
          [...hashes].map(([name, hash]) => [name, hash.digest('hex')]),
        );
        if (Object.entries(artifact.hashes).some(([name, value]) => actual[name] !== value))
          fail('download_hash');
        return { sha256: actual.sha256 as string, size };
      } catch (error) {
        if (writing && (error as NodeJS.ErrnoException).code !== 'EEXIST')
          await rm(destination, { force: true });
        throw error;
      } finally {
        response.destroy();
      }
    }, options.signal);
  }
}
