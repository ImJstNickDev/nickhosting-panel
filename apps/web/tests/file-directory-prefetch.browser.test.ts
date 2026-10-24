import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 silent visible-directory metadata prefetch', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let endpoint: string;
  let base: string;
  const batches: string[][] = [];
  const downloads: string[][] = [];
  const errors: string[] = [];

  beforeAll(async () => {
    harness = await browserHarness();
    const identities = await prepareJourneyIdentities(harness);
    user = identities.user;
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    endpoint = `/v1/servers/${provider.ids.serverId}/files`;
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    const server = await harness.database.db
      .selectFrom('managed_servers')
      .select('pterodactyl_identifier')
      .where('id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    if (!server.pterodactyl_identifier) throw new Error('Missing isolated provider identity');
    const files = await provider.files();
    for (let index = 0; index < 500; index++) {
      const name = `folder-${String(index).padStart(3, '0')}`;
      await provider.adapter.createDirectory(server.pterodactyl_identifier, '', name);
      await provider.adapter.createDirectory(server.pterodactyl_identifier, name, 'nested');
      await provider.adapter.createDirectory(
        server.pterodactyl_identifier,
        `${name}/nested`,
        'deep',
      );
      files.set(`${name}/keep.txt`, Buffer.from('Keep'));
      files.set(`${name}/remove.txt`, Buffer.from('Remove'));
      files.set(`${name}/nested/deep/data.txt`, Buffer.from('Deeper'));
    }
    const originalBatch = provider.adapter.listDirectoriesBatch;
    provider.adapter.listDirectoriesBatch = async (id, directories) => {
      batches.push([...directories]);
      return originalBatch(id, directories);
    };
    provider.adapter.prefetchDownloads = async (_id, paths) => {
      downloads.push([...paths]);
    };
    user.on('pageerror', (error) => errors.push(error.message));
  });
  afterEach(async () => {
    await user.unrouteAll({ behavior: 'ignoreErrors' });
    await user.goto(`${harness.origin}/servers`);
    await user.evaluate(() => sessionStorage.clear());
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  const entry = (name: string) =>
    user.locator('.fm-entry').filter({ has: user.getByRole('button', { name, exact: true }) });

  it('prefetches only visible branches, shows cached metadata immediately and refreshes the opened folder', async () => {
    batches.length = 0;
    downloads.length = 0;
    await user.goto(base);
    await browserExpect(entry('folder-000')).toBeVisible();
    await browserExpect.poll(() => batches.flat().includes('folder-000/nested/deep')).toBe(true);
    const paths = batches.flat();
    expect(paths.length).toBeLessThanOrEqual(96);
    expect(batches.every((batch) => batch.length <= 48)).toBe(true);
    expect(paths.some((path) => path.startsWith('folder-499'))).toBe(false);
    expect(downloads.flat().some((path) => path.startsWith('folder-'))).toBe(false);
    await harness.screenshot(user, 'files-prefetch-root-desktop-en');

    const remote = await provider.files();
    remote.delete('folder-000/remove.txt');
    remote.set('folder-000/new.txt', Buffer.from('New'));
    const gate = Promise.withResolvers<void>();
    let requested = false;
    await user.route(
      (url) => url.pathname === endpoint && url.searchParams.get('path') === 'folder-000',
      async (route) => {
        requested = true;
        await gate.promise;
        await route.continue().catch(() => {});
      },
    );
    try {
      await entry('folder-000').getByRole('button', { name: 'folder-000', exact: true }).click();
      await browserExpect.poll(() => requested).toBe(true);
      await browserExpect(entry('keep.txt')).toBeVisible();
      await browserExpect(entry('remove.txt')).toBeVisible();
      await browserExpect(entry('new.txt')).toHaveCount(0);
      await browserExpect(user.locator('.fm-loading')).toHaveCount(0);
      const unchanged = await entry('keep.txt').elementHandle();
      gate.resolve();
      await browserExpect(entry('new.txt')).toBeVisible();
      await browserExpect(entry('remove.txt')).toHaveCount(0);
      expect(await unchanged?.evaluate((element) => element.isConnected)).toBe(true);
      await browserExpect.poll(() => downloads.flat().includes('folder-000/new.txt')).toBe(true);
      await harness.screenshot(user, 'files-prefetch-open-desktop-en');
      await user.reload();
      await browserExpect(entry('new.txt')).toBeVisible();
      await user.locator('.tabs').getByRole('link', { name: 'Console', exact: true }).click();
      await user.locator('.tabs').getByRole('link', { name: 'Files', exact: true }).click();
      await browserExpect(entry('folder-000')).toBeVisible();
    } finally {
      gate.resolve();
    }
  });

  it('uses scroll visibility rather than all 500 folders and cancels obsolete batch delivery on tab exit', async () => {
    batches.length = 0;
    await user.goto(base);
    await browserExpect.poll(() => batches.length).toBeGreaterThan(0);
    expect(batches.flat().some((path) => path.startsWith('folder-499'))).toBe(false);
    await entry('folder-499').scrollIntoViewIfNeeded();
    await browserExpect.poll(() => batches.flat().includes('folder-499')).toBe(true);
    expect(batches.flat().length).toBeLessThanOrEqual(96);
    const gate = Promise.withResolvers<void>();
    let requested = false;
    let aborted = false;
    await user.route(`${harness.origin}${endpoint}/directories`, async (route) => {
      requested = true;
      await gate.promise;
      await route.fulfill({ json: { results: [] } }).catch(() => {});
    });
    user.on('requestfailed', (request) => {
      if (new URL(request.url()).pathname === `${endpoint}/directories`) aborted = true;
    });
    await entry('folder-250').scrollIntoViewIfNeeded();
    try {
      await browserExpect.poll(() => requested).toBe(true);
      await user.locator('.tabs').getByRole('link', { name: 'Console', exact: true }).click();
      await browserExpect.poll(() => aborted).toBe(true);
      gate.resolve();
      await browserExpect(user.locator('.file-manager')).toHaveCount(0);
    } finally {
      gate.resolve();
    }
  });

  it('keeps normal folder browsing functional when the optional batch endpoint is unavailable', async () => {
    let attempts = 0;
    await user.route(`${harness.origin}${endpoint}/directories`, async (route) => {
      attempts++;
      await route.fulfill({
        status: 503,
        json: { error: { code: 'integration_unavailable', messageKey: 'integration.unavailable' } },
      });
    });
    await user.goto(base);
    await browserExpect(entry('folder-000')).toBeVisible();
    await browserExpect.poll(() => attempts).toBe(1);
    await entry('folder-250').scrollIntoViewIfNeeded();
    await browserExpect(entry('folder-250')).toBeVisible();
    expect(attempts).toBe(1);
    await entry('folder-250').getByRole('button', { name: 'folder-250', exact: true }).click();
    await browserExpect(entry('keep.txt')).toBeVisible();
    await browserExpect(user.locator('[role="alert"]')).toHaveCount(0);
  });
});
