import { Buffer } from 'node:buffer';
import { expect as browserExpect } from '@playwright/test';
import { expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

it('keeps long directory and editor paths on one line, following the tail without hiding keyboard ancestors', async () => {
  const harness = await browserHarness();
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>> | undefined;
  try {
    const identities = await prepareJourneyIdentities(harness);
    const page = identities.user;
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    const server = await harness.database.db
      .selectFrom('managed_servers')
      .select('pterodactyl_identifier')
      .where('id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    const folders = [
      'world-configuration-and-settings',
      'archived-player-data-and-backups',
      'current-season-server-resources',
      'custom-gameplay-configuration',
    ];
    let path = '';
    for (const name of folders) {
      await provider.adapter.createDirectory(server.pterodactyl_identifier ?? '', path, name);
      path = [path, name].filter(Boolean).join('/');
    }
    (await provider.files()).set(`${path}/settings.properties`, Buffer.from('enabled=true\n'));
    await page.goto(`${harness.origin}/servers/${provider.ids.serverId}/files`);
    for (const name of folders)
      await page.locator('.fm-filename').getByText(name, { exact: true }).click();
    const list = page.locator('.fm-breadcrumb ol');
    const checkTail = async () => {
      await browserExpect
        .poll(() =>
          list.evaluate((el) => Math.abs(el.scrollWidth - el.clientWidth - el.scrollLeft)),
        )
        .toBeLessThan(2);
      const positions = await list.locator('li').evaluateAll((items) =>
        items.map((item) => {
          const r = item.getBoundingClientRect();
          return r.top + r.height / 2;
        }),
      );
      expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    };
    await checkTail();
    await harness.screenshot(page, 'fileman-breadcrumb-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await checkTail();
    await harness.screenshot(page, 'fileman-breadcrumb-mobile');
    const root = list.getByRole('button', { name: 'root', exact: true });
    await root.focus();
    await browserExpect.poll(() => list.evaluate((el) => el.scrollLeft)).toBeLessThan(2);
    await page.keyboard.press('Tab');
    await browserExpect(list.getByRole('button', { name: folders[0], exact: true })).toBeFocused();
    await page.locator('.fm-filename').getByText('settings.properties', { exact: true }).click();
    await browserExpect(page.locator('.cm-editor')).toBeVisible();
    await checkTail();
    await harness.screenshot(page, 'fileman-breadcrumb-editor-mobile');
  } finally {
    provider?.dispose();
    await harness.close();
  }
});
