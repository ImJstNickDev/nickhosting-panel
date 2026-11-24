import { z } from 'zod';
import { openworldRoleKey, openworldZoneName } from './rules.js';

const account = z.uuid().transform((value) => value.toLowerCase());
export const moderationRoleKey = openworldRoleKey;
export const moderationPlayerName = z.string().regex(/^[\p{L}\p{N}_-]{1,64}$/u);
export const moderationReason = z
  .string()
  .trim()
  .max(120)
  .regex(/^[\p{L}\p{M}\p{N} .,!?'’():_-]*$/u);
export const moderationChange = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ban'),
    account,
    name: moderationPlayerName,
    reason: moderationReason,
  }),
  z.strictObject({ kind: z.literal('unban'), account }),
  z.strictObject({
    kind: z.literal('role'),
    account,
    name: moderationPlayerName,
    role: moderationRoleKey,
    previous: moderationRoleKey,
  }),
  z.strictObject({
    kind: z.literal('member'),
    account,
    name: moderationPlayerName,
    zoneId: z.number().int().positive().safe(),
    zone: openworldZoneName,
    member: z.boolean(),
  }),
]);
export const moderationRequest = z.strictObject({
  requestId: z.uuid(),
  processRef: z.string().regex(/^[a-f0-9]{64}$/),
  action: moderationChange,
});
export type ModerationRequest = z.output<typeof moderationRequest>;
export type ModerationChange = ModerationRequest['action'];
export type BannedPlayer = { name: string; uuid: string; reason: string | null };
export type BannedPlayersView = {
  processRef: string;
  mutable: boolean;
  onlineBan: boolean;
  bans: BannedPlayer[];
};
export type PlayerRoleView = {
  processRef: string;
  mutable: boolean;
  current: string;
  roles: { key: string; name: string }[];
};
export type PlayerMembershipView = {
  processRef: string;
  mutable: boolean;
  zones: { id: number; name: string; world: string; member: boolean }[];
};
