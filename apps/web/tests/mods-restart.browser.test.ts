import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('Mods restart receipt in the real Console shell', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let required = true;
  let unavailable = false;
  let checks = 0;
  const effects: string[] = [];

  beforeAll(async () => {
    fixture = await browserHarness();
    const identities = await prepareJourneyIdentities(fixture);
    user = identities.user;
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
    // Isolated fixture changes only the declared management runtime. The test
    // exercises Console presentation; core tests prove actual process receipts.
    await fixture.database.db
      .updateTable('runtime_egg_mappings')
      .set({ runtime_id: 'fabric' })
      .where('id', '=', provider.ids.mappingId)
      .execute();
    const power = provider.adapter.power;
    provider.adapter.power = async (id, action) => {
      effects.push(action);
      return power(id, action);
    };
    await user.route('**/minecraft/mods/restart-status', (route) => {
      checks++;
      return route.fulfill({
        status: unavailable ? 503 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          unavailable
            ? {
                error: {
                  code: 'integration_unavailable',
                  messageKey: 'errors.integration_unavailable',
                },
              }
            : { required, changedAt: '2026-10-20T10:00:00.000Z' },
        ),
      });
    });
  });
  afterAll(async () => {
    provider?.dispose();
    await fixture?.close();
  });

  it('retains the advisory across reload, handles retry and only clears on a receipt', async () => {
    await user.setViewportSize({ width: 1440, height: 1000 });
    const url = `${fixture.origin}/servers/${provider.ids.serverId}/console`;
    await user.goto(url);
    const notice = user.locator('.minecraft-mod-restart');
    await browserExpect(notice).toContainText('Restart the server');
    await browserExpect(notice.getByRole('link')).toHaveAttribute(
      'href',
      `/servers/${provider.ids.serverId}/game/mods`,
    );
    await user.screenshot({
      path: resolve('docs/screenshots/m5/minecraft-mods-console-restart-en.png'),
      fullPage: true,
    });
    await user.reload();
    await browserExpect(notice).toContainText('Restart the server');
    unavailable = true;
    await user.reload();
    await browserExpect(notice).toContainText('Mod restart status unavailable');
    unavailable = false;
    await notice.getByRole('button', { name: 'Try again' }).click();
    await browserExpect(notice).toContainText('Restart the server');
    await journeyRequest(fixture, user, '/api/auth/update-user', { locale: 'it' });
    await user.evaluate(() => localStorage.setItem('nh.locale', 'it'));
    await user.setViewportSize({ width: 390, height: 844 });
    await user.reload();
    await browserExpect(notice).toContainText('Riavvia il server', { timeout: 10000 });
    expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (
        await new AxeBuilder({ page: user })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await user.screenshot({
      path: resolve('docs/screenshots/m5/minecraft-mods-console-restart-it-mobile.png'),
      fullPage: true,
    });
    required = false;
    await user.reload();
    await browserExpect.poll(() => checks).toBeGreaterThan(4);
    await browserExpect(notice).toHaveCount(0);
    expect(effects).toEqual([]);
  });
});
