import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { createTransport, PterodactylError, segment, type TransportOptions } from './transport.js';

/** Versioned extension discovery, not proof that a provider account/server is linked. */
export const nickHostingExtensionSchema = z
  .object({
    schemaVersion: z.literal(1),
    extension: z.literal('nickhosting'),
    extensionVersion: z.string().min(1).max(64),
    target: z
      .object({ panel: z.string().min(1).max(64), blueprint: z.string().min(1).max(64) })
      .strict(),
    capabilities: z
      .object({
        clientKeyManagement: z.boolean(),
        serverChangeEvents: z.boolean(),
        technicalAccounts: z.boolean().optional(),
        bulkUploadUrls: z.boolean().optional(),
        bulkDownloadUrls: z.boolean().optional(),
        bulkDirectoryListings: z.boolean().optional(),
        backupEvents: z.boolean().optional(),
        installationEvents: z.boolean().optional(),
        installationConsole: z.boolean().optional(),
        fileOperations: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
export type NickHostingExtension = z.infer<typeof nickHostingExtensionSchema>;

/** Explicit opt-in probe; never runs on Start or changes the stock provider fallback. */
export async function discoverNickHostingExtension(
  options: TransportOptions,
): Promise<NickHostingExtension | null> {
  const transport = createTransport(options);
  try {
    return await transport.json(
      'application',
      'extensions/nickhosting/capabilities',
      nickHostingExtensionSchema,
    );
  } catch (error) {
    // Missing extension is distinct from denied access, throttling or a broken response.
    if (error instanceof PterodactylError && error.reason === 'not_found') return null;
    throw error;
  }
}

export const providerIdentitySchema = z
  .object({
    providerId: z.number().int().positive(),
    providerUuid: z.string().uuid(),
    identifier: z.string().regex(/^[a-zA-Z0-9_-]{1,191}$/),
    externalId: z.string().min(1).max(191),
    nodeId: z.number().int().positive(),
  })
  .strict();
export const providerChangeSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().uuid(),
    instanceId: z.string().uuid(),
    server: providerIdentitySchema,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: z.enum(['snapshot', 'limits.updated', 'identity.invalidated']),
    limits: z
      .object({
        memory: z.number().finite().nonnegative(),
        cpu: z.number().finite().nonnegative(),
        disk: z.number().finite().nonnegative(),
        swap: z.number().finite().min(-1),
        io: z.number().int().min(10).max(1000),
        threads: z.string().max(255).nullable(),
      })
      .strict(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ProviderChange = z.infer<typeof providerChangeSchema>;
export const providerBackupEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.uuid(),
    instanceId: z.uuid(),
    server: providerIdentitySchema,
    type: z.enum(['backup.completed', 'backup.restore-completed']),
    occurredAt: z.iso.datetime({ offset: true }),
    backup: z
      .object({
        uuid: z.uuid(),
        name: z.string().max(191),
        isSuccessful: z.boolean(),
        checksum: z.string().max(255).nullable(),
        bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        completedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();
export type ProviderBackupEvent = z.infer<typeof providerBackupEventSchema>;
export const providerInstallationEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.uuid(),
    instanceId: z.uuid(),
    server: providerIdentitySchema,
    type: z.literal('installation.updated'),
    occurredAt: z.iso.datetime({ offset: true }),
    installation: z.union([
      z.object({ state: z.literal('installing'), status: z.literal('installing') }).strict(),
      z.object({ state: z.literal('installed'), status: z.null() }).strict(),
      z
        .object({
          state: z.literal('failed'),
          status: z.enum(['install_failed', 'reinstall_failed']),
        })
        .strict(),
    ]),
  })
  .strict();
export type ProviderInstallationEvent = z.infer<typeof providerInstallationEventSchema>;
export const providerEventSchema = z.union([
  providerChangeSchema,
  providerBackupEventSchema,
  providerInstallationEventSchema,
]);
export const providerHealthSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: z.string().uuid(),
    pendingEvents: z.number().int().nonnegative(),
    lastDeliveredAt: z.string().datetime({ offset: true }).nullable(),
    checkedAt: z.string().datetime({ offset: true }),
  })
  .strict();
const uuid = z.string().uuid();
const linkedUserSchema = z
  .object({
    providerId: z.number().int().positive(),
    providerUuid: uuid,
    externalId: z.string().min(1).max(191),
  })
  .strict();
const issuedKeySchema = z
  .object({
    identifier: z.string().min(1).max(191),
    key: z.string().min(1).max(4096),
    operationId: uuid,
  })
  .strict();

/** Administrative extension operations. Callers must establish NickHosting ownership first. */
export function createNickHostingBridge(options: TransportOptions) {
  const transport = createTransport(options);
  const instancePath = (instanceId: string) =>
    `extensions/nickhosting/instances/${uuid.parse(instanceId)}`;
  const userPath = (instanceId: string, userId: string) =>
    `${instancePath(instanceId)}/users/${uuid.parse(userId)}`;
  return {
    registerInstance(instanceId: string, input: { callbackUrl: string; webhookSecret: string }) {
      const url = new URL(input.callbackUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
        throw new DomainError('validation_failed');
      const webhookSecret = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(input.webhookSecret);
      return transport.json(
        'application',
        instancePath(instanceId),
        z.object({ instanceId: uuid }),
        'POST',
        { callbackUrl: url.href, webhookSecret },
      );
    },
    linkServer(
      instanceId: string,
      identity: z.infer<typeof providerIdentitySchema>,
      expectedOwnerId?: number,
    ) {
      const input = providerIdentitySchema.parse(identity);
      return transport.json(
        'application',
        `${instancePath(instanceId)}/servers/${input.providerUuid}`,
        providerChangeSchema,
        'PUT',
        {
          ...input,
          ...(expectedOwnerId === undefined
            ? {}
            : { expectedOwnerId: z.number().int().positive().parse(expectedOwnerId) }),
        },
      );
    },
    getServer(instanceId: string, serverUuid: string) {
      return transport.json(
        'application',
        `${instancePath(instanceId)}/servers/${uuid.parse(serverUuid)}`,
        providerChangeSchema,
      );
    },
    health(instanceId: string) {
      return transport.json(
        'application',
        `${instancePath(instanceId)}/health`,
        providerHealthSchema,
      );
    },
    provisionUser(instanceId: string, userId: string) {
      return transport.json(
        'application',
        `${userPath(instanceId, userId)}/provision`,
        linkedUserSchema,
        'POST',
        {},
      );
    },
    linkUser(instanceId: string, userId: string, input: z.infer<typeof linkedUserSchema>) {
      return transport.json(
        'application',
        userPath(instanceId, userId),
        linkedUserSchema,
        'PUT',
        linkedUserSchema.parse(input),
      );
    },
    issueKey(instanceId: string, userId: string, operationId: string, allowedIps: string[] = []) {
      return transport.json(
        'application',
        `${userPath(instanceId, userId)}/keys`,
        issuedKeySchema,
        'POST',
        {
          operationId: uuid.parse(operationId),
          allowedIps: z.array(z.string().min(1).max(64)).max(32).parse(allowedIps),
        },
      );
    },
    rotateKey(
      instanceId: string,
      userId: string,
      identifier: string,
      operationId: string,
      allowedIps: string[] = [],
    ) {
      return transport.json(
        'application',
        `${userPath(instanceId, userId)}/keys/${segment(identifier)}/rotate`,
        issuedKeySchema,
        'POST',
        {
          operationId: uuid.parse(operationId),
          allowedIps: z.array(z.string().min(1).max(64)).max(32).parse(allowedIps),
        },
      );
    },
    revokeKey(instanceId: string, userId: string, identifier: string) {
      return transport.empty(
        'application',
        `${userPath(instanceId, userId)}/keys/${segment(identifier)}`,
        'DELETE',
      );
    },
  };
}

/** Validate the signature before parsing/using an untrusted event. Replay is fenced by stored revisions. */
export function verifyProviderChangeSignature(input: {
  body: string;
  timestamp: string;
  signature: string;
  eventId: string;
  secret: string;
  now?: number;
}): ProviderChange {
  return providerChangeSchema.parse(verifyProviderEventSignature(input));
}

/** Transport authentication is shared; each event family has its own durable replay fence. */
export function verifyProviderEventSignature(input: {
  body: string;
  timestamp: string;
  signature: string;
  eventId: string;
  secret: string;
  now?: number;
}): ProviderChange | ProviderBackupEvent | ProviderInstallationEvent {
  if (
    Buffer.byteLength(input.body) > 65536 ||
    !/^[0-9]{10}$/.test(input.timestamp) ||
    !/^[a-f0-9]{64}$/.test(input.signature) ||
    !/^[a-f0-9]{64}$/.test(input.secret) ||
    Math.abs((input.now ?? Date.now()) - Number(input.timestamp) * 1000) > 60000
  )
    throw new DomainError('forbidden');
  const expected = createHmac('sha256', input.secret)
    .update(`${input.timestamp}.${input.body}`)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(input.signature, 'hex')))
    throw new DomainError('forbidden');
  let payload: unknown;
  try {
    payload = JSON.parse(input.body);
  } catch {
    throw new DomainError('validation_failed');
  }
  const parsed = providerEventSchema.safeParse(payload);
  if (!parsed.success || parsed.data.eventId !== input.eventId)
    throw new DomainError('validation_failed');
  return parsed.data;
}
