import { expect as browserExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { prepareJourneyIdentities } from './journey-fixture.js';

describe('Home bootstraps and loads allowance independently', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  beforeAll(async () => {
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
  });
  afterAll(async () => fixture?.close());

  it('renders the page while quota is pending and retries a failed read to display zero', async () => {
    const page = await identities.user.context().newPage();
    const first = Promise.withResolvers<void>();
    let retried = false,
      reads = 0,
      setupReads = 0,
      newServerLookups = 0;
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (path === '/v1/setup') setupReads++;
      if (path === '/v1/platform/servers/new') newServerLookups++;
    });
    await page.route('**/v1/platform/quotas', async (route) => {
      reads++;
      if (retried) return route.continue();
      await first.promise;
      return route.fulfill({
        status: 503,
        json: { error: { code: 'integration_unavailable', messageKey: 'web.errors.request' } },
      });
    });
    try {
      await page.goto(fixture.origin);
      const allowance = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Allowance', exact: true }) });
      await browserExpect(allowance.getByRole('status')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('link', { name: 'Create server' }).click({ trial: true });
      expect(setupReads).toBe(0);
      first.resolve();
      await browserExpect(allowance.getByRole('alert')).toBeVisible();
      retried = true;
      const readsBeforeRetry = reads;
      await allowance.getByRole('button', { name: 'Try again' }).click();
      await browserExpect(
        allowance.locator('.home-quota-card').last().locator('dd').first(),
      ).toHaveText('0');
      expect(reads).toBe(readsBeforeRetry + 1);
      await page.getByRole('link', { name: 'Create server' }).click();
      await browserExpect(page).toHaveURL(/\/servers\/new$/);
      await browserExpect(page.locator('h1')).toBeVisible();
      expect(newServerLookups).toBe(0);
      expect(reads).toBe(readsBeforeRetry + 1);
    } finally {
      first.resolve();
      await page.close();
    }
  });

  it('discards the old quota when the cookie switches to a different account', async () => {
    const page = await fixture.page();
    const release = Promise.withResolvers<void>();
    try {
      await page.context().addCookies(await identities.user.context().cookies());
      await page.clock.install();
      await page.goto(fixture.origin);
      await browserExpect(page.locator('.home-quota-grid')).toBeVisible({ timeout: 20_000 });
      await page.context().addCookies(await identities.owner.context().cookies());
      await page.route('**/v1/platform/quotas', async (route) => {
        await release.promise;
        await route.continue().catch(() => {});
      });
      await page.clock.fastForward(30_001);
      await browserExpect(page.getByRole('link', { name: 'Admin', exact: true })).toBeVisible();
      const allowance = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: 'Allowance', exact: true }) });
      await browserExpect(allowance.getByRole('status')).toBeVisible();
      await browserExpect(allowance.locator('.home-quota-grid')).toHaveCount(0);
      release.resolve();
      await browserExpect(allowance.locator('.home-quota-grid')).toBeVisible();
    } finally {
      release.resolve();
      await page.close();
    }
  });

  it('uses public setup for anonymous first-run visits and for legacy session responses', async () => {
    const anonymous = await fixture.page();
    const legacy = await identities.owner.context().newPage();
    try {
      await anonymous.route('**/v1/setup', (route) =>
        route.fulfill({ json: { ownerClaimed: false, completed: false } }),
      );
      await anonymous.goto(fixture.origin);
      await browserExpect(anonymous).toHaveURL(/\/setup$/);
      await browserExpect(anonymous.getByLabel('Setup token')).toBeVisible();

      await legacy.route('**/v1/web/session', async (route) => {
        const result = await route.fetch();
        const { setup, ...session } = await result.json();
        expect(setup).toEqual({ ownerClaimed: true, completed: true });
        return route.fulfill({ response: result, json: session });
      });
      await legacy.route('**/v1/setup', (route) =>
        route.fulfill({ json: { ownerClaimed: true, completed: false } }),
      );
      await legacy.goto(fixture.origin);
      await browserExpect(legacy).toHaveURL(/\/setup$/);
    } finally {
      await anonymous.close();
      await legacy.close();
    }
  });

  it('offers a retry when the initial setup read fails', async () => {
    const page = await fixture.page();
    let available = false;
    await page.route('**/v1/setup', (route) =>
      available
        ? route.fulfill({ json: { ownerClaimed: false, completed: false } })
        : route.fulfill({ status: 503, json: { error: { code: 'integration_unavailable' } } }),
    );
    try {
      await page.goto(`${fixture.origin}/setup`);
      await browserExpect(page.getByRole('alert')).toBeVisible({ timeout: 20_000 });
      available = true;
      await page.getByRole('button', { name: 'Try again' }).click();
      await browserExpect(page.getByLabel('Setup token')).toBeVisible();
    } finally {
      await page.close();
    }
  });

  it('redirects an incomplete Owner and drops a previously loaded Home when its session expires', async () => {
    const owner = await identities.owner.context().newPage();
    const user = await identities.user.context().newPage();
    try {
      await owner.route('**/v1/web/session', async (route) => {
        const result = await route.fetch();
        return route.fulfill({
          response: result,
          json: { ...(await result.json()), setup: { ownerClaimed: true, completed: false } },
        });
      });
      await owner.goto(fixture.origin);
      await browserExpect(owner).toHaveURL(/\/setup$/);

      await user.clock.install();
      await user.goto(fixture.origin);
      await browserExpect(user.locator('.home-quota-grid')).toBeVisible({ timeout: 20_000 });
      await user.route('**/v1/web/session', (route) =>
        route.fulfill({ status: 401, json: { error: { code: 'unauthenticated' } } }),
      );
      await user.clock.fastForward(30_001);
      await browserExpect(user).toHaveURL(/\/login$/);
      await browserExpect(user.locator('.home-quota-grid')).toHaveCount(0);
    } finally {
      await owner.close();
      await user.close();
    }
  });
  it('keeps Owner navigation usable when Health is unavailable', async () => {
    const page = await identities.owner.context().newPage();
    let reads = 0;
    await page.route('**/v1/owner/health', async (route) => {
      reads++;
      await route.fulfill({ status: 503, json: { error: { code: 'integration_unavailable' } } });
    });
    try {
      await page.goto(`${fixture.origin}/owner`);
      await browserExpect(page.getByRole('alert')).toBeVisible();
      const readsBeforeRetry = reads;
      await page.getByRole('button', { name: 'Try again' }).click();
      await browserExpect.poll(() => reads).toBe(readsBeforeRetry + 1);
      await page.locator('a.brand').click();
      await browserExpect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
      await browserExpect(page.locator('.home-quota-card').first()).toBeVisible();
      expect(reads).toBe(readsBeforeRetry + 1);
    } finally {
      await page.close();
    }
  });
});
