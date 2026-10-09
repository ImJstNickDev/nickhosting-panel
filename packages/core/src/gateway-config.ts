import { isIP } from 'node:net';
import { z } from 'zod';

const absolutePath = z
  .string()
  .startsWith('/')
  .max(4096)
  .refine((v) => !v.includes('\0'));
const interfaceAddress = z.string().refine((v) => isIP(v) === 4);
export const gatewayNetworkPolicySchema = z
  .object({
    nodes: z
      .array(
        z
          .object({
            nodeId: z.number().int().positive(),
            nodeUuid: z.uuid(),
            networkMode: z.string().min(1).max(255),
            loopbackRemap: z
              .object({
                wingsVersion: z.literal('1.11.13'),
                interfaceAddress,
                ispn: z.literal(false),
                verifiedEggs: z
                  .array(
                    z
                      .object({
                        nestId: z.number().int().positive(),
                        eggId: z.number().int().positive(),
                        forceOutgoingIp: z.literal(false),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(1000),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    maximumObservationAgeMs: z.number().int().min(100).max(15000),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.nodes.map((n) => n.nodeId)).size === v.nodes.length &&
      new Set(v.nodes.map((n) => n.nodeUuid)).size === v.nodes.length,
  );
export const gatewayObserverSchema = z
  .object({
    dockerSocket: absolutePath,
    hostProcDirectory: absolutePath,
    expectedHostNamespaceId: z.string().regex(/^net:\[\d+\]$/),
    expectedDockerDaemonId: z.string().min(1).max(256),
  })
  .strict();
export const gatewayNodeProbesSchema = z.record(
  z.string().regex(/^[1-9]\d*$/),
  z
    .object({ port: z.number().int().min(1).max(65535), transport: z.enum(['tcp', 'udp']) })
    .strict(),
);
export const gatewayDataPolicySchema = z
  .object({
    pollIntervalMs: z.number().int().min(100).max(10000),
    requestTimeoutMs: z.number().int().min(100).max(10000),
    maxResponseBytes: z.number().int().min(65536).max(16777216),
    maxTcpConnections: z.number().int().min(1).max(100000),
    maxUdpSessions: z.number().int().min(1).max(100000),
    udpSessionIdleMs: z.number().int().min(100).max(3600000),
    tcpIdleMs: z.number().int().min(100).max(86400000),
    classificationTimeoutMs: z.number().int().min(100).max(30000),
    maxClassificationBytes: z.number().int().min(1).max(1048576),
    connectTimeoutMs: z.number().int().min(100).max(30000),
    probeIntervalMs: z.number().int().min(100).max(30000),
    probeTimeoutMs: z.number().int().min(100).max(30000),
    shutdownGraceMs: z.number().int().min(1).max(60000),
    maxClockSkewMs: z.number().int().min(0).max(1000),
    maxProtocolResponseBytes: z.number().int().min(1).max(65536),
    maxUdpQueuedBytes: z.number().int().min(1).max(1048576),
    wakeRetryMs: z.number().int().min(100).max(300000),
  })
  .strict();

export const defaultGatewayDataPolicy = {
  pollIntervalMs: 2000,
  requestTimeoutMs: 5000,
  maxResponseBytes: 4194304,
  maxTcpConnections: 2048,
  maxUdpSessions: 4096,
  udpSessionIdleMs: 30000,
  tcpIdleMs: 300000,
  classificationTimeoutMs: 5000,
  maxClassificationBytes: 65536,
  connectTimeoutMs: 5000,
  probeIntervalMs: 2000,
  probeTimeoutMs: 3000,
  shutdownGraceMs: 5000,
  maxClockSkewMs: 100,
  maxProtocolResponseBytes: 4096,
  maxUdpQueuedBytes: 65536,
  wakeRetryMs: 1000,
};
