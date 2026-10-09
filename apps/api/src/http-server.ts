import { createServer, type RequestListener } from 'node:http';

export interface HttpServerPolicy {
  ordinaryBodyDeadlineMs: number;
  headersDeadlineMs: number;
  idleTimeoutMs: number;
  connectionsCheckingIntervalMs: number;
}

export const httpServerPolicy: Readonly<HttpServerPolicy> = Object.freeze({
  ordinaryBodyDeadlineMs: 300_000,
  headersDeadlineMs: 60_000,
  idleTimeoutMs: 30_000,
  connectionsCheckingIntervalMs: 1000,
});

// Only the canonical binary upload endpoint has an open-ended progressing body.
// Authentication, UUID validity, authorization and transfer limits remain in its
// normal Hono route. Queries do not change the route; encoded/slash variants and
// every other method keep the ordinary request deadline.
const uploadPath =
  /^\/v1\/(?:servers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/files|minecraft\/sources\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/upload(?:\?[^#]*)?$/i;

/** Node's default requestTimeout is a total body deadline, even while an upload
 * makes progress. Replace it with a route-aware deadline while retaining native
 * header limits and socket inactivity protection. Do not consume or buffer body
 * bytes here: the adapter owns backpressure, authorization and transfer aborts. */
export function createApiHttpServer(
  listener: RequestListener,
  overrides: Partial<HttpServerPolicy> = {},
) {
  const policy = { ...httpServerPolicy, ...overrides };
  for (const value of Object.values(policy))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError('HTTP timeout policies must be positive safe integers');
  const server = createServer(
    {
      requestTimeout: 0,
      headersTimeout: policy.headersDeadlineMs,
      connectionsCheckingInterval: policy.connectionsCheckingIntervalMs,
    },
    (request, response) => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const clearDeadline = () => {
        if (deadline) clearTimeout(deadline);
        deadline = undefined;
      };
      const onFinish = () => {
        clearDeadline();
        // A rejected upload must not keep its deadline exemption by trickling
        // an unread body after the server has already returned an error.
        if (!request.complete) request.destroy();
      };
      const onClose = () => {
        clearDeadline();
        request.off('end', clearDeadline);
        request.off('close', onClose);
        response.off('finish', onFinish);
        response.off('close', onClose);
      };
      request.once('end', clearDeadline);
      request.once('close', onClose);
      response.once('finish', onFinish);
      response.once('close', onClose);
      if (request.method !== 'PUT' || !uploadPath.test(request.url ?? '')) {
        deadline = setTimeout(() => {
          if (request.complete || request.destroyed) return clearDeadline();
          if (!response.headersSent) {
            response.writeHead(408, { Connection: 'close', 'Content-Length': '0' });
            response.end();
          } else request.destroy();
        }, policy.ordinaryBodyDeadlineMs);
        deadline.unref();
      }
      listener(request, response);
    },
  );
  server.setTimeout(policy.idleTimeoutMs, (socket) => socket.destroy());
  return server;
}
