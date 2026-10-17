import { z } from 'zod';

// Transport limits only. Integrations declare their own states, channels and templates.
const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/)
  .refine((value) => value !== 'constructor' && value !== 'prototype');
const messageText = z
  .string()
  .min(1)
  .max(4096)
  .refine((text) =>
    [...text].every((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
    }),
  );
export const gatewayMessageOverridesSchema = z
  .record(
    identifier,
    z.record(identifier, messageText).refine((channels) => Object.keys(channels).length <= 16),
  )
  .refine((states) => Object.keys(states).length <= 32)
  .refine(
    (states) =>
      Object.values(states).reduce(
        (total, channels) =>
          total + Object.values(channels).reduce((length, text) => length + text.length, 0),
        0,
      ) <= 65536,
  );
export type GatewayMessageOverrides = z.infer<typeof gatewayMessageOverridesSchema>;
export const gatewayPresentationSchema = z.strictObject({
  serverName: z.string().max(160),
  messages: gatewayMessageOverridesSchema,
  variables: z
    .record(identifier, z.string().max(1024))
    .refine((values) => Object.keys(values).length <= 32)
    .optional(),
  stopping: z.boolean().optional(),
  blockedReason: z.enum(['capacity_denied', 'unavailable']).optional(),
  // Historical startup estimate, not a routing/readiness timer.
  estimatedStartupSeconds: z.number().int().nonnegative().max(86400).optional(),
  startupBeganAt: z.iso.datetime({ offset: true }).optional(),
});
export type GatewayPresentation = z.infer<typeof gatewayPresentationSchema>;
