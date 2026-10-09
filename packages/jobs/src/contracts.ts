import { createHash } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';

/** Public foundation command; server operations are enqueued only by admission services. */
export const foundationCommandSchema = z
  .object({
    type: z.literal('foundation.record-activity'),
    version: z.literal(1),
    payload: z.object({ source: z.enum(['user_request', 'system_check']) }).strict(),
  })
  .strict();

export const serverOperationCommandSchema = z.strictObject({
  type: z.literal('server.operation'),
  version: z.literal(1),
  payload: z.strictObject({ serverId: z.uuid(), operationId: z.uuid() }),
});
export const commandSchema = z.discriminatedUnion('type', [
  foundationCommandSchema,
  serverOperationCommandSchema,
]);
export type JobCommand = z.infer<typeof commandSchema>;
export type FoundationCommand = z.infer<typeof foundationCommandSchema>;

export const deliverySchema = z.object({ jobId: z.uuid() }).strict();
export type JobDelivery = z.infer<typeof deliverySchema>;

export function parseCommand(input: unknown): JobCommand {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('validation_failed');
  return parsed.data;
}

/** Field ordering is normalized by parsing a strict versioned contract first. */
export function commandDigest(input: {
  command: JobCommand;
  subjectId: string;
  resourceOwnerId: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        command: parseCommand(input.command),
        subjectId: input.subjectId,
        resourceOwnerId: input.resourceOwnerId,
      }),
    )
    .digest('hex');
}

export function retryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new DomainError('validation_failed');
  return Math.min(60_000, 1_000 * 2 ** Math.min(attempt - 1, 6));
}
