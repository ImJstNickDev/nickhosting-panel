import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLogger, DomainError, resolveConfig } from '@nickhosting/core';
import type { GatewayProtocolAdapter } from '@nickhosting/game-sdk';
import {
  createGatewaySafetyValidator,
  gatewayNetworkPolicySchema,
  gatewayReachabilityProofSchema,
  gatewaySafetyContextSchema,
  safetyProviderAllocationSchema,
  safetyProviderNodeSchema,
  safetyProviderServerSchema,
} from '@nickhosting/gateway-safety';
import { createNetworkObserver, type NetworkObserver } from '@nickhosting/pterodactyl-adapter';
import { z } from 'zod';
import { createGatewayControlClient } from './control-client.js';
import { createGatewayDataPlane } from './data-plane.js';
import { probeNodeEndpoint } from './node-probe.js';

type Environment = Readonly<Record<string, string | undefined>>;
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function loadProtocols(env: Environment): Promise<GatewayProtocolAdapter[]> {
  let paths: unknown;
  try {
    paths = JSON.parse(env.NH_GATEWAY_PROTOCOL_MODULES ?? '[]');
  } catch {
    throw new DomainError('configuration_invalid');
  }
  const parsed = z.array(z.string().refine(isAbsolute)).max(32).safeParse(paths);
  if (!parsed.success) throw new DomainError('configuration_invalid');
  const protocols: GatewayProtocolAdapter[] = [];
  for (const path of parsed.data) {
    // Local trusted application code only; never import URLs or Owner-supplied
    // request strings. Real game modules are supplied by later milestones.
    const module = await import(pathToFileURL(path).href);
    if (!Array.isArray(module.gatewayProtocols)) throw new DomainError('configuration_invalid');
    for (const protocol of module.gatewayProtocols) {
      if (
        !protocol ||
        !z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,63}$/)
          .safeParse(protocol.id).success ||
        !['supports', 'classify', 'response', 'probeReadiness'].every(
          (key) => typeof protocol[key] === 'function',
        ) ||
        (protocol.probeIdle !== undefined && typeof protocol.probeIdle !== 'function')
      )
        throw new DomainError('configuration_invalid');
      protocols.push(protocol);
    }
  }
  return protocols;
}
export async function createGatewayRuntime(
  env: Environment,
  dependencies: {
    protocols?: readonly GatewayProtocolAdapter[];
    observer?: NetworkObserver;
    fetcher?: typeof fetch;
  } = {},
) {
  const bootstrap = resolveConfig({}, env).values;
  if (!bootstrap.gatewayId || !bootstrap.gatewayCoreUrl || !env.NH_GATEWAY_CONTROL_TOKEN)
    throw new DomainError('configuration_invalid');
  const client = createGatewayControlClient({
    gatewayId: bootstrap.gatewayId,
    baseUrl: bootstrap.gatewayCoreUrl,
    token: env.NH_GATEWAY_CONTROL_TOKEN,
    requestTimeoutMs: bootstrap.gatewayDataPolicy.requestTimeoutMs,
    maxResponseBytes: bootstrap.gatewayDataPolicy.maxResponseBytes,
    fetcher: dependencies.fetcher,
  });
  try {
    const owner = await client.requestJson('configuration');
    const settings = resolveConfig(owner, env).values;
    if (
      !settings.gatewayEnabled ||
      !settings.gatewayObserver ||
      !settings.gatewayNetworkPolicy ||
      settings.gatewayId !== bootstrap.gatewayId
    )
      throw new DomainError('configuration_invalid');
    const networkPolicy = gatewayNetworkPolicySchema.parse(settings.gatewayNetworkPolicy);
    const observer = dependencies.observer ?? createNetworkObserver(settings.gatewayObserver);
    const protocols = dependencies.protocols ?? (await loadProtocols(env));
    const serverRoutes = new Map<number, string>();
    const context = async (route: { id: string; revision: number }) => {
      const result = gatewaySafetyContextSchema.parse(
        await client.requestJson('context', { routeId: route.id, routeRevision: route.revision }),
      );
      serverRoutes.set(result.providerServerId, route.id);
      return result;
    };
    const policy = settings.gatewayDataPolicy;
    const probe = async (
      route: Parameters<typeof createGatewaySafetyValidator>[0]['probeBackend'] extends (
        route: infer T,
      ) => unknown
        ? T
        : never,
    ) => {
      const handler = protocols.find(
        (p) => p.id === route.protocol?.handlerId && p.supports(route),
      );
      if (!handler) return false;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), policy.probeTimeoutMs);
      try {
        return await Promise.race([
          handler
            .probeReadiness({ route, signal: controller.signal })
            .then((r) => r.ready === true),
          new Promise<false>((resolve) =>
            controller.signal.addEventListener('abort', () => resolve(false), { once: true }),
          ),
        ]);
      } catch {
        return false;
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    };
    const safety = createGatewaySafetyValidator({
      policy: networkPolicy,
      observer,
      provider: {
        listNodes: async () =>
          z
            .array(safetyProviderNodeSchema)
            .max(1000)
            .parse(await client.requestJson('inventory', { operation: 'nodes' })),
        listAllocations: async (nodeId) =>
          z
            .array(safetyProviderAllocationSchema)
            .max(100000)
            .parse(await client.requestJson('inventory', { operation: 'allocations', nodeId })),
        getApplicationServer: async (id) => {
          const routeId = serverRoutes.get(id);
          if (!routeId) throw new DomainError('provenance_mismatch');
          return safetyProviderServerSchema.parse(
            await client.requestJson('inventory', { operation: 'server', routeId }),
          );
        },
      },
      resolveContext: context,
      loadProof: async (route) =>
        gatewayReachabilityProofSchema.nullable().parse(
          await client.requestJson('proof-read', {
            routeId: route.id,
            routeRevision: route.revision,
          }),
        ),
      saveProof: async (route, proof) => {
        await client.requestJson('proof-write', {
          routeId: route.id,
          routeRevision: route.revision,
          proof,
        });
      },
      probeBackend: probe,
      probeNode: async (route) => {
        const identity = await context(route),
          target = settings.gatewayNodeProbes[String(identity.providerNodeId)];
        return target
          ? probeNodeEndpoint(
              route.backend.address,
              target.port,
              target.transport,
              policy.probeTimeoutMs,
            )
          : false;
      },
    });
    const initial = fingerprint(owner);
    let changed = false;
    const logger = createLogger((record) => process.stdout.write(`${JSON.stringify(record)}\n`), {
      level: settings.logLevel,
    });
    const gateway = createGatewayDataPlane({
      gatewayId: bootstrap.gatewayId,
      protocols,
      safety,
      logger,
      control: {
        ...client,
        async fetchSnapshot() {
          const current = await client.requestJson('configuration');
          if (fingerprint(current) !== initial) {
            changed = true;
            throw new DomainError('configuration_invalid');
          }
          return client.fetchSnapshot();
        },
      },
      policy: {
        maximumLeaseMs: settings.gatewayLeaseSeconds * 1000,
        maxClockSkewMs: policy.maxClockSkewMs,
        pollIntervalMs: policy.pollIntervalMs,
        observationIntervalMs: policy.probeIntervalMs,
        probeTimeoutMs: policy.probeTimeoutMs,
        tcpConnectTimeoutMs: policy.connectTimeoutMs,
        tcpIdleTimeoutMs: policy.tcpIdleMs,
        classificationTimeoutMs: policy.classificationTimeoutMs,
        maxClassificationBytes: policy.maxClassificationBytes,
        maxProtocolResponseBytes: policy.maxProtocolResponseBytes,
        maxTcpConnections: policy.maxTcpConnections,
        maxUdpSessions: policy.maxUdpSessions,
        udpIdleTimeoutMs: policy.udpSessionIdleMs,
        maxUdpQueuedBytes: policy.maxUdpQueuedBytes,
        wakeRetryMs: policy.wakeRetryMs,
        gracefulShutdownMs: policy.shutdownGraceMs,
      },
    });
    await gateway.start();
    return {
      gateway,
      configurationChanged: () => changed,
      async close() {
        client.close();
        await gateway.stop();
      },
    };
  } catch (error) {
    client.close();
    throw error;
  }
}

/** A failed initialization remains a closed, observable process and retries Core.
 * No game endpoint or default wildcard health listener is ever inferred. */
export async function main(
  env: Environment = process.env,
  dependencies: {
    /** Isolated clock control in tests; production uses an abortable monotonic timer. */
    waitForLeaseDrain?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const config = resolveConfig({}, env).values;
  if (!config.gatewayId || !config.gatewayCoreUrl || !env.NH_GATEWAY_CONTROL_TOKEN)
    throw new DomainError('configuration_invalid');
  let runtime: Awaited<ReturnType<typeof createGatewayRuntime>> | undefined,
    stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined, active: Promise<void> | undefined;
  const logger = createLogger((record) => process.stdout.write(`${JSON.stringify(record)}\n`));
  const health = createHttpServer((request, response) => {
    const actual = createHash('sha256')
        .update(request.headers.authorization ?? '')
        .digest(),
      expected = createHash('sha256').update(`Bearer ${env.NH_GATEWAY_CONTROL_TOKEN}`).digest();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    if (!timingSafeEqual(actual, expected)) {
      response.writeHead(401).end('{}');
      return;
    }
    if (
      request.method !== 'GET' ||
      !['/healthz', '/readyz', '/metrics'].includes(request.url ?? '')
    ) {
      response.writeHead(404).end('{}');
      return;
    }
    const state = runtime?.gateway.health() ?? { ready: false, controlAvailable: false, stopping };
    response
      .writeHead(request.url === '/readyz' && !state.ready ? 503 : 200)
      .end(JSON.stringify(request.url === '/metrics' ? (runtime?.gateway.metrics() ?? {}) : state));
  });
  health.requestTimeout = 5000;
  health.headersTimeout = 5000;
  health.setTimeout(5000);
  health.maxConnections = 32;
  if (env.NH_GATEWAY_HEALTH_ADDRESS || env.NH_GATEWAY_HEALTH_PORT)
    throw new DomainError('configuration_invalid');
  if (config.gatewayDiagnosticsSocket) {
    // Local diagnostics never creates an additional TCP listener outside the
    // allocation collision gate. Never unlink an unknown existing socket/file.
    await new Promise<void>((resolve, reject) => {
      health.once('error', reject);
      health.listen(config.gatewayDiagnosticsSocket, () => {
        health.removeListener('error', reject);
        resolve();
      });
    });
    try {
      await chmod(config.gatewayDiagnosticsSocket, 0o600);
    } catch (error) {
      await new Promise<void>((resolve) => health.close(() => resolve()));
      throw error;
    }
    health.on('error', () => logger.log('warn', 'gateway.health_failed'));
  }
  const drainController = new AbortController();
  const drain =
    dependencies.waitForLeaseDrain ??
    ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  const poll = async () => {
    try {
      if (runtime?.configurationChanged()) {
        await runtime.close();
        runtime = undefined;
      }
      if (!runtime && !stopping) {
        // Maximum supported Core lease (30s) plus maximum clock skew (1s).
        // A restarted process cannot forward while an old idle report may still
        // commit. setTimeout uses elapsed time, independently of wall-clock jumps.
        await drain(31000, drainController.signal);
        if (!stopping) runtime = await createGatewayRuntime(env);
      }
    } catch {
      if (!stopping) logger.log('warn', 'gateway.initialization_unavailable');
    } finally {
      if (stopping && runtime) {
        await runtime.close();
        runtime = undefined;
      }
      if (!stopping)
        timer = setTimeout(() => {
          active = poll();
        }, config.gatewayDataPolicy.pollIntervalMs);
    }
  };
  active = poll();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      stopping = true;
      drainController.abort();
      if (timer) clearTimeout(timer);
      await active;
      if (runtime) await runtime.close();
      if (health.listening) await new Promise<void>((resolve) => health.close(() => resolve()));
    })());
  const stop = () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return {
    async close() {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      await close();
    },
    health: () => runtime?.gateway.health() ?? { ready: false, controlAvailable: false, stopping },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'gateway.start_failed' })}\n`);
    process.exitCode = 1;
  });
