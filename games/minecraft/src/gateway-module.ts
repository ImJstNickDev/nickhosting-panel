import {
  type GatewayProtocolAdapter,
  type GatewayProtocolContext,
  type GatewayRoute,
  gatewayMinecraftProtocolSchema,
} from '@nickhosting/game-sdk';
import { minecraftCapabilityDeclaration, minecraftGatewaySupported } from './compatibility.js';
import { createMinecraftProtocolAdapter } from './protocol.js';

/** Local trusted module for NH_GATEWAY_PROTOCOL_MODULES. No registry/network reads or provider keys. */
export function createMinecraftGatewayModuleAdapter(
  options: { now?: () => Date; probeTimeoutMs?: number; maxStatusBytes?: number } = {},
): GatewayProtocolAdapter {
  const cache = new WeakMap<
    Readonly<GatewayRoute>,
    { identity: string; adapter: GatewayProtocolAdapter }
  >();
  const select = (route: Readonly<GatewayRoute>): GatewayProtocolAdapter | undefined => {
    if (
      route.protocol?.handlerId !== 'minecraft-java' ||
      route.protocol.role !== 'game' ||
      route.public.transport !== 'tcp'
    )
      return;
    const parsed = gatewayMinecraftProtocolSchema.safeParse(route.protocol.minecraft);
    if (!parsed.success || parsed.data.release !== route.protocol.gameVersion) return;
    if (parsed.data.supportSource === 'integration') {
      const declaration = parsed.data;
      if (
        declaration.declarationId !== minecraftCapabilityDeclaration.id ||
        declaration.declarationVersion !== minecraftCapabilityDeclaration.version ||
        !minecraftGatewaySupported({
          release: declaration.release,
          releaseType: 'release',
          profile: 'vanilla',
          family: declaration.family,
          protocolId: declaration.protocolId,
        })
      )
        return;
    } else if (
      Date.parse(parsed.data.evidenceExpiresAt) <= (options.now?.() ?? new Date()).getTime()
    )
      return;
    const identity = JSON.stringify(parsed.data);
    let cached = cache.get(route);
    if (!cached || cached.identity !== identity) {
      const adapter = createMinecraftProtocolAdapter({
        versions: [parsed.data],
        supportedReleases: [parsed.data.release],
        acceptsTransfers: parsed.data.acceptsTransfers,
        probeTimeoutMs: options.probeTimeoutMs,
        maxStatusBytes: options.maxStatusBytes,
      });
      cached = { identity, adapter };
      cache.set(route, cached);
    }
    return cached.adapter;
  };
  return {
    id: 'minecraft-java',
    supports: (route) => !!select(route),
    classify: () => ({ kind: 'unsupported' }),
    response: () => undefined,
    createSession(context) {
      const adapter = select(context.route);
      if (!adapter?.createSession) throw new Error('minecraft.unsupported_release');
      const session = adapter.createSession(context);
      return {
        classify: (input) =>
          select(context.route) === adapter
            ? session.classify(input)
            : { kind: 'unsupported', consumedBytes: input.length },
        response: (state) =>
          select(context.route) === adapter ? session.response(state) : { close: true },
      };
    },
    async probeReadiness(context: GatewayProtocolContext) {
      const adapter = select(context.route);
      if (!adapter) return { ready: false };
      const result = await adapter.probeReadiness(context);
      return select(context.route) === adapter ? result : { ready: false };
    },
    async probeIdle(context: GatewayProtocolContext) {
      const adapter = select(context.route);
      if (!adapter?.probeIdle) return { idle: false };
      const result = await adapter.probeIdle(context);
      return select(context.route) === adapter ? result : { idle: false };
    },
  };
}
export const gatewayProtocols: readonly GatewayProtocolAdapter[] = Object.freeze([
  createMinecraftGatewayModuleAdapter(),
]);
