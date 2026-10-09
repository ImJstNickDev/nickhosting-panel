import { isIP } from 'node:net';
import { z } from 'zod';

const ipAddress = z
  .string()
  .max(45)
  .refine((value) => isIP(value) !== 0);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
export const gatewayModeSchema = z.enum([
  'sleeping',
  'waking',
  'online',
  'blocked',
  'maintenance',
  'manually_stopped',
]);
export type GatewayMode = z.infer<typeof gatewayModeSchema>;

export const gatewayEndpointSchema = z
  .object({
    address: ipAddress,
    port: z.number().int().min(1).max(65535),
    transport: z.enum(['tcp', 'udp']),
  })
  .strict();
export type GatewayEndpoint = z.infer<typeof gatewayEndpointSchema>;

/** Core-minted, service-only metadata. Registry availability alone cannot mint this proof. */
export const gatewayMinecraftProtocolSchema = z
  .object({
    release: z.string().min(1).max(128),
    protocolId: z.number().int().nonnegative().max(2147483647),
    family: z.literal('netty'),
    transfer: z.boolean(),
    acceptsTransfers: z.literal(false),
    choiceId: z.uuid(),
    choiceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceRunId: z.uuid(),
    evidenceExpiresAt: timestamp,
  })
  .strict()
  .refine((value) => !value.transfer || (value.protocolId >= 766 && value.protocolId < 1073741824));
export type GatewayMinecraftProtocol = z.infer<typeof gatewayMinecraftProtocolSchema>;

export const gatewayRouteSchema = z
  .object({
    id: z.uuid(),
    serverId: z.uuid(),
    nodeId: z.uuid(),
    allocationId: z.uuid(),
    revision,
    generation: z.uuid(),
    wakeJobId: z.uuid().optional(),
    sleepEligibleAt: timestamp.optional(),
    public: gatewayEndpointSchema,
    backend: z
      .object({
        allocationAddress: ipAddress,
        address: ipAddress,
        port: z.number().int().min(1).max(65535),
      })
      .strict(),
    protocol: z
      .object({
        handlerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        gameVersion: z.string().min(1).max(128),
        role: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        minecraft: gatewayMinecraftProtocolSchema.optional(),
      })
      .strict()
      .optional(),
    mode: gatewayModeSchema,
    locale: z.enum(['en', 'it']),
  })
  .strict()
  .refine((route) => {
    const minecraft = route.protocol?.minecraft;
    if (route.protocol?.handlerId === 'minecraft-java')
      return (
        !!minecraft &&
        minecraft.release === route.protocol.gameVersion &&
        route.protocol.role === 'game' &&
        route.public.transport === 'tcp'
      );
    return minecraft === undefined;
  });
export type GatewayRoute = z.infer<typeof gatewayRouteSchema>;

export const gatewaySnapshotSchema = z
  .object({
    gatewayId: z.uuid(),
    revision,
    issuedAt: timestamp,
    expiresAt: timestamp,
    routes: z.array(gatewayRouteSchema).max(10000),
  })
  .strict()
  .refine((value) => Date.parse(value.expiresAt) > Date.parse(value.issuedAt))
  .refine((value) => new Set(value.routes.map((route) => route.id)).size === value.routes.length)
  .refine(
    (value) =>
      new Set(value.routes.map((route) => JSON.stringify(route.public))).size ===
      value.routes.length,
  );
export type GatewaySnapshot = z.infer<typeof gatewaySnapshotSchema>;

export const gatewayWakeRequestSchema = z
  .object({ routeId: z.uuid(), routeRevision: revision, requestId: z.uuid() })
  .strict();
export type GatewayWakeRequest = z.infer<typeof gatewayWakeRequestSchema>;
export const gatewayWakeResultSchema = z
  .object({
    mode: gatewayModeSchema,
    operationId: z.uuid().optional(),
    reasonKey: z.string().max(128).optional(),
  })
  .strict();
export type GatewayWakeResult = z.infer<typeof gatewayWakeResultSchema>;

export const gatewayObservationSchema = z
  .object({
    routeId: z.uuid(),
    routeRevision: revision,
    routes: z
      .array(z.object({ routeId: z.uuid(), routeRevision: revision }).strict())
      .min(1)
      .max(10000),
    generation: z.uuid(),
    wakeJobId: z.uuid().optional(),
    observedAt: timestamp,
    ready: z.boolean(),
    idle: z.boolean().optional(),
    quiescenceUntil: timestamp.optional(),
    playerCount: z.number().int().nonnegative().max(1000000).optional(),
    activeSessions: z.number().int().nonnegative().max(1000000),
  })
  .strict()
  .refine(
    (value) =>
      value.quiescenceUntil === undefined ||
      (value.idle === true &&
        value.ready &&
        value.activeSessions === 0 &&
        value.playerCount === 0 &&
        Date.parse(value.quiescenceUntil) > Date.parse(value.observedAt)),
  )
  .refine(
    (value) => new Set(value.routes.map((route) => route.routeId)).size === value.routes.length,
  )
  .refine((value) =>
    value.routes.some(
      (route) => route.routeId === value.routeId && route.routeRevision === value.routeRevision,
    ),
  );
export type GatewayObservation = z.infer<typeof gatewayObservationSchema>;

export interface GatewayControl {
  fetchSnapshot(): Promise<GatewaySnapshot>;
  requestWake(request: GatewayWakeRequest): Promise<GatewayWakeResult>;
  reportObservation(observation: GatewayObservation): Promise<void>;
}

export interface GatewayProtocolContext {
  route: Readonly<GatewayRoute>;
  signal: AbortSignal;
}
export type GatewayIntent = { kind: 'need-more' | 'status' | 'ignore' | 'join' | 'unsupported' };

/** A bounded offline TCP conversation. State belongs to ONE connection. The
 * data plane passes only unconsumed bytes and enforces lifetime/byte limits. */
export interface GatewayProtocolSession {
  classify(input: Uint8Array): {
    kind: 'need-more' | 'continue' | 'status' | 'join' | 'reject' | 'unsupported';
    consumedBytes: number;
  };
  response(state: GatewayMode): { bytes?: Uint8Array; close: boolean };
}

/** Trusted game code. Implementations must distinguish real protocol readiness
 * and player idleness; an open socket or no Gateway traffic proves neither. */
export interface GatewayProtocolAdapter {
  readonly id: string;
  supports(route: Readonly<GatewayRoute>): boolean;
  classify(input: Uint8Array, context: GatewayProtocolContext): GatewayIntent;
  response(context: GatewayProtocolContext, state: GatewayMode): Uint8Array | undefined;
  /** Optional stateful TCP status/ping dialogue; old datagram/fixture adapters
   * retain the stateless classify/response contract. Never used when online. */
  createSession?(context: GatewayProtocolContext): GatewayProtocolSession;
  probeReadiness(context: GatewayProtocolContext): Promise<{ ready: boolean }>;
  probeIdle?(context: GatewayProtocolContext): Promise<{ idle: boolean; playerCount?: number }>;
}

export interface GatewaySafety {
  /** Freshly checks all provider allocations, host bindings and ownership.
   * For an online route this MUST also prove the exact backend binding and a
   * successful protocol reachability challenge from the Gateway namespace,
   * persisting that proof. No separate validateBackend call is then required.
   * Offline routes instead require matching prior proof and a fresh node probe. */
  validate(route: GatewayRoute, ownedBindings: readonly GatewayEndpoint[]): Promise<void>;
  /** Independent exact Docker binding identity and namespace reachability proof. */
  validateBackend(route: GatewayRoute): Promise<void>;
}
