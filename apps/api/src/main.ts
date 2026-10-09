import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { DomainError } from '@nickhosting/core';
import { createApiHttpServer } from './http-server.js';
import { createRuntime } from './runtime.js';

export async function main(env: Readonly<Record<string, string | undefined>> = process.env) {
  if (!env.NH_API_BIND_HOST) throw new DomainError('configuration_invalid');
  const port = Number(env.NH_API_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new DomainError('configuration_invalid');
  const runtime = await createRuntime(env);
  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const listener = createApiHttpServer(
        getRequestListener(runtime.app.fetch, { hostname: env.NH_API_BIND_HOST }),
      );
      listener.once('error', reject);
      listener.listen(port, env.NH_API_BIND_HOST, () => {
        listener.off('error', reject);
        resolve(listener);
      });
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  server.on('error', () => runtime.logger.log('error', 'api.listener_failed'));
  let closing = false;
  const onSignal = () => {
    void stop();
  };
  const stop = async () => {
    if (closing) return;
    closing = true;
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.close();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  runtime.logger.log('info', 'api.started');
  return { server, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('API startup failed; check configuration and migrations.\n');
    process.exitCode = 1;
  });
}
