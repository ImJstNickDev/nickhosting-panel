import { DomainError } from '@nickhosting/core';

export function endpoint(value: string): URL {
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
    throw new DomainError('configuration_invalid');
  }
}

export class ProviderHttp {
  readonly #base: URL;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetcher: typeof fetch;
  readonly #timeoutMs: number;

  constructor(input: {
    baseURL: string;
    headers: Readonly<Record<string, string>>;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.#base = endpoint(input.baseURL);
    this.#headers = input.headers;
    this.#fetcher = input.fetcher ?? fetch;
    this.#timeoutMs = input.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000)
      throw new DomainError('configuration_invalid');
  }

  async request(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<{ status: number; data: unknown }> {
    try {
      const response = await this.#fetcher(new URL(path, this.#base), {
        method,
        headers: {
          ...this.#headers,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404 || response.status === 409)
          return { status: response.status, data: null };
        throw new DomainError(
          response.status === 401 || response.status === 403
            ? 'forbidden'
            : 'integration_unavailable',
        );
      }
      const chunks: Uint8Array[] = [];
      const reader = response.body?.getReader();
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 1_048_576) throw new DomainError('integration_unavailable');
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
        }
      }
      return {
        status: response.status,
        data: size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      // Upstream errors and network exception messages may contain credentials or paths.
      throw new DomainError('integration_unavailable');
    }
  }
}
