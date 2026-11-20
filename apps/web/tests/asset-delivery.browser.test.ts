import { expect as browserExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { prepareJourneyIdentities } from './journey-fixture.js';

describe('initial page assets and navigation intent', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  beforeAll(async () => {
    fixture = await browserHarness();
  });
  afterAll(async () => fixture?.close());

  it('loads just the requested locale, keeps the login draft on a failed switch and retries', async () => {
    const page = await fixture.page('it', true);
    const catalogs: string[] = [];
    await page.route('**/messages/*.json', async (route) => {
      const name = new URL(route.request().url()).pathname.split('/').at(-1)!;
      catalogs.push(name);
      if (name === 'en.json' && catalogs.filter((item) => item === name).length === 1) {
        await route.fulfill({ status: 503, body: '' });
      } else await route.continue();
    });
    try {
      await page.goto(fixture.origin + '/login');
      await browserExpect(page.getByRole('heading', { name: 'Accedi' })).toBeVisible();
      expect(catalogs).toEqual(['it.json']);
      const email = page.locator('input[type="email"]');
      await email.fill('draft@example.invalid');
      await page.getByRole('combobox').selectOption('en');
      await browserExpect(page.getByRole('alert')).toBeVisible();
      await browserExpect(email).toHaveValue('draft@example.invalid');
      await page.getByRole('button', { name: 'Try again' }).click();
      await browserExpect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await browserExpect(email).toHaveValue('draft@example.invalid');
      await page.getByRole('combobox').selectOption('it');
      await browserExpect(page.getByRole('heading', { name: 'Accedi' })).toBeVisible();
      expect(catalogs).toEqual(['it.json', 'en.json', 'en.json']);
    } finally {
      await page.context().close();
    }
  });

  it('recovers after an initial catalog request stalls', async () => {
    const page = await fixture.page();
    const release = Promise.withResolvers<void>();
    let stalled = true;
    await page.route('**/messages/en.json', async (route) => {
      if (!stalled) return route.continue();
      await release.promise;
      await route.abort().catch(() => {});
    });
    try {
      await page.goto(fixture.origin + '/login', { waitUntil: 'domcontentloaded' });
      await browserExpect(page.getByRole('alert')).toBeVisible({ timeout: 25_000 });
      stalled = false;
      release.resolve();
      await page.getByRole('button', { name: 'Try again' }).click();
      await browserExpect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    } finally {
      release.resolve();
      await page.context().close();
    }
  });

  it('prefetches a focused route without requesting its data until navigation', async () => {
    const identities = await prepareJourneyIdentities(fixture);
    const page = identities.user;
    let scripts = 0,
      activityReads = 0;
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/features/activity.tsx')) scripts++;
      if (
        path === '/v1/platform/activity' &&
        new URL(request.url()).searchParams.get('limit') !== '5'
      )
        activityReads++;
    });
    await page.goto(fixture.origin + '/');
    await browserExpect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
    expect(scripts).toBe(0);
    const activity = page.getByRole('link', { name: 'Activity', exact: true }).first();
    await activity.focus();
    await browserExpect.poll(() => scripts).toBe(1);
    expect(activityReads).toBe(0);
    await activity.press('Enter');
    await browserExpect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
    await browserExpect.poll(() => activityReads).toBeGreaterThan(0);
    expect(scripts).toBe(1);
  });
});
