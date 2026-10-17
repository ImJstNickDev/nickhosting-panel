import { isIP } from 'node:net';
import { gatewayPresentationSchema, minecraftGatewayResponsesSchema } from '@nickhosting/core';
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
/** Ephemeral listener response; stopping is not persisted routing authority. */
export type GatewayResponseMode = GatewayMode | 'stopping';
export interface GatewayProtocolObservation {
  ready: boolean;
  idle?: boolean;
  playerCount?: number;
}

export const gatewayEndpointSchema = z
  .object({
    address: ipAddress,
    port: z.number().int().min(1).max(65535),
    transport: z.enum(['tcp', 'udp']),
  })
  .strict();
export type GatewayEndpoint = z.infer<typeof gatewayEndpointSchema>;

/** Core-minted, service-only routing metadata. The authority is explicit:
 * compiled integration declarations are not installation test attestations. */
const minecraftProtocolBase = z.object({
  release: z.string().min(1).max(128),
  protocolId: z.number().int().nonnegative().max(2147483647),
  family: z.enum(['netty', 'legacy']),
  responses: minecraftGatewayResponsesSchema.optional(),
  transfer: z.boolean(),
  acceptsTransfers: z.literal(false),
  choiceId: z.uuid(),
  choiceDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const gatewayMinecraftProtocolSchema = z
  .union([
    minecraftProtocolBase
      .extend({
        supportSource: z.literal('integration'),
        declarationId: z.string().min(1).max(128),
        declarationVersion: z.number().int().positive(),
      })
      .strict(),
    minecraftProtocolBase
      .extend({
        supportSource: z.literal('evidence').optional(),
        evidenceRunId: z.uuid(),
        evidenceExpiresAt: timestamp,
      })
      .strict(),
  ])
  .refine((value) => !value.transfer || (value.family === 'netty' && value.protocolId >= 766));
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
    // A durable confirmed sleep completion; consumers still match their exact local fence.
    completedSleep: z
      .object({
        jobId: z.uuid(),
        generation: z.uuid(),
        quiescenceUntil: timestamp,
        completedAt: timestamp,
      })
      .strict()
      .optional(),
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
    wakeEnabled: z.boolean().optional(),
    presentation: gatewayPresentationSchema.optional(),
    locale: z.enum(['en', 'it']),
  })
  .strict()
  .refine(
    (route) =>
      !route.completedSleep ||
      (route.mode === 'sleeping' && route.completedSleep.generation === route.generation),
  )
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
  /** Commit notification only; receipt must match the current fenced operation.
   * No timer here grants authority or extends a listener lease. */
  waitForSleep?(
    request: { routeId: string; generation: string; quiescenceUntil: string },
    signal: AbortSignal,
  ): Promise<GatewaySnapshot | undefined>;
  fetchSnapshot(): Promise<GatewaySnapshot>;
  requestWake(request: GatewayWakeRequest): Promise<GatewayWakeResult>;
  // A receipt can advance an unchanged waking route within its ORIGINAL lease.
  // biome-ignore lint/suspicious/noConfusingVoidType: Legacy Core returns 204.
  reportObservation(observation: GatewayObservation): Promise<void | GatewaySnapshot>;
  watchStartup?(
    request: { routeId: string; routeRevision: number; generation: string; wakeJobId: string },
    onHint: (ready?: { snapshot: GatewaySnapshot; observedAt: string }) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface GatewayProbeDiagnostic {
  /** One-based attempt within a single bounded readiness probe. */
  attempt?: number;
  stage: 'tcp_connect' | 'status_response' | 'pong' | 'total';
  durationMs: number;
  outcome: 'ok' | 'failed';
  reason?:
    | 'aborted'
    | 'unsupported'
    | 'connection_refused'
    | 'socket_error'
    | 'socket_closed'
    | 'timeout'
    | 'invalid_frame'
    | 'protocol_mismatch';
}
export interface GatewaySessionDiagnostic {
  family: 'netty' | 'legacy-utf16' | 'legacy-modified-utf8';
  clientProtocol?: number;
  announcedProtocol?: number;
  action: 'status' | 'login' | 'incompatible' | 'transfer';
}
export interface GatewayProtocolContext {
  route: Readonly<GatewayRoute>;
  signal: AbortSignal;
  /** Optional trusted diagnostics; implementations must isolate sink failures. */
  onProbeDiagnostic?: (event: GatewayProbeDiagnostic) => void;
  onSessionDiagnostic?: (event: GatewaySessionDiagnostic) => void;
}
export type GatewayIntent = { kind: 'need-more' | 'status' | 'ignore' | 'join' | 'unsupported' };

/** A bounded offline TCP conversation. State belongs to ONE connection. The
 * data plane passes only unconsumed bytes and enforces lifetime/byte limits. */
export interface GatewayProtocolSession {
  /** Bounded quiet interval for historically unframed request prefixes only. */
  readonly classificationIdleMs?: number;
  finalize?(input: Uint8Array): ReturnType<GatewayProtocolSession['classify']>;
  classify(input: Uint8Array): {
    kind: 'need-more' | 'continue' | 'status' | 'join' | 'reject' | 'unsupported';
    consumedBytes: number;
  };
  response(state: GatewayResponseMode): { bytes?: Uint8Array; close: boolean };
}

/** Trusted game code. Implementations must distinguish real protocol readiness
 * and player idleness; an open socket or no Gateway traffic proves neither. */
export interface GatewayProtocolAdapter {
  readonly id: string;
  /** Authenticated provider events may deliver durable readiness receipts for opted-in integrations. */
  readonly startupHint?: 'provider_running';
  readonly readinessSource?: 'provider_running';
  supports(route: Readonly<GatewayRoute>): boolean;
  classify(input: Uint8Array, context: GatewayProtocolContext): GatewayIntent;
  response(context: GatewayProtocolContext, state: GatewayResponseMode): Uint8Array | undefined;
  /** Optional stateful TCP status/ping dialogue; old datagram/fixture adapters
   * retain the stateless classify/response contract. Used only while forwarding is fenced. */
  createSession?(context: GatewayProtocolContext): GatewayProtocolSession;
  /** One fresh protocol exchange may establish readiness and explicit player idleness. */
  observe?(context: GatewayProtocolContext): Promise<GatewayProtocolObservation>;
  probeReadiness(context: GatewayProtocolContext): Promise<{ ready: boolean }>;
  probeIdle?(context: GatewayProtocolContext): Promise<{ idle: boolean; playerCount?: number }>;
}

export interface GatewaySafety {
  /** Freshly checks provider allocations, host bindings and ownership. Missing
   * binding proof requires a successful live backend protocol challenge. A matching
   * prior proof plus fresh node reachability can retain a status-only listener when
   * the backend stops: return backendReady:false to prohibit forwarding. Authorized
   * sleeping/blocked routes may still request wake outside the quiescence fence.
   * A void result retains the original contract (online backend proven ready). */
  validate(
    route: GatewayRoute,
    ownedBindings: readonly GatewayEndpoint[],
    // biome-ignore lint/suspicious/noConfusingVoidType: Preserve existing strict validator implementations returning Promise<void>.
  ): Promise<void | { backendReady: boolean }>;
  /** Independent exact Docker binding identity and namespace reachability proof. */
  // biome-ignore lint/suspicious/noConfusingVoidType: Legacy validators provide no reusable protocol sample.
  validateBackend(route: GatewayRoute): Promise<void | GatewayProtocolObservation>;
  /** Only for already-bound waking routes under the original live listener lease. */
  // biome-ignore lint/suspicious/noConfusingVoidType: Legacy validators provide no reusable protocol sample.
  probeLeasedBackend?(route: GatewayRoute): Promise<void | GatewayProtocolObservation>;
}
