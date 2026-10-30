import { z } from 'zod';

const localizedText = z.object({ en: z.string().max(512), it: z.string().max(512) }).strict();
const stateMessages = z
  .object({
    sleeping: localizedText.optional(),
    waking: localizedText.optional(),
    stopping: localizedText.optional(),
    blocked: localizedText.optional(),
    maintenance: localizedText.optional(),
    manually_stopped: localizedText.optional(),
    online: localizedText.optional(),
  })
  .strict();
/** Presentation only. Never used as routing, readiness or player-idleness evidence. */
export const minecraftGatewayResponsesSchema = z
  .object({
    fallbackProtocol: z.number().int().nonnegative().max(2147483647).optional(),
    legacyProtocol: z.number().int().min(0).max(255).optional(),
    versionName: z.string().min(1).max(64).optional(),
    onlinePlayers: z.number().int().min(0).max(1000000).optional(),
    maximumPlayers: z.number().int().min(0).max(1000000).optional(),
    motd: stateMessages.optional(),
    disconnect: stateMessages.optional(),
    legacyDisconnect: stateMessages.optional(),
    legacyLineSeparator: z
      .string()
      .max(16)
      .refine((text) => !/[\r\n\0]/.test(text))
      .optional(),
  })
  .strict();
export type MinecraftGatewayResponses = z.infer<typeof minecraftGatewayResponsesSchema>;
