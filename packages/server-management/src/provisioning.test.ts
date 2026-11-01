import { describe, expect, it } from 'vitest';
import type { ModpackProvisioning } from './modpack-provisioning.js';
import { provisioningPresentation } from './provisioning.js';

const row = {
  job_id: 'operation',
  action: 'provision',
  phase: 'installation',
  plan: { autoStart: true, waitReason: 'installation_terminal_unproven' } as Record<
    string,
    unknown
  >,
  effect_state: 'confirmed',
  state: 'queued',
  error_code: 'operation_uncertain',
  created_at: new Date('2026-01-01T10:00:00Z'),
  updated_at: new Date('2026-01-01T10:01:00Z'),
  completed_at: null as Date | null,
};
describe('durable installation presentation', () => {
  it('projects runtime uncertainty from the modpack row instead of its synthetic running job', () => {
    const source: ModpackProvisioning = {
      id: row.job_id,
      server_id: 'server',
      state: 'uncertain',
      phase: 'runtime',
      error: 'operation_uncertain',
      updated_at: new Date('2026-01-01T10:02:00Z'),
    };
    const synthetic = {
      ...row,
      state: 'running',
      phase: 'queued',
      effect_state: 'none',
      plan: { modpackOperationId: row.job_id },
    };
    expect(provisioningPresentation(synthetic, undefined, source)).toMatchObject({
      state: 'uncertain',
      stage: 'installing',
      errorCode: 'operation_uncertain',
      updatedAt: source.updated_at.toISOString(),
      completedAt: null,
      stages: [],
      workflow: {
        statusKey: 'games.minecraft.modpacks.uncertain',
        phaseKey: 'games.minecraft.modpacks.changingRuntime',
        review: { sectionId: 'modpacks' },
      },
    });
    expect(
      provisioningPresentation(synthetic, undefined, { ...source, state: 'applying' }),
    ).toMatchObject({
      state: 'active',
      errorCode: null,
      workflow: { statusKey: 'games.minecraft.modpacks.changingRuntime' },
    });
    expect(
      provisioningPresentation(synthetic, undefined, {
        ...source,
        state: 'applied',
        phase: 'complete',
      }),
    ).toMatchObject({
      state: 'completed',
      stage: 'ready',
      completedAt: source.updated_at.toISOString(),
    });
    expect(
      provisioningPresentation(synthetic, undefined, {
        ...source,
        state: 'applied',
        phase: 'restoring',
      }),
    ).toMatchObject({
      state: 'active',
      stage: 'starting',
      completedAt: null,
    });
    expect(provisioningPresentation(synthetic)).toMatchObject({ state: 'uncertain', stages: [] });
    expect(provisioningPresentation(row, undefined, source)).toMatchObject({
      state: 'active',
      stage: 'installing',
      workflow: undefined,
    });
  });
  it('shows installing while the delivery queue waits, without an invented error or percentage', () => {
    expect(provisioningPresentation(row)).toMatchObject({
      stage: 'installing',
      state: 'active',
      errorCode: null,
    });
    expect(provisioningPresentation(row)).not.toHaveProperty('progress');
  });
  it('separates installed without capacity from installation failure', () => {
    const result = provisioningPresentation({
      ...row,
      state: 'succeeded',
      phase: 'complete',
      plan: { autoStart: true, installConfirmed: true, initialStartDenied: true },
    });
    expect(result).toMatchObject({
      stage: 'starting',
      state: 'start-denied',
      errorCode: 'resources_unavailable',
    });
    expect(result.stages.find((stage) => stage.id === 'installing')?.state).toBe('completed');
  });
  it('preserves uncertain external effects and failed phase without exposing arbitrary plan fields', () => {
    expect(
      provisioningPresentation({
        ...row,
        effect_state: 'uncertain',
        plan: { waitReason: 'provision_outcome_unknown' },
      }).state,
    ).toBe('uncertain');
    expect(
      provisioningPresentation({
        ...row,
        state: 'failed',
        plan: { provisioning: { stage: 'configuring' }, secret: 'private' },
      }),
    ).toMatchObject({ stage: 'configuring', state: 'failed' });
    expect(
      JSON.stringify(provisioningPresentation({ ...row, plan: { secret: 'private' } })),
    ).not.toContain('private');
  });
  it('never claims a first start occurred when disabled or reinstalling', () => {
    for (const action of ['provision', 'reinstall']) {
      const result = provisioningPresentation({
        ...row,
        action,
        state: 'succeeded',
        plan: { autoStart: false },
      });
      expect(result.state).toBe('completed');
      expect(result.stages.some((stage) => stage.id === 'starting')).toBe(false);
    }
  });
});
