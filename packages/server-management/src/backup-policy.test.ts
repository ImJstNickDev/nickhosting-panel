import { describe, expect, it } from 'vitest';
import {
  backupOptionsSchema,
  backupRetentionSchema,
  canResumeBackup,
  resolveBackupMode,
} from './backup-policy.js';

describe('backup policy', () => {
  it('defaults conservatively and cannot weaken required offline policy', () => {
    expect(backupOptionsSchema.parse({})).toEqual({ isLocked: false, mode: 'auto' });
    expect(resolveBackupMode('auto')).toBe('offline');
    expect(() => resolveBackupMode('live', { offline: 'required' })).toThrow();
    expect(resolveBackupMode('auto', { offline: 'recommended' })).toBe('offline');
    expect(resolveBackupMode('live', { offline: 'recommended' })).toBe('live');
    expect(resolveBackupMode('auto', { offline: 'none' })).toBe('live');
    expect(backupRetentionSchema.parse({})).toEqual({ enabled: false, keepLast: 7 });
  });
  it('resumes only original running intent with unchanged consent', () => {
    const previous = { wasRunning: true, intent: 'auto_wake_enabled', generation: 'a' };
    expect(canResumeBackup(previous, { intent: 'auto_wake_enabled', generation: 'a' })).toBe(true);
    expect(
      canResumeBackup(previous, {
        intent: 'auto_wake_enabled',
        generation: 'a',
        automaticStartsPaused: true,
      }),
    ).toBe(false);
    expect(canResumeBackup(previous, { intent: 'manually_stopped', generation: 'a' })).toBe(false);
    expect(canResumeBackup(previous, { intent: 'auto_wake_enabled', generation: 'b' })).toBe(false);
    expect(
      canResumeBackup(
        { ...previous, wasRunning: false },
        { intent: 'auto_wake_enabled', generation: 'a' },
      ),
    ).toBe(false);
  });
});
