import { z } from 'zod';

/** Durable attribution for a narrowly scoped, native Administrator console action.
 * The token itself never enters a lifecycle plan. */
export const gatewayConsoleOperationSchema = z.strictObject({
  generation: z.uuid(),
  action: z.enum(['sleep', 'restart']),
  // INVALID is the native anonymous identity, canonicalized only after the API
  // verifies its Administrator fingerprint; arbitrary malformed IDs never fall back.
  playerId: z.union([z.string().regex(/^(?:[a-fA-F0-9]{2}){1,1024}$/), z.literal('INVALID')]),
  protocolId: z.string().min(1).max(64),
});
export function isGatewayConsoleSleep(plan: Record<string, unknown>): boolean {
  const result = gatewayConsoleOperationSchema.safeParse(plan.gatewayConsole);
  return result.success && result.data.action === 'sleep';
}
