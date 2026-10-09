import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  artifactSchema,
  type ContentArtifact,
  type ContentHttp,
  fail,
  unavailable,
} from './contracts.js';

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
export interface SafeContentHttpOptions {
  allowedOrigins: readonly string[];
  userAgent: string;
  maxJsonBytes?: number;
  maxDownloadBytes?: number;
  timeoutMs?: number;
  attempts?: number;
}
/** DNS is validated and pinned into the actual TLS connection. Every redirect is refused. */
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
          method: 'GET',
          agent: false,
          family: address.family,
          signal,
          headers: {
            ...headers,
            'User-Agent': this.options.userAgent,
            'Accept-Encoding': 'identity',
          },
          lookup: (_host, _options, callback) => callback(null, address.address, address.family),
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            if (res.statusCode === 429 || (res.statusCode ?? 0) >= 500)
              reject(new RetryableResponse());
            else reject(new Error('content_http_refused'));
            return;
          }
          if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
            res.destroy();
            reject(new Error('content_encoding_refused'));
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
      req.end();
    });
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
    return this.retry(async () => {
      const response = await this.response(url, options.headers, options.signal);
      let size = 0;
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of response) {
          size += chunk.length;
          if (size > this.options.maxJsonBytes) fail('metadata_size');
          chunks.push(Buffer.from(chunk));
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
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
    if (artifact.size > this.options.maxDownloadBytes) fail('download_size');
    // All alternatives must be approved before any request, including unused fallback URLs.
    for (const url of artifact.urls) validateDownloadUrl(url, this.options.allowedOrigins);
    return this.retry(async () => {
      const response = await this.response(artifact.urls[0] as string, {}, options.signal);
      let size = 0;
      const hashes = new Map(
        Object.keys({ ...artifact.hashes, sha256: '' }).map((name) => [name, createHash(name)]),
      );
      const guard = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > artifact.size) {
            callback(new Error('content_size_mismatch'));
            return;
          }
          for (const hash of hashes.values()) hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          response,
          guard,
          createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
          { signal: options.signal },
        );
        if (size !== artifact.size) fail('download_size');
        const actual = Object.fromEntries(
          [...hashes].map(([name, hash]) => [name, hash.digest('hex')]),
        );
        if (Object.entries(artifact.hashes).some(([name, value]) => actual[name] !== value))
          fail('download_hash');
        return { sha256: actual.sha256 as string, size };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          await rm(destination, { force: true });
        throw error;
      } finally {
        response.destroy();
      }
    }, options.signal);
  }
}
