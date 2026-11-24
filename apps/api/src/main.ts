import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { DomainError } from '@nickhosting/core';
import { createApiHttpServer } from './http-server.js';
import { createRuntime } from './runtime.js';

async function listen(server: Server, host: string, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

async function closeListeners(servers: Server[]) {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
}

export async function main(env: Readonly<Record<string, string | undefined>> = process.env) {
  if (!env.NH_API_BIND_HOST) throw new DomainError('configuration_invalid');
  const port = Number(env.NH_API_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new DomainError('configuration_invalid');
  const deployed =
    env.NH_DEPLOYMENT_ENV === 'development' || env.NH_DEPLOYMENT_ENV === 'production';
  const dashboardPort =
    env.NH_DASHBOARD_INGRESS_PORT === undefined
      ? deployed
        ? 3002
        : undefined
      : Number(env.NH_DASHBOARD_INGRESS_PORT);
  if (
    dashboardPort !== undefined &&
    (!Number.isInteger(dashboardPort) ||
      dashboardPort < 1 ||
      dashboardPort > 65535 ||
      dashboardPort === port)
  )
    throw new DomainError('configuration_invalid');
  const runtime = await createRuntime(env);
  const host = env.NH_API_BIND_HOST;
  const listeners: Server[] = [];
  const server = createApiHttpServer(getRequestListener(runtime.app.fetch, { hostname: host }));
  try {
    listeners.push(await listen(server, host, port));
    if (dashboardPort !== undefined) {
      const ingress = createApiHttpServer(
        getRequestListener(runtime.createDashboardIngress().fetch),
      );
      listeners.push(await listen(ingress, host, dashboardPort));
    }
  } catch (error) {
    await closeListeners(listeners);
    await runtime.close();
    throw error;
  }
  for (const listener of listeners)
    listener.on('error', () => runtime.logger.log('error', 'api.listener_failed'));
  let closing = false;
  const onSignal = () => {
    void stop();
  };
  const stop = async () => {
    if (closing) return;
    closing = true;
    await closeListeners(listeners);
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
