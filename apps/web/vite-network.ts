import { isIP } from 'node:net';
import type { ServerOptions } from 'vite';

export const developmentWebSocketPath = '/__nickhosting_hmr';

/** Development-only transport settings; no private API configuration enters the browser. */
export function developmentNetwork(
  env: Readonly<Record<string, string | undefined>>,
): ServerOptions {
  const host = env.NH_WEB_BIND_HOST ?? '127.0.0.1';
  const rawPort = env.NH_WEB_PORT ?? '5173';
  if (!isIP(host)) throw new Error('NH_WEB_BIND_HOST must be an explicit IP address.');
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535)
    throw new Error('NH_WEB_PORT must be a valid port.');
  const external = env.NH_WEB_EXTERNAL_HTTPS ?? '0';
  if (external !== '0' && external !== '1')
    throw new Error('NH_WEB_EXTERNAL_HTTPS must be 0 or 1.');
  const server: ServerOptions = { host, port: Number(rawPort), strictPort: true };
  if (external === '0') return server;

  let origin: URL;
  try {
    origin = new URL(env.NH_PUBLIC_URL ?? '');
  } catch {
    throw new Error('External development requires NH_PUBLIC_URL as an HTTPS origin.');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.port !== '' ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(origin.hostname) ||
    origin.hostname.endsWith('.localhost')
  )
    throw new Error('NH_PUBLIC_URL must be one HTTPS hostname on port 443, without a path.');
  if (env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS)
    throw new Error('External development permits only the NH_PUBLIC_URL hostname.');

  return {
    ...server,
    allowedHosts: [origin.hostname],
    origin: origin.origin,
    cors: { origin: origin.origin },
    ws: {
      protocol: 'wss',
      host: origin.hostname,
      // Vite 8 only falls back to its direct/internal address when clientPort is absent.
      // Do not set ws.port: the WebSocket shares the existing Vite HTTP listener.
      clientPort: 443,
      path: developmentWebSocketPath,
    },
  };
}
