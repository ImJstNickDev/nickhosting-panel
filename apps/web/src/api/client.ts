import { authErrorKeys } from '@nickhosting/i18n/auth-errors';
import { QueryClient } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly messageKey: string,
    readonly requestId?: string,
    readonly status = 0,
  ) {
    super(messageKey);
  }
}
export function apiError(value: unknown, status = 0): ApiError {
  if (value instanceof ApiError) return value;
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const nested =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : record;
  if (nested.error) return apiError(nested, status);
  return new ApiError(
    typeof nested.code === 'string' ? nested.code : 'internal_error',
    typeof nested.messageKey === 'string'
      ? nested.messageKey
      : typeof nested.code === 'string'
        ? (authErrorKeys[nested.code] ?? 'web.errors.request')
        : 'web.errors.request',
    typeof record.requestId === 'string' ? record.requestId : undefined,
    status,
  );
}
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5000, retry: false, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});
let locale = 'en';
export function setRequestLocale(value: string) {
  locale = value;
}
export function safeApiPath(path: string) {
  if (!path.startsWith('/v1/') && !path.startsWith('/api/auth/'))
    throw new Error('invalid_api_path');
  if (path.includes('\\') || /[\r\n]/.test(path)) throw new Error('invalid_api_path');
  return path;
}
export async function api<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const response = await fetch(safeApiPath(path), {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    signal: options.signal,
    headers: {
      'Accept-Language': locale,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'error',
  });
  if (!response.ok) throw apiError(await response.json().catch(() => ({})), response.status);
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  if (method !== 'GET' && path.startsWith('/v1/owner/')) {
    // Catalog visibility depends on Owner mappings, rollout and availability. Never retain
    // inactive projections after a write; active views refetch under current identity.
    await queryClient.cancelQueries({ queryKey: ['creation'] });
    queryClient.removeQueries({ queryKey: ['creation'], type: 'inactive' });
    await queryClient.invalidateQueries({ queryKey: ['creation'] });
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
export function idempotencyKey() {
  return crypto.randomUUID();
}
export function upload(
  path: string,
  file: Blob,
  options: {
    signal?: AbortSignal;
    onProgress?: (sent: number, total: number) => void;
  } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', safeApiPath(path));
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-NH-Upload-Length', String(file.size));
    xhr.setRequestHeader('Accept-Language', locale);
    const abort = () => xhr.abort();
    const finish = () => options.signal?.removeEventListener('abort', abort);
    xhr.upload.onprogress = (event) => options.onProgress?.(event.loaded, file.size);
    xhr.onload = () => {
      finish();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let payload: unknown;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          payload = {};
        }
        reject(apiError(payload, xhr.status));
      }
    };
    xhr.onerror = () => {
      finish();
      reject(apiError(null));
    };
    xhr.onabort = () => {
      finish();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (options.signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    xhr.send(file);
  });
}

/** Native download stays streamed by the browser. The HttpOnly support cookie
 * carries the same authority as API calls; no signed upstream URL is exposed. */
export function download(path: string) {
  const link = document.createElement('a');
  link.href = safeApiPath(path);
  link.rel = 'noreferrer';
  link.download = '';
  link.click();
}

/** Only the text editor is bounded. Larger/binary files use native downloads. */
export async function readText(path: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(safeApiPath(path), {
    credentials: 'same-origin',
    signal,
    redirect: 'error',
  });
  if (!response.ok) throw apiError(await response.json().catch(() => ({})), response.status);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let result = '',
    bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 240000) throw new ApiError('text_too_large', 'service.textTooLarge');
      result += decoder.decode(chunk.value, { stream: true });
      if (result.length > 60000 || result.includes('\0'))
        throw new ApiError('text_too_large', 'service.textTooLarge');
    }
    return result + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function consumeEvents(
  path: string,
  options: {
    signal: AbortSignal;
    onEvent: (event: { type: string; data: string; id?: string }) => void;
  },
) {
  const response = await fetch(safeApiPath(path), {
    credentials: 'same-origin',
    headers: { Accept: 'text/event-stream', 'Accept-Language': locale },
    signal: options.signal,
    redirect: 'error',
  });
  if (!response.ok) throw apiError(await response.json().catch(() => ({})), response.status);
  if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body)
    throw apiError(null);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (!options.signal.aborted) {
      const result = await reader.read();
      if (result.done) break;
      pending = (pending + decoder.decode(result.value, { stream: true })).replace(/\r\n/g, '\n');
      if (pending.length > 262144) throw apiError(null);
      let boundary = pending.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        let type = 'message';
        let id: string | undefined;
        const data: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          if (line.startsWith('id:')) id = line.slice(3).trim();
        }
        if (data.length) options.onEvent({ type, data: data.join('\n'), id });
        boundary = pending.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
