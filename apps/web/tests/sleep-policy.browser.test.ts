import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('initial sleep policy configuration', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let base: string;
  beforeAll(async () => {
    harness = await browserHarness();
    const identities = await prepareJourneyIdentities(harness);
    user = identities.user;
    // This creates only a fixture-backed managed server; no Gateway process/listener.
    harness.env.NH_GATEWAY_ENABLED = 'true';
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    base = `${harness.origin}/servers/${provider.ids.serverId}`;
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  it('explicitly configures initial sleep policy without granting automatic starts', async () => {
    await user.goto(`${base}/automation`);
    const configure = user.getByRole('button', { name: 'Configure sleep and wake', exact: true });
    await browserExpect(configure).toBeVisible();
    expect(
      await harness.database.db
        .selectFrom('gateway_server_states')
        .select('server_id')
        .where('server_id', '=', provider.ids.serverId)
        .execute(),
    ).toEqual([]);
    await harness.screenshot(user, 'automation-initial-desktop-en');
    await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'it' });
    await user.setViewportSize({ width: 390, height: 844 });
    await user.goto(`${base}/automation`);
    await browserExpect(
      user.getByRole('button', { name: 'Configura sospensione e riattivazione', exact: true }),
    ).toBeVisible();
    expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await harness.screenshot(user, 'automation-initial-mobile-it');
    await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'en' });
    await user.setViewportSize({ width: 1440, height: 1000 });
    await user.goto(`${base}/automation`);
    const request = user.waitForRequest(
      (request) => request.method() === 'PUT' && request.url().endsWith('/gateway'),
    );
    await configure.click();
    expect((await request).headers()['if-none-match']).toBe('*');
    await browserExpect(
      user.getByLabel('Wake on player connection', { exact: true }),
    ).not.toBeChecked();
    const saved = await harness.database.db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    expect(saved.enabled).toBe(false);
    expect(saved.idle_timeout_seconds).toBeNull();
    expect(saved.state).toBe('manually_stopped');
    await harness.screenshot(user, 'automation-configured-desktop-en');
    const audit = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(audit.violations).toEqual([]);
  });
});
