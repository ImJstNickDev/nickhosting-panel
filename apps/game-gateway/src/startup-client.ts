import { isIP } from 'node:net';
import { DomainError } from '@nickhosting/core';
import { gatewaySnapshotSchema } from '@nickhosting/game-sdk';
import { z } from 'zod';

const hintSchema = z
  .object({
    routeId: z.uuid(),
    routeRevision: z.number().int().positive(),
    generation: z.uuid(),
    wakeJobId: z.uuid(),
  })
  .strict();
export type GatewayStartupHint = z.infer<typeof hintSchema>;
const eventSchema = hintSchema
  .extend({
    readinessSnapshot: gatewaySnapshotSchema.optional(),
    observedAt: z.iso.datetime().optional(),
  })
  .refine((value) => (value.readinessSnapshot === undefined) === (value.observedAt === undefined));
export type GatewayStartupEvent = z.infer<typeof eventSchema>;

/** Authenticated, bounded subscription. Only a fenced durable receipt may advance readiness. */
export async function watchGatewayStartup(
  options: {
    baseUrl: string;
    gatewayId: string;
    token: string;
    requestTimeoutMs?: number;
    fetcher?: typeof fetch;
  },
  request: GatewayStartupHint,
  onHint: (hint: GatewayStartupEvent) => void | Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new DomainError('configuration_invalid');
  }
  const host = base.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  const duration = options.requestTimeoutMs ?? 65000;
  if (
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !z.uuid().safeParse(options.gatewayId).success ||
    !/^[A-Za-z0-9_-]{43,512}$/.test(options.token) ||
    !Number.isSafeInteger(duration) ||
    duration < 1 ||
    duration > 65000
  )
    throw new DomainError('configuration_invalid');
  if (!hintSchema.safeParse(request).success) throw new DomainError('validation_failed');
  if (signal.aborted) return;
  base.pathname = `${base.pathname.replace(/\/$/, '')}/internal/gateway/${options.gatewayId}/startup-events`;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => {
    controller.abort();
    void reader?.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, duration);
  timer.unref();
  try {
    const response = await (options.fetcher ?? fetch)(base, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-NickHosting-Gateway-Features':
          'startup-keepalive-v1,provider-readiness-v1,presentation-variables-v1',
      },
      body: JSON.stringify(request),
      redirect: 'error',
      signal: controller.signal,
    });
    if (
      !response.ok ||
      !response.headers.get('content-type')?.startsWith('text/event-stream') ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new DomainError('integration_unavailable');
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '',
      bytes = 0,
      keepaliveBytes = 0;
    while (!controller.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) throw new DomainError('integration_unavailable');
      text += decoder.decode(chunk.value, { stream: true });
      text = text.replace(/\r\n/g, '\n');
      for (;;) {
        const end = text.indexOf('\n\n');
        if (end < 0) break;
        const frame = text.slice(0, end);
        text = text.slice(end + 2);
        // Canonical keepalive frames maintain HTTP liveness only. They never
        // reset the absolute duration/byte budget or invoke readiness handling.
        if (frame === 'event: keepalive\ndata: {}') {
          keepaliveBytes += frame.length + 2;
          if (keepaliveBytes > 8192) throw new DomainError('integration_unavailable');
          continue;
        }
        const lines = frame.split('\n');
        if (lines.length !== 2 || lines[0] !== 'event: startup' || !lines[1]?.startsWith('data: '))
          throw new DomainError('integration_unavailable');
        const hint = eventSchema.safeParse(JSON.parse(lines[1].slice(6)));
        if (
          !hint.success ||
          hint.data.routeId !== request.routeId ||
          hint.data.routeRevision !== request.routeRevision ||
          hint.data.generation !== request.generation ||
          hint.data.wakeJobId !== request.wakeJobId
        )
          throw new DomainError('integration_unavailable');
        if (!controller.signal.aborted) await onHint(hint.data);
        return;
      }
    }
  } catch {
    if (!signal.aborted && !controller.signal.aborted)
      throw new DomainError('integration_unavailable');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    abort();
  }
}
