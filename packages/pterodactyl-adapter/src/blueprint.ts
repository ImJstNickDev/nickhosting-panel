import { z } from 'zod';
import { createTransport, PterodactylError, type TransportOptions } from './transport.js';

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
      .object({ clientKeyManagement: z.boolean(), serverChangeEvents: z.boolean() })
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
