import { mkdir } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as check, type Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

/** Real Fileman, integration policy and listing handlers; PNG transport uses isolated bytes.
 * Viewer authorization/containment is covered by the viewer API's own tests. */
describe('Minecraft directory icons', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let base: string;
  let endpoint: string;
  let files: Map<string, Buffer>;
  let icon: Buffer;
  const errors: string[] = [];
  const reads: string[] = [];
  const namedDirectories = ['logs', 'mods', 'plugins', 'config'] as const;
  let holdIcon: Promise<void> | undefined;
  let releaseIcon: (() => void) | undefined;

  beforeAll(async () => {
    harness = await browserHarness();
    const identities = await prepareJourneyIdentities(harness);
    page = identities.user;
    page.on('pageerror', (error) => errors.push(error.message));
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    endpoint = `/v1/servers/${provider.ids.serverId}/files`;
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Missing fixture canvas');
      context.fillStyle = '#98c4dd';
      context.fillRect(0, 0, 64, 64);
      context.fillStyle = '#eff3e4';
      context.fillRect(8, 8, 24, 8);
      context.fillStyle = '#657b56';
      context.fillRect(0, 32, 64, 32);
      context.fillStyle = '#44553b';
      context.fillRect(32, 24, 24, 40);
      context.fillStyle = '#7aa8c0';
      context.fillRect(0, 48, 32, 16);
      return canvas.toDataURL('image/png').split(',')[1] ?? '';
    });
    icon = Buffer.from(png, 'base64');
    for (const name of [
      'Alpine',
      'Broken',
      'Collection',
      'Forbidden',
      'Missing',
      'Oversized',
      'Pictures',
      'Symlink',
      ...namedDirectories,
    ])
      await journeyRequest(harness, page, endpoint, { action: 'mkdir', root: '', name });
    for (const name of ['custom-world', 'default-world', ...namedDirectories])
      await journeyRequest(harness, page, endpoint, {
        action: 'mkdir',
        root: 'Collection',
        name,
      });
    files = await provider.files();
    for (const world of [
      'Alpine',
      'Broken',
      'Forbidden',
      'Missing',
      'Oversized',
      'Symlink',
      'Collection/custom-world',
    ]) {
      files.set(`${world}/level.dat`, Buffer.from('Isolated world metadata marker'));
      if (world !== 'Missing') files.set(`${world}/icon.png`, icon);
    }
    files.set('Collection/default-world/level.dat', Buffer.from('Isolated world metadata marker'));
    for (const name of namedDirectories) files.set(`Alpine/${name}`, Buffer.from('Ordinary file'));
    files.set('Broken/icon.png', Buffer.from('Invalid PNG fixture'));
    files.set('Oversized/icon.png', Buffer.alloc(256 * 1024 + 1));
    files.set('Pictures/icon.png', icon);
    const listFiles = provider.adapter.listFiles.bind(provider.adapter);
    provider.adapter.listFiles = async (id, directory) =>
      (await listFiles(id, directory)).map((entry) =>
        directory === 'Symlink' && entry.name === 'icon.png'
          ? { ...entry, is_symlink: true }
          : entry,
      );
    await mkdir('.codex/local/m5-browser/screenshots', { recursive: true });
  });

  beforeEach(async () => {
    reads.length = 0;
    await page.route(`**${endpoint}/viewer/content?*`, async (route) => {
      const path = new URL(route.request().url()).searchParams.get('path') ?? '';
      reads.push(path);
      if (path === 'Alpine/icon.png') await holdIcon;
      if (path === 'Forbidden/icon.png') {
        await route.fulfill({ status: 403, json: { code: 'forbidden' } });
        return;
      }
      const bytes = files.get(path);
      await route.fulfill({
        status: bytes ? 200 : 404,
        contentType: 'image/png',
        body: bytes ?? Buffer.alloc(0),
      });
    });
  });

  afterEach(async () => {
    releaseIcon?.();
    holdIcon = undefined;
    releaseIcon = undefined;
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'en' });
    await page.goto(`${harness.origin}/servers`);
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.setItem('nh.locale', 'en');
    });
    expect(errors).toEqual([]);
    expect(files.get('Alpine/icon.png')).toEqual(icon);
    expect(files.get('Alpine/level.dat')?.toString()).toBe('Isolated world metadata marker');
  });

  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });

  const row = (name: string) =>
    page.locator('.fm-entry').filter({ has: page.getByRole('button', { name, exact: true }) });
  const artwork = (name: string) => row(name).locator('img.fm-type-directory-artwork');
  const folder = (name: string) => row(name).locator('svg.fm-icon-folder');
  const bundled = (name: string) => row(name).locator('img.fm-type-directory-asset');
  async function expectWorldIcon(name: string) {
    await check(bundled(name)).toHaveAttribute('data-directory-asset', 'directory-world');
    await check(bundled(name)).toBeVisible();
    await check(folder(name)).toHaveCount(0);
  }
  async function open() {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.goto(base);
    await check(row('Alpine')).toBeVisible();
  }
  async function screenshot(name: string) {
    await page.screenshot({
      path: `.codex/local/m5-browser/screenshots/file-world-icons-${name}.png`,
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  }

  it('uses a world PNG without changing normal selection, menus or folder navigation', async () => {
    await open();
    await check(artwork('Alpine')).toBeVisible();
    await check(folder('Alpine')).toHaveCount(0);
    expect(await artwork('Alpine').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(
      64,
    );
    await row('Alpine').getByRole('checkbox').check();
    await check(row('Alpine').getByRole('checkbox')).toBeChecked();
    await row('Alpine').getByRole('checkbox').uncheck();
    await row('Alpine').getByRole('button', { name: 'Actions for Alpine', exact: true }).click();
    await check(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    for (const name of namedDirectories) await check(bundled(name)).toBeVisible();
    await screenshot('desktop-en');
    await row('Alpine').getByRole('button', { name: 'Alpine', exact: true }).click();
    await check(row('level.dat')).toBeVisible();
    await check(row('icon.png')).toBeVisible();
    await check(row('icon.png').locator('.fm-type-image')).toBeVisible();
    await page.getByRole('button', { name: 'root', exact: true }).click();
    await row('Collection').getByRole('button', { name: 'Collection', exact: true }).click();
    await check(artwork('custom-world')).toBeVisible();
    expect(reads).toContain('Collection/custom-world/icon.png');
  });

  it('uses the default world icon while loading and when world artwork cannot be used', async () => {
    holdIcon = new Promise<void>((resolve) => {
      releaseIcon = resolve;
    });
    await open();
    await check.poll(() => reads.includes('Alpine/icon.png')).toBe(true);
    await expectWorldIcon('Alpine');
    releaseIcon?.();
    await check(artwork('Alpine')).toBeVisible();
    await check.poll(() => reads.includes('Forbidden/icon.png')).toBe(true);
    await check.poll(() => reads.includes('Broken/icon.png')).toBe(true);
    for (const name of ['Broken', 'Forbidden', 'Missing', 'Oversized', 'Symlink']) {
      await expectWorldIcon(name);
      await check(artwork(name)).toHaveCount(0);
    }
    await check(folder('Pictures')).toBeVisible();
    await check(bundled('Pictures')).toHaveCount(0);
    for (const name of ['Missing', 'Oversized', 'Pictures', 'Symlink'])
      expect(reads).not.toContain(`${name}/icon.png`);
    expect(reads.every((path) => path.endsWith('/icon.png'))).toBe(true);
  });

  it('uses bundled icons for named folders at root and below it but not for same-name files', async () => {
    await open();
    for (const name of namedDirectories) {
      await check(bundled(name)).toHaveAttribute('data-directory-asset', `directory-${name}`);
      expect(
        await bundled(name).evaluate((image: HTMLImageElement) => image.naturalWidth),
      ).toBeGreaterThan(0);
    }
    await row('Collection').getByRole('button', { name: 'Collection', exact: true }).click();
    for (const name of namedDirectories)
      await check(bundled(name)).toHaveAttribute('data-directory-asset', `directory-${name}`);
    await expectWorldIcon('default-world');
    await page.getByRole('button', { name: 'root', exact: true }).click();
    await row('Alpine').getByRole('button', { name: 'Alpine', exact: true }).click();
    for (const name of namedDirectories) {
      await check(row(name)).toBeVisible();
      await check(bundled(name)).toHaveCount(0);
      await check(row(name).locator('.fm-type-text')).toBeVisible();
    }
    for (const name of namedDirectories) expect(reads).not.toContain(`${name}/icon.png`);
  });

  it('preserves artwork in the grid and compact mobile layout', async () => {
    await open();
    await check(artwork('Alpine')).toBeVisible();
    await page.getByRole('button', { name: 'Grid', exact: true }).click();
    await check(page.locator('.fm-list.fm-grid')).toBeVisible();
    await check(artwork('Alpine')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 1000 });
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.reload();
    await row('Collection').getByRole('button', { name: 'Collection', exact: true }).click();
    await page.getByRole('button', { name: 'Griglia', exact: true }).click();
    await check(page.locator('.fm-list.fm-grid')).toBeVisible();
    await row('custom-world').scrollIntoViewIfNeeded();
    await check(artwork('custom-world')).toBeVisible();
    await expectWorldIcon('default-world');
    for (const name of namedDirectories) await check(bundled(name)).toBeVisible();
    await screenshot('mobile-it');
  });

  it('refreshes changed world metadata and replaces stale artwork', async () => {
    await open();
    await check(artwork('Alpine')).toBeVisible();
    const before = await artwork('Alpine').getAttribute('src');
    try {
      files.delete('Alpine/icon.png');
      await page.getByRole('button', { name: 'Refresh files', exact: true }).click();
      await expectWorldIcon('Alpine');
      await check(artwork('Alpine')).toHaveCount(0);
      files.set('Alpine/icon.png', Buffer.from(icon));
      await page.getByRole('button', { name: 'Refresh files', exact: true }).click();
      await check(artwork('Alpine')).toBeVisible();
      expect(await artwork('Alpine').getAttribute('src')).not.toBe(before);
    } finally {
      files.set('Alpine/icon.png', icon);
    }
  });

  it('keeps all directory icons generic for a different game', async () => {
    await page.route(`**/v1/platform/servers/${provider.ids.serverId}`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        json: { ...(await response.json()), gameId: 'another-game', runtimeId: 'generic' },
      });
    });
    await open();
    await check(folder('Alpine')).toBeVisible();
    await check(page.locator('img.fm-type-directory-artwork')).toHaveCount(0);
    await check(page.locator('img.fm-type-directory-asset')).toHaveCount(0);
    for (const name of namedDirectories) await check(folder(name)).toBeVisible();
    // Completing an ordinary navigation also allows any accidental icon request to surface.
    await row('Collection').getByRole('button', { name: 'Collection', exact: true }).click();
    await check(folder('custom-world')).toBeVisible();
    expect(reads).toEqual([]);
  });
});
