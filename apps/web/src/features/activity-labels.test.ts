import { describe, expect, it } from 'vitest';
import { activityStatus } from './activity-labels.js';

describe('authoritative installation activity status', () => {
  it.each([
    ['uncertain', 'uncertain'],
    ['completed', 'succeeded'],
    ['failed', 'failed'],
  ])('shows %s when a synthetic job still says running', (state, value) => {
    expect(
      activityStatus({
        state: 'running',
        outcome: 'running',
        phase: 'queued',
        effectState: 'none',
        provisioning: { stage: 'installing', state },
      }),
    ).toEqual({ value, labelKey: `activity.state.${value}` });
  });
  it('uses the workflow phase while active and preserves Owner-resolved history', () => {
    const item = {
      state: 'running' as const,
      outcome: 'running' as const,
      phase: 'queued',
      effectState: 'none',
      provisioning: {
        stage: 'installing',
        state: 'active',
        workflow: {
          titleKey: 'games.minecraft.sections.modpacks',
          statusKey: 'games.minecraft.modpacks.changingRuntime',
          phaseKey: 'games.minecraft.modpacks.changingRuntime',
          review: { sectionId: 'modpacks', labelKey: 'games.minecraft.modpacks.review' },
        },
      },
    };
    expect(activityStatus(item)).toEqual({
      value: 'running',
      labelKey: item.provisioning.workflow.statusKey,
    });
    expect(activityStatus({ ...item, phase: 'owner_resolved_failed' })).toEqual({
      value: 'failed',
      labelKey: 'activity.state.failed',
    });
  });
});
