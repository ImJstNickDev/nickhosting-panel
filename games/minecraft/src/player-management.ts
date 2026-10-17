import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { minecraftUuid, parseMinecraftProperties } from './management.js';

const name = z.string().regex(/^[A-Za-z0-9_]{3,16}$/);
const player = z.object({
  name,
  uuid: z
    .string()
    .regex(/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/)
    .transform(minecraftUuid),
});
const expectedUuid = player.shape.uuid.optional();
const operator = player.extend({
  level: z.number().int().min(1).max(4),
  bypassesPlayerLimit: z.boolean().default(false),
});
const banned = player.extend({
  reason: z.string().max(4096).optional(),
  expires: z.string().max(128).optional(),
});
const reason = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
  .transform((value) => value.trim())
  .refine((value) => value.length > 0);
export const minecraftPlayerActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('op'), name, expectedUuid }).strict(),
  z.object({ action: z.literal('deop'), name, expectedUuid }).strict(),
  z.object({ action: z.literal('whitelist-add'), name, expectedUuid }).strict(),
  z.object({ action: z.literal('whitelist-remove'), name, expectedUuid }).strict(),
  z.object({ action: z.literal('whitelist-on') }).strict(),
  z.object({ action: z.literal('whitelist-off') }).strict(),
  z.object({ action: z.literal('kick'), name, expectedUuid, reason: reason.optional() }).strict(),
  z.object({ action: z.literal('ban'), name, expectedUuid, reason: reason.optional() }).strict(),
  z.object({ action: z.literal('pardon'), name, expectedUuid }).strict(),
]);
export type MinecraftPlayerAction = z.infer<typeof minecraftPlayerActionSchema>;
export function minecraftPlayerCommand(input: MinecraftPlayerAction): string {
  const value = minecraftPlayerActionSchema.parse(input);
  const command = value.action.replace('whitelist-', 'whitelist ');
  return `${command}${'name' in value ? ` ${value.name}` : ''}${'reason' in value && value.reason ? ` ${value.reason}` : ''}`;
}
function list<T>(schema: z.ZodType<T>, source: string): T[] {
  try {
    if (Buffer.byteLength(source) > 1048576) throw new Error();
    const result = z.array(schema).max(10000).parse(JSON.parse(source));
    const ids = result.map((entry) => (entry as { uuid: string }).uuid);
    if (new Set(ids).size !== ids.length) throw new Error();
    return result;
  } catch {
    throw new DomainError('integration_unavailable');
  }
}
export function parseMinecraftPlayerFiles(files: {
  operators: string;
  whitelist: string;
  banned: string;
  properties: string;
}) {
  if (Buffer.byteLength(files.properties) > 1048576)
    throw new DomainError('integration_unavailable');
  const properties = parseMinecraftProperties(files.properties);
  if (properties['white-list'] !== 'true' && properties['white-list'] !== 'false')
    throw new DomainError('integration_unavailable');
  if (
    properties['enforce-whitelist'] !== undefined &&
    properties['enforce-whitelist'] !== 'true' &&
    properties['enforce-whitelist'] !== 'false'
  )
    throw new DomainError('integration_unavailable');
  return {
    operators: list(operator, files.operators),
    whitelist: list(player, files.whitelist),
    banned: list(banned, files.banned),
    whitelistEnabled: properties['white-list'] === 'true',
    enforceWhitelist: properties['enforce-whitelist'] === 'true',
  };
}
/** Accept only vanilla server-thread output, never chat, plugin-prefixed lines or history.
 * `commands.list.players` is the vanilla English translation receipt. Unknown formats
 * deliberately report unavailable instead of guessing from a status sample. */
export function parseMinecraftOnlinePlayers(line: string): { name: string }[] | undefined {
  if (Buffer.byteLength(line) > 32768 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line)) return;
  const match =
    /^\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: There are (\d{1,5}) of a max of (\d{1,5}) players online: ?(.*)$/.exec(
      line,
    );
  if (!match) return;
  const count = Number(match[1]);
  if (count > 1000 || count > Number(match[2])) return;
  const names = match[3] ? match[3].split(', ') : [];
  if (
    names.length !== count ||
    names.some((entry) => !name.safeParse(entry).success) ||
    new Set(names.map((entry) => entry.toLowerCase())).size !== names.length
  )
    return;
  return names.map((name) => ({ name }));
}
