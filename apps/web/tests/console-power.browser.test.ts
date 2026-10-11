import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { ConsoleRelayOptions, Resources } from '@nickhosting/pterodactyl-adapter';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 Console Stop and confirmed force-stop escalation', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let user: Page;
  let base: string;
  let providerState: Resources['current_state'] | undefined;
  const relays = new Set<ConsoleRelayOptions>();
  const powerEffects: string[] = [];
  const errors: string[] = [];

  beforeEach(async () => {
    providerState = undefined;
    relays.clear();
    powerEffects.length = 0;
    errors.length = 0;
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
    user = identities.user;
    user.on('pageerror', (error) => errors.push(error.message));
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
    const resources = provider.adapter.getResources;
    provider.adapter.getResources = async (id) => {
      const current = await resources(id);
      return { ...current, current_state: providerState ?? current.current_state };
    };
    const relay = provider.adapter.relayConsole;
    provider.adapter.relayConsole = async (id, input) => {
      relays.add(input);
      input.signal?.addEventListener('abort', () => relays.delete(input), { once: true });
      return relay(id, {
        ...input,
        onEvent: (event) =>
          input.onEvent(
            event.type === 'status' && providerState ? { ...event, data: providerState } : event,
          ),
      });
    };
    const power = provider.adapter.power;
    provider.adapter.power = async (id, action) => {
      powerEffects.push(action);
      return power(id, action);
    };
    base = `${fixture.origin}/servers/${provider.ids.serverId}/console`;
    await user.setViewportSize({ width: 1440, height: 1000 });
  });

  afterEach(async () => {
    provider?.dispose();
    relays.clear();
    await fixture?.close();
  });

  async function runtime(state: Resources['current_state']) {
    providerState = state;
    await fixture.database.db
      .updateTable('managed_servers')
      .set({ runtime_state: state })
      .where('id', '=', provider.ids.serverId)
      .execute();
    for (const relay of relays) relay.onEvent({ type: 'status', data: state });
  }

  async function stopping(jobId: string) {
    // Only this disposable schema advances the real accepted Stop to the point
    // where a provider process can hang. Backend suites exercise worker effects.
    const operation = await fixture.database.db
      .selectFrom('server_operations')
      .select('plan')
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow();
    const stopProcessStartedAt = await provider.management.lifecycle.observeProcessStart(
      provider.ids.serverId,
      fixture.database.db,
    );
    if (!stopProcessStartedAt) throw new Error('Fixture process epoch is missing');
    await fixture.database.db
      .updateTable('server_operations')
      .set({
        phase: 'power',
        effect_state: 'prepared',
        effect_started_at: new Date(),
        plan: JSON.stringify({ ...operation.plan, stopProcessStartedAt }),
      })
      .where('job_id', '=', jobId)
      .execute();
    await runtime('stopping');
  }

  async function clickOperation(label: string) {
    const response = user.waitForResponse(
      (value) =>
        value.request().method() === 'POST' &&
        value.url().endsWith(`/v1/servers/${provider.ids.serverId}/operations`),
    );
    await user.getByRole('button', { name: label, exact: true }).click();
    const accepted = await response;
    expect(accepted.status()).toBe(202);
    const result = (await accepted.json()) as { jobId: string; serverId: string };
    await browserExpect(user.locator(`a[href="/activity/${result.jobId}"]`).first()).toBeVisible();
    return result;
  }

  async function beginStop() {
    await user.goto(base);
    await browserExpect(user.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
    await browserExpect(user.getByRole('button', { name: 'Kill', exact: true })).toHaveCount(0);
    await clickOperation('Start');
    await provider.processPending();
    await user.reload();
    await browserExpect(user.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    const stop = await clickOperation('Stop');
    await stopping(stop.jobId);
    await browserExpect(
      user.locator('.console-actions').getByRole('button', { name: 'Kill', exact: true }),
    ).toBeEnabled();
    await browserExpect(user.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    return stop;
  }

  async function screenshot(name: string) {
    const result = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
    ).toEqual([]);
    expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
    await user.screenshot({
      path: resolve('docs/screenshots/m5', `console-power-${name}.png`),
      fullPage: true,
    });
  }

  it('disables offline Stop and confirms Kill on the same real Stop operation without dispatching provider power', async () => {
    const stop = await beginStop();
    await screenshot('stopping-desktop-en');
    const kill = user
      .locator('.console-actions')
      .getByRole('button', { name: 'Kill', exact: true });
    await kill.click();
    const dialog = user.getByRole('dialog', { name: 'Force stop server', exact: true });
    await browserExpect(dialog).toBeVisible();
    await browserExpect(dialog).toContainText(
      'Force stopping interrupts the process immediately. Unsaved data may be lost or corrupted.',
    );
    await screenshot('confirmation-desktop-en');
    await user.keyboard.press('Escape');
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(kill).toBeFocused();
    expect(powerEffects).toEqual(['start']);
    await kill.click();
    const response = user.waitForResponse(
      (value) =>
        value.request().method() === 'POST' &&
        value.url().endsWith(`/v1/servers/${provider.ids.serverId}/operations`),
    );
    await dialog.getByRole('button', { name: 'Kill', exact: true }).click();
    const accepted = await response;
    expect(accepted.status()).toBe(202);
    expect(accepted.request().postDataJSON()).toMatchObject({
      action: 'kill',
      confirm: true,
      operationId: stop.jobId,
      idempotencyKey: expect.any(String),
    });
    expect(await accepted.json()).toMatchObject({
      jobId: stop.jobId,
      serverId: provider.ids.serverId,
    });
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(kill).toBeDisabled();
    const job = await fixture.database.db
      .selectFrom('operation_jobs')
      .select('policy_snapshot')
      .where('id', '=', stop.jobId)
      .executeTakeFirstOrThrow();
    expect(job.policy_snapshot.stopEscalation).toMatchObject({
      state: 'requested',
      actorId: identities.userId,
    });
    expect(powerEffects).toEqual(['start']);
    expect(errors).toEqual([]);
  });

  it('localizes the warning and dismisses stale confirmations on offline status or a replaced Stop job', async () => {
    const stop = await beginStop();
    await journeyRequest(fixture, user, '/api/auth/update-user', { locale: 'it' });
    await user.setViewportSize({ width: 390, height: 844 });
    await user.reload();
    const kill = user
      .locator('.console-actions')
      .getByRole('button', { name: 'Kill', exact: true });
    await kill.click();
    const dialog = user.getByRole('dialog', { name: 'Arresto forzato del server', exact: true });
    await browserExpect(dialog).toContainText(
      'L’arresto forzato interrompe subito il processo. I dati non salvati potrebbero andare persi o danneggiarsi.',
    );
    await screenshot('confirmation-mobile-it');
    await runtime('offline');
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(user.getByRole('button', { name: 'Arresta', exact: true })).toBeDisabled();
    await browserExpect(kill).toHaveCount(0);
    await runtime('stopping');
    await kill.click();
    await browserExpect(dialog).toBeVisible();
    // Replace the active operation through a second actual Stop request, while
    // provider status remains stopping. No stream state change closes this modal.
    await fixture.database.db
      .updateTable('operation_jobs')
      .set({ state: 'succeeded', completed_at: new Date() })
      .where('id', '=', stop.jobId)
      .execute();
    await fixture.database.db
      .updateTable('managed_servers')
      .set({ active_operation_id: null })
      .where('id', '=', provider.ids.serverId)
      .execute();
    const next = await journeyRequest<{ jobId: string }>(
      fixture,
      user,
      `/v1/servers/${provider.ids.serverId}/operations`,
      { action: 'stop', idempotencyKey: randomUUID() },
    );
    await stopping(next.jobId);
    await browserExpect(dialog).not.toBeVisible({ timeout: 15000 });
    await browserExpect(kill).toBeEnabled();
    const previous = await fixture.database.db
      .selectFrom('operation_jobs')
      .select('policy_snapshot')
      .where('id', '=', stop.jobId)
      .executeTakeFirstOrThrow();
    const current = await fixture.database.db
      .selectFrom('operation_jobs')
      .select('policy_snapshot')
      .where('id', '=', next.jobId)
      .executeTakeFirstOrThrow();
    expect(previous.policy_snapshot.stopEscalation).toBeUndefined();
    expect(current.policy_snapshot.stopEscalation).toBeUndefined();
    expect(powerEffects).toEqual(['start']);
    expect(errors).toEqual([]);
  });

  it('omits viewer power controls and rejects a viewer force-stop request through the real API', async () => {
    const project = await journeyRequest<{ id: string }>(fixture, user, '/v1/projects', {
      name: 'Power viewers',
    });
    await journeyRequest(
      fixture,
      user,
      `/v1/platform/servers/${provider.ids.serverId}`,
      { projectId: project.id },
      'PATCH',
    );
    await journeyRequest(
      fixture,
      user,
      `/v1/projects/${project.id}/members`,
      { userId: identities.peerId, role: 'viewer' },
      'PUT',
    );
    const stop = await beginStop();
    const viewer = identities.peer;
    await viewer.goto(base);
    await browserExpect(
      viewer.getByRole('heading', { name: 'Survival', exact: true }),
    ).toBeVisible();
    for (const name of ['Start', 'Restart', 'Stop', 'Kill'])
      await browserExpect(viewer.getByRole('button', { name, exact: true })).toHaveCount(0);
    const denied = await viewer.request.post(
      `${fixture.origin}/v1/servers/${provider.ids.serverId}/operations`,
      {
        headers: { Origin: fixture.origin },
        data: {
          action: 'kill',
          confirm: true,
          operationId: stop.jobId,
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(denied.status()).toBe(403);
    const job = await fixture.database.db
      .selectFrom('operation_jobs')
      .select('policy_snapshot')
      .where('id', '=', stop.jobId)
      .executeTakeFirstOrThrow();
    expect(job.policy_snapshot.stopEscalation).toBeUndefined();
    expect(powerEffects).toEqual(['start']);
    expect(errors).toEqual([]);
  });
});
