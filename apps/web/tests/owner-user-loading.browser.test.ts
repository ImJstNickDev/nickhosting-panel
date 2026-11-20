import { expect as browserExpect, type Page, type Route } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness, browserPassword } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';

describe('Owner user overview loads independent data', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let owner: Page;

  beforeAll(async () => {
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
    owner = identities.owner;
    // Compile the development bundle before holding API responses for cold route entries.
    await owner.goto(`${fixture.origin}/owner/users`);
    await browserExpect(owner.getByRole('link', { name: 'Alex', exact: true })).toBeVisible({
      timeout: 20_000,
    });
  });
  afterAll(async () => fixture?.close());

  it('keeps the profile and assistance usable when quota and recovery status fail, and retries each separately', async () => {
    const quota = `**/v1/platform/owner/users/${identities.userId}/quota`;
    const recovery = `**/v1/owner/users/${identities.userId}/recovery-link`;
    const gate = Promise.withResolvers<void>();
    const started = new Set<string>();
    let unavailable = true;
    const fail = async (route: Route) => {
      if (!unavailable) return route.continue();
      started.add(route.request().url());
      await gate.promise;
      await route.fulfill({
        status: 503,
        json: { error: { code: 'service_unavailable', messageKey: 'web.errors.request' } },
      });
    };
    await owner.route(quota, fail);
    await owner.route(recovery, fail);
    try {
      await owner.goto(`${fixture.origin}/owner/users/${identities.userId}`);
      await browserExpect(owner.getByRole('heading', { name: 'Alex', exact: true })).toBeVisible();
      await browserExpect.poll(() => started.size).toBe(2);
      await owner.getByRole('button', { name: 'Assisted session' }).click();
      await browserExpect(owner.getByRole('dialog').getByLabel('Reason')).toBeVisible();
      await owner.keyboard.press('Escape');
      gate.resolve();
      const section = owner
        .locator('section')
        .filter({ has: owner.getByRole('heading', { name: 'Allowance' }) });
      await browserExpect(section.getByRole('alert')).toBeVisible();
      unavailable = false;
      await section.getByRole('button', { name: 'Try again' }).click();
      await browserExpect(section.getByText('Set individual limits')).toBeVisible();
      await owner.getByRole('button', { name: 'Try again' }).click();
      await browserExpect(
        owner.getByRole('button', { name: 'Generate recovery link' }),
      ).toBeVisible();
    } finally {
      gate.resolve();
      await owner.unroute(quota, fail);
      await owner.unroute(recovery, fail);
    }
  });

  it('uses the selected list row while checking the profile and defers changes until confirmation', async () => {
    await owner.goto(`${fixture.origin}/owner/users`);
    const direct = `/v1/platform/owner/users/${identities.peerId}/profile`;
    const gate = Promise.withResolvers<void>();
    await owner.route(`**${direct}`, async (route) => {
      await gate.promise;
      await route.continue();
    });
    try {
      await owner.getByRole('link', { name: 'Taylor', exact: true }).click();
      await browserExpect(
        owner.getByRole('heading', { name: 'Taylor', exact: true }),
      ).toBeVisible();
      await owner.getByRole('button', { name: 'Assisted session' }).click();
      const assistance = owner.getByRole('dialog', { name: 'Assisted session' });
      await assistance.getByLabel('Reason').fill('Check pending account profile');
      await browserExpect(assistance.getByRole('button', { name: 'Next' })).toBeDisabled();
      await owner.keyboard.press('Escape');
      await browserExpect(owner.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
      await browserExpect(owner.getByText('Set individual limits')).toHaveCount(0);
      await owner.getByRole('link', { name: 'History', exact: true }).click();
      await browserExpect(
        owner.getByRole('heading', { name: 'History', exact: true }),
      ).toBeVisible();
      gate.resolve();
      await browserExpect(owner.getByRole('button', { name: 'Assisted session' })).toBeVisible();
      await owner.locator('.owner-user-back').click();
      await owner.getByRole('link', { name: 'Alex', exact: true }).click();
      await browserExpect(owner.getByRole('heading', { name: 'Alex', exact: true })).toBeVisible();
      await browserExpect(owner.getByRole('heading', { name: 'Taylor', exact: true })).toHaveCount(
        0,
      );
    } finally {
      gate.resolve();
    }
  });

  it('revalidates an override expiring during delivery even for a finite budget with no servers, and waits for retry after a failure', async () => {
    const page = await owner.context().newPage();
    const path = `/v1/platform/owner/users/${identities.userId}/quota`;
    const quota = await (await page.request.get(`${fixture.origin}${path}`)).json();
    expect(quota.committed.serverCount).toBe(0);
    const gate = Promise.withResolvers<void>();
    let mode: 'initial' | 'error' | 'recovered' = 'initial';
    let started = false,
      failed = 0;
    await page.route(`**${path}`, async (route) => {
      if (mode === 'recovered') return route.continue();
      if (mode === 'error') {
        failed++;
        return route.fulfill({
          status: 503,
          json: { error: { code: 'service_unavailable', messageKey: 'web.errors.request' } },
        });
      }
      started = true;
      const observed = Date.now();
      await gate.promise;
      await route.fulfill({
        json: {
          ...quota,
          limits: { ...quota.limits, storageMiB: 4096 },
          observedAt: new Date(observed).toISOString(),
          override: { active: true, expiresAt: new Date(observed + 500).toISOString() },
        },
      });
    });
    try {
      await page.clock.install();
      await page.goto(`${fixture.origin}/owner/users/${identities.userId}`);
      await browserExpect(page.getByRole('heading', { name: 'Alex', exact: true })).toBeVisible();
      await browserExpect.poll(() => started).toBe(true);
      await page.clock.fastForward(2000);
      mode = 'error';
      gate.resolve();
      const section = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Allowance' }) });
      await browserExpect(
        section.getByText('Individual limits active', { exact: false }),
      ).toBeVisible();
      await page.clock.fastForward(1100);
      await browserExpect(section.getByRole('alert')).toBeVisible();
      await page.clock.fastForward(61_000);
      expect(failed).toBe(1);
      mode = 'recovered';
      await section.getByRole('button', { name: 'Try again' }).click();
      await browserExpect(section.getByText('Set individual limits')).toBeVisible();
      await browserExpect(
        section.getByText('Individual limits active', { exact: false }),
      ).toHaveCount(0);
    } finally {
      gate.resolve();
      await page.close();
    }
  });

  it('checks revocation while a link is visible, expires it locally at rest, and skips quota on a direct history visit', async () => {
    const id = identities.userId;
    const recovery = `/v1/owner/users/${id}/recovery-link`;
    const reads: string[] = [];
    const createLink = async (expiresAt: string) => {
      const grant = await journeyRequest<{ token: string }>(
        fixture,
        owner,
        '/v1/identity/step-up',
        { purpose: 'recovery-link', subjectUserId: id, password: browserPassword },
      );
      await journeyRequest(fixture, owner, recovery, {
        mode: 'create',
        stepUpToken: grant.token,
        expiresAt,
      });
    };
    await createLink(new Date(Date.now() + 3_600_000).toISOString());
    await owner.clock.install({ time: new Date() });
    owner.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (
        request.method() === 'GET' &&
        (path.startsWith(`/v1/platform/owner/users/${id}/`) || path === recovery)
      )
        reads.push(path);
    });
    try {
      await owner.goto(`${fixture.origin}/owner/users/${id}?view=history`);
      await browserExpect(owner.getByRole('button', { name: 'Show recovery link' })).toBeVisible();
      const atRest = [...reads];
      await owner.clock.fastForward(61_000);
      expect(reads).toEqual(atRest);
      expect([...new Set(reads)].sort()).toEqual(
        [recovery, `/v1/platform/owner/users/${id}/profile`].sort(),
      );
      await owner.getByRole('button', { name: 'Show recovery link' }).click();
      const auth = owner.getByRole('dialog', { name: 'Verify your identity' });
      await auth.getByLabel('Current password').fill(browserPassword);
      await auth.getByRole('button', { name: 'Show recovery link' }).click();
      const dialog = owner.getByRole('dialog', { name: 'Recovery link', exact: true });
      await browserExpect(dialog.getByLabel('Recovery link')).toBeVisible();
      // A different browser uses or invalidates this test user's credential.
      await fixture.database.pool.query(
        'DELETE FROM verification WHERE owner_recovery_account_id IN (SELECT id FROM account WHERE "userId"=$1)',
        [id],
      );
      await owner.clock.fastForward(15_010);
      await browserExpect(dialog).toHaveCount(0);
      await browserExpect(
        owner.getByRole('button', { name: 'Generate recovery link' }),
      ).toBeVisible();
      await owner.clock.setSystemTime(new Date());
      await createLink(new Date(Date.now() + 5000).toISOString());
      await owner.reload();
      await browserExpect(owner.getByRole('button', { name: 'Show recovery link' })).toBeVisible();
      const before = reads.length;
      await owner.clock.fastForward(6000);
      await browserExpect(
        owner.getByRole('button', { name: 'Generate recovery link' }),
      ).toBeVisible();
      expect(reads.length).toBe(before);
    } finally {
      await owner.clock.setSystemTime(new Date());
      await owner.clock.resume();
    }
  });
});
