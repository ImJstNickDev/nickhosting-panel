import { DomainError } from '@nickhosting/core';
import type { GameBackupPolicy } from '@nickhosting/game-sdk';
import { backupIgnoredSchema } from '@nickhosting/pterodactyl-adapter';
import { z } from 'zod';

export const backupOptionsSchema = z.strictObject({
  name: z.string().trim().min(1).max(191).optional(),
  ignored: backupIgnoredSchema.optional(),
  isLocked: z.boolean().default(false),
  mode: z.enum(['auto', 'offline', 'live']).default('auto'),
});
export type BackupOptions = z.infer<typeof backupOptionsSchema>;
export const backupRetentionSchema = z.strictObject({
  enabled: z.boolean().default(false),
  keepLast: z.number().int().min(1).max(100).default(7),
});

/** Unknown integrations remain conservative. A request cannot weaken required policy. */
export function resolveBackupMode(
  mode: BackupOptions['mode'],
  policy: GameBackupPolicy = { offline: 'required' },
): 'offline' | 'live' {
  if (mode === 'live' && policy.offline === 'required') throw new DomainError('validation_failed');
  return mode === 'auto' ? (policy.offline === 'none' ? 'live' : 'offline') : mode;
}

/** Completion and automatic resumption are separate outcomes. A changed consent
 * generation suppresses resumption even if intent was later re-enabled. */
export function canResumeBackup(
  previous: { intent: string; generation: string | null; wasRunning: boolean },
  current: { intent: string; generation: string | null; automaticStartsPaused?: boolean },
) {
  return (
    previous.wasRunning &&
    !current.automaticStartsPaused &&
    !['manually_stopped', 'maintenance'].includes(current.intent) &&
    previous.intent === current.intent &&
    previous.generation === current.generation
  );
}
