import { randomUUID } from 'node:crypto';
import { type GatewayRoute, gatewayRouteSchema } from '@nickhosting/game-sdk';
import { describe, expect, it } from 'vitest';
import { createMinecraftGatewayModuleAdapter, gatewayProtocols } from './gateway-module.js';
import { encodeMinecraftVarInt, frameMinecraftPacket } from './protocol.js';

const now = new Date('2026-10-10T00:00:00Z');
function route(): GatewayRoute & {
  protocol: NonNullable<GatewayRoute['protocol']> & {
    minecraft: NonNullable<NonNullable<GatewayRoute['protocol']>['minecraft']>;
  };
} {
  return {
    id: randomUUID(),
    serverId: randomUUID(),
    nodeId: randomUUID(),
    allocationId: randomUUID(),
    revision: 1,
    generation: randomUUID(),
    public: { address: '127.0.0.1', port: 25001, transport: 'tcp' },
    backend: { allocationAddress: '127.0.0.1', address: '127.0.0.2', port: 25001 },
    protocol: {
      handlerId: 'minecraft-java',
      gameVersion: '1.21.1',
      role: 'game',
      minecraft: {
        release: '1.21.1',
        protocolId: 767,
        family: 'netty',
        transfer: true,
        acceptsTransfers: false,
        choiceId: randomUUID(),
        choiceDigest: 'a'.repeat(64),
        evidenceRunId: randomUUID(),
        evidenceExpiresAt: new Date(now.getTime() + 1000).toISOString(),
      },
    },
    mode: 'sleeping',
    locale: 'en',
  };
}
function hello(intent: number, protocol = 767): Buffer {
  return frameMinecraftPacket(
    0,
    Buffer.concat([
      encodeMinecraftVarInt(protocol),
      Buffer.from([1, 120, 0x61, 0xa9]),
      encodeMinecraftVarInt(intent),
    ]),
  );
}
describe('production Minecraft Gateway module', () => {
  it('supports current declarations for modern/legacy families and preserves legacy routes', () => {
    const adapter = createMinecraftGatewayModuleAdapter();
    for (const [release, protocolId, family] of [
      ['26.3', 777, 'netty'],
      ['a1.0.15', 13, 'legacy'],
      ['1.6.4', 78, 'legacy'],
    ] as const) {
      const selected = route();
      selected.protocol.gameVersion = release;
      selected.protocol.minecraft = {
        release,
        protocolId,
        family,
        transfer: false,
        acceptsTransfers: false,
        choiceId: randomUUID(),
        choiceDigest: 'a'.repeat(64),
        supportSource: 'integration',
        declarationId: 'minecraft/vanilla',
        declarationVersion: 2,
      };
      expect(gatewayRouteSchema.safeParse(selected).success).toBe(true);
      expect(adapter.supports(selected)).toBe(true);
    }
  });

  it('accepts only exact compiled declarations without claiming a local evidence run', () => {
    const adapter = createMinecraftGatewayModuleAdapter({ now: () => now });
    const selected = route();
    selected.protocol.gameVersion = '26.1';
    selected.protocol.minecraft = {
      release: '26.1',
      protocolId: 775,
      family: 'netty',
      transfer: true,
      acceptsTransfers: false,
      choiceId: randomUUID(),
      choiceDigest: 'a'.repeat(64),
      supportSource: 'integration',
      declarationId: 'minecraft-java/vanilla',
      declarationVersion: 1,
    };
    expect(gatewayRouteSchema.safeParse(selected).success).toBe(true);
    expect(adapter.supports(selected)).toBe(true);
    const session = adapter.createSession?.({
      route: selected,
      signal: new AbortController().signal,
    });
    expect(session?.classify(hello(2, 775)).kind).toBe('continue');
    expect(session?.classify(frameMinecraftPacket(0, Buffer.from([1, 120]))).kind).toBe('join');
    selected.protocol.minecraft.declarationVersion = 2;
    expect(adapter.supports(selected)).toBe(false);
    expect(session?.response('waking')).toEqual({ close: true });
    selected.protocol.minecraft.declarationVersion = 1;
    selected.protocol.minecraft.protocolId = 774;
    expect(adapter.supports(selected)).toBe(false);
    selected.protocol.minecraft.protocolId = 775;
    selected.protocol.minecraft.declarationId = 'owner-checkbox';
    expect(adapter.supports(selected)).toBe(false);
  });
  it('provides the existing loader contract without fetching metadata', () => {
    expect(gatewayProtocols).toHaveLength(1);
    expect(gatewayProtocols[0]?.id).toBe('minecraft-java');
    expect(gatewayProtocols[0]?.startupHint).toBe('provider_running');
    const adapter = createMinecraftGatewayModuleAdapter({ now: () => now });
    const selected = route();
    expect(adapter.supports(selected)).toBe(true);
    expect(gatewayRouteSchema.safeParse(selected).success).toBe(true);
    const session = adapter.createSession?.({
      route: selected,
      signal: new AbortController().signal,
    });
    expect(session?.classify(hello(2)).kind).toBe('continue');
    expect(session?.classify(frameMinecraftPacket(0, Buffer.from([1, 120]))).kind).toBe('join');
    expect(session?.response('waking').bytes?.length).toBeGreaterThan(0);
  });
  it('requires Core metadata, exact release/handler/role/transport and live evidence', () => {
    const adapter = createMinecraftGatewayModuleAdapter({ now: () => now });
    for (const patch of [
      { protocol: { handlerId: 'minecraft-java', gameVersion: '1.21.1', role: 'game' } },
      { protocol: { ...route().protocol, gameVersion: '26.1' } },
      { protocol: { ...route().protocol, handlerId: 'generic' } },
      { protocol: { ...route().protocol, role: 'query' } },
      { public: { address: '127.0.0.1', port: 25001, transport: 'udp' as const } },
      {
        protocol: {
          ...route().protocol,
          minecraft: { ...route().protocol.minecraft, evidenceExpiresAt: now.toISOString() },
        },
      },
    ])
      expect(adapter.supports({ ...route(), ...patch })).toBe(false);
    const missing = route();
    delete (missing.protocol as NonNullable<GatewayRoute['protocol']>).minecraft;
    expect(gatewayRouteSchema.safeParse(missing).success).toBe(false);
  });
  it('keeps passive status separate and recognizes disallowed transfers without waking', () => {
    const adapter = createMinecraftGatewayModuleAdapter({ now: () => now });
    const context = { route: route(), signal: new AbortController().signal };
    const passive = adapter.createSession?.(context);
    expect(passive?.classify(hello(1)).kind).toBe('continue');
    expect(passive?.classify(frameMinecraftPacket(0)).kind).toBe('status');
    expect(passive?.response('sleeping').close).toBe(false);
    for (const handshake of [hello(3), hello(2, 999999)]) {
      const session = adapter.createSession?.(context);
      expect(session?.classify(handshake).kind).toBe('continue');
      expect(session?.classify(frameMinecraftPacket(0, Buffer.from([1, 120]))).kind).toBe('reject');
    }
  });
  it('does not carry an old conversation across replaced protocol evidence', () => {
    const adapter = createMinecraftGatewayModuleAdapter({ now: () => now });
    const selected = route();
    const session = adapter.createSession?.({
      route: selected,
      signal: new AbortController().signal,
    });
    expect(session?.classify(hello(1)).kind).toBe('continue');
    if (selected.protocol.minecraft.supportSource === 'integration') throw new Error('fixture');
    selected.protocol.minecraft.evidenceRunId = randomUUID();
    expect(session?.classify(frameMinecraftPacket(0)).kind).toBe('unsupported');
    expect(session?.response('sleeping')).toEqual({ close: true });
  });
  it('expires in-progress conversations and rejects stale readiness even without Core access', async () => {
    let clock = now;
    const adapter = createMinecraftGatewayModuleAdapter({ now: () => clock });
    const context = { route: route(), signal: new AbortController().signal };
    const session = adapter.createSession?.(context);
    expect(session?.classify(hello(1)).kind).toBe('continue');
    clock = new Date(now.getTime() + 1000);
    expect(session?.classify(frameMinecraftPacket(0)).kind).toBe('unsupported');
    expect(session?.response('sleeping')).toEqual({ close: true });
    expect(await adapter.probeReadiness(context)).toEqual({ ready: false });
    expect(await adapter.probeIdle?.(context)).toEqual({ idle: false });
    expect(await adapter.observe?.(context)).toEqual({ ready: false, idle: false });
  });
});
