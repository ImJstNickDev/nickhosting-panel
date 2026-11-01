import { timingSafeEqual, X509Certificate } from 'node:crypto';
import { createServer, request } from 'node:https';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { GatewayTcpContext } from '@nickhosting/game-sdk';

/** HTTPS sessions stay terminated here across backend power transitions. No
 * client credential or multiplayer ticket is generated or replaced. */
export async function acceptSatisfactoryHttps(socket: Socket, context: GatewayTcpContext) {
  const identity = await context.tlsIdentity();
  if (context.signal.aborted || socket.destroyed) return;
  const expected = new X509Certificate(identity.certificatePem).raw;
  const server = createServer(
    {
      key: identity.privateKeyPem,
      cert: identity.certificatePem,
      minVersion: 'TLSv1.2',
      handshakeTimeout: 10_000,
      maxHeaderSize: 16_384,
      requestTimeout: 30_000,
      headersTimeout: 10_000,
    },
    (incoming, outgoing) => {
      if (context.signal.aborted) {
        incoming.destroy();
        return;
      }
      if (!context.canForward()) {
        const parts: Buffer[] = [];
        let length = 0;
        incoming.on('data', (part: Buffer) => {
          length += part.length;
          if (length > 16_384) incoming.destroy();
          else parts.push(part);
        });
        incoming.on('end', () => {
          let health = false;
          try {
            health =
              incoming.method === 'POST' &&
              /^\/api\/v1\/?$/.test(incoming.url ?? '') &&
              JSON.parse(Buffer.concat(parts).toString('utf8')).function === 'HealthCheck';
          } catch {
            /* Invalid requests cannot obtain cached or privileged state. */
          }
          outgoing.writeHead(health ? 200 : 503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          outgoing.end(
            JSON.stringify(
              health
                ? { data: { health: 'slow', serverCustomData: '' } }
                : { errorCode: 'server_unavailable', errorMessage: 'Server unavailable' },
            ),
          );
        });
        return;
      }
      // Only the route-authorized fixed backend is contacted. Pin the exact
      // per-server certificate before sending any authentication/body bytes.
      const upstream = request(
        {
          hostname: context.route.backend.address,
          port: context.route.backend.port,
          method: incoming.method,
          path: incoming.url,
          agent: false,
          rejectUnauthorized: false,
          minVersion: 'TLSv1.2',
          headers: {
            ...incoming.headers,
            host: `${context.route.backend.address}:${context.route.backend.port}`,
          },
          signal: context.signal,
          timeout: 30_000,
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on('socket', (raw) => {
        const tls = raw as TLSSocket;
        tls.once('secureConnect', () => {
          const actual = tls.getPeerCertificate().raw;
          if (
            !actual ||
            actual.length !== expected.length ||
            !timingSafeEqual(actual, expected) ||
            !context.canForward()
          ) {
            upstream.destroy();
            return;
          }
          incoming.pipe(upstream);
        });
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      outgoing.once('close', () => upstream.destroy());
    },
  );
  server.on('tlsClientError', () => socket.destroy());
  server.on('clientError', () => socket.destroy());
  socket.once('close', () => server.close());
  server.emit('connection', socket);
}
