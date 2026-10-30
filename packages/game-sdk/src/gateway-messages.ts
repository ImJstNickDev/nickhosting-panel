import { type GatewayMessageOverrides, gatewayMessageOverridesSchema } from '@nickhosting/core';
import { z } from 'zod';

const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/)
  .refine((value) => value !== 'constructor' && value !== 'prototype');
const label = z.strictObject({ en: z.string().min(1).max(160), it: z.string().min(1).max(160) });
const values = z.record(identifier, z.string().max(4096));
const localizedValues = z.strictObject({ en: values, it: values });
const channelSchema = z.strictObject({
  id: identifier,
  label,
  maxLength: z.number().int().min(1).max(4096),
  multiline: z.boolean(),
  formatting: z
    .strictObject({
      caseInsensitive: z.boolean().optional(),
      tokens: z
        .array(
          z.strictObject({
            value: z
              .string()
              .min(1)
              .max(32)
              .refine(
                (value) =>
                  !/[\s{}]/.test(value) &&
                  [...value].every(
                    (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
                  ),
              ),
            label,
            reset: z.boolean().optional(),
            style: z
              .strictObject({
                color: z
                  .string()
                  .regex(/^#[a-fA-F0-9]{6}$/)
                  .optional(),
                bold: z.boolean().optional(),
                italic: z.boolean().optional(),
                underline: z.boolean().optional(),
                strike: z.boolean().optional(),
              })
              .optional(),
          }),
        )
        .min(1)
        .max(64),
    })
    .optional(),
});

/** Versioned presentation metadata supplied by the compiled game integration.
 * Defaults preserve legacy Owner text, including empty values and literal braces.
 * User overrides receive stricter template validation below. */
export const gatewayMessageDefinitionSchema = z
  .strictObject({
    version: z.literal(1),
    channels: z.array(channelSchema).min(1).max(16),
    states: z
      .array(
        z.strictObject({
          id: identifier,
          label,
          defaults: localizedValues,
          previewVariables: localizedValues,
        }),
      )
      .min(1)
      .max(32),
    variables: z.array(z.strictObject({ id: identifier, label })).max(32),
  })
  .superRefine((definition, context) => {
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: 'custom', path, message });
    for (const collection of ['channels', 'states', 'variables'] as const) {
      const ids = definition[collection].map((item) => item.id);
      if (new Set(ids).size !== ids.length) issue([collection], 'duplicate_identifier');
    }
    const channels = new Map(definition.channels.map((channel) => [channel.id, channel]));
    const variables = new Set(definition.variables.map((variable) => variable.id));
    definition.channels.forEach((channel, index) => {
      const tokens =
        channel.formatting?.tokens.map((token) =>
          channel.formatting?.caseInsensitive ? token.value.toLowerCase() : token.value,
        ) ?? [];
      if (new Set(tokens).size !== tokens.length)
        issue(['channels', index, 'formatting'], 'duplicate_token');
    });
    let totalText = 0;
    definition.states.forEach((state, index) => {
      for (const field of ['defaults', 'previewVariables'] as const) {
        const enKeys = Object.keys(state[field].en).sort();
        const itKeys = Object.keys(state[field].it).sort();
        if (JSON.stringify(enKeys) !== JSON.stringify(itKeys))
          issue(['states', index, field], 'locale_keys_differ');
        if (field === 'defaults' && enKeys.length === 0)
          issue(['states', index, field], 'missing_channel');
        for (const locale of ['en', 'it'] as const) {
          for (const [id, text] of Object.entries(state[field][locale])) {
            totalText += text.length;
            const path = ['states', index, field, locale, id];
            if (field === 'previewVariables') {
              if (!variables.has(id)) issue(path, 'unknown_variable');
            } else {
              const channel = channels.get(id);
              if (!channel) issue(path, 'unknown_channel');
              else {
                if (text.length > channel.maxLength) issue(path, 'message_too_long');
                if (!channel.multiline && /[\r\n]/.test(text))
                  issue(path, 'multiline_not_supported');
              }
            }
          }
        }
      }
    });
    if (totalText > 262144) issue(['states'], 'definition_too_large');
  });
export type GatewayMessageDefinition = z.infer<typeof gatewayMessageDefinitionSchema>;

/** Validate the common transport first, then the selected integration contract. */
export function validateGatewayMessageOverrides(
  definition: GatewayMessageDefinition,
  input: unknown,
): GatewayMessageOverrides {
  const contract = gatewayMessageDefinitionSchema.parse(definition);
  const overrides = gatewayMessageOverridesSchema.parse(input);
  const states = new Map(contract.states.map((state) => [state.id, state]));
  const channels = new Map(contract.channels.map((channel) => [channel.id, channel]));
  const variables = new Set(contract.variables.map((variable) => variable.id));
  const issues: z.core.$ZodIssue[] = [];
  for (const [stateId, messages] of Object.entries(overrides)) {
    const state = states.get(stateId);
    if (!state) {
      issues.push({ code: 'custom', path: [stateId], message: 'unknown_state' });
      continue;
    }
    for (const [channelId, text] of Object.entries(messages)) {
      const path = [stateId, channelId];
      const channel = channels.get(channelId);
      if (!channel || !Object.hasOwn(state.defaults.en, channelId)) {
        issues.push({ code: 'custom', path, message: 'unknown_channel' });
        continue;
      }
      if (text.length > channel.maxLength)
        issues.push({ code: 'custom', path, message: 'message_too_long' });
      if (!channel.multiline && /[\r\n]/.test(text))
        issues.push({ code: 'custom', path, message: 'multiline_not_supported' });
      const remaining = text.replace(/\{([a-z][a-z0-9_-]{0,63})\}/g, (token, id: string) =>
        variables.has(id) ? '' : token,
      );
      if (/[{}]/.test(remaining))
        issues.push({ code: 'custom', path, message: 'unknown_variable' });
    }
  }
  if (issues.length) throw new z.ZodError(issues);
  return overrides;
}
