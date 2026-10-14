import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AxeBuilder } from '@axe-core/playwright';
import { authorizeServer } from '@nickhosting/server-management';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeFileViewers, closeViewerArchives } from '../../api/src/file-viewers.js';
import { ViewerCache } from '../../api/src/viewer-cache.js';
import { FileViewerService } from '../../api/src/viewer-service.js';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

/** Real HTTP SQLite handlers/worker; only remote storage and provider are isolated fixtures. */
describe('Datagrid real SQLite journey', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let root: string;
  let cache: ViewerCache;
  let bytes: Buffer;
  let base: string;
  let downloads = 0;
  let revision = 1;
  const errors: string[] = [];
  const requests: string[] = [];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nh-datagrid-browser-'));
    const file = join(root, 'fixture.sqlite');
    const sqlite = new DatabaseSync(file);
    sqlite.exec(`CREATE TABLE players(id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, notes TEXT, avatar BLOB);
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
      INSERT INTO settings VALUES ('difficulty','normal');
      CREATE TABLE empty_table(id INTEGER PRIMARY KEY);
      CREATE TABLE odd_columns(constructor TEXT, toString TEXT, __proto__ TEXT);
      INSERT INTO odd_columns VALUES('first','second','third');`);
    const insert = sqlite.prepare('INSERT INTO players VALUES (?,?,?,?,?)');
    sqlite.exec('BEGIN');
    for (let n = 1; n <= 235; n++)
      insert.run(
        n,
        `Player ${String(n).padStart(3, '0')}`,
        n / 2,
        n === 1 ? 'à😀'.repeat(40000) : n === 2 ? null : `Note ${n}`,
        n === 3 ? Buffer.from([1, 2, 3]) : null,
      );
    insert.run(9007199254740993n, 'Exact integer', 0, 'Literal 100%_match', null);
    sqlite.exec('COMMIT');
    sqlite.close();
    bytes = await readFile(file);
    cache = new ViewerCache({ root: join(root, 'cache') });
    harness = await browserHarness({
      browser: process.env.NH_BROWSER === 'firefox' ? 'firefox' : 'chromium',
    });
    const identities = await prepareJourneyIdentities(harness);
    page = identities.user;
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    (await provider.files()).set('hosting.sqlite', bytes);
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    vi.spyOn(FileViewerService.prototype, 'open').mockImplementation(
      async (context, _management, serverId, path) => {
        await authorizeServer(harness.database.db, context, serverId, 'server:read');
        const current = revision;
        return {
          source: {
            size: bytes.length,
            mtimeMs: current,
            read: async (offset, length) => bytes.subarray(offset, offset + length),
            stream: (start = 0, end = bytes.length) =>
              new ReadableStream({
                start(controller) {
                  downloads++;
                  controller.enqueue(bytes.subarray(start, end));
                  controller.close();
                },
              }),
          },
          key: `${serverId}:${path}:${current}`,
          path,
          cache,
          signal: new AbortController().signal,
          close: async () => {},
          restat: async () => ({ size: bytes.length, mtimeMs: current, mode: 0o644 }),
          siblingExists: async () => false,
        };
      },
    );
    await page.route('**/files/viewer/capabilities', (route) =>
      route.fulfill({ json: { available: true } }),
    );
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.url().includes('/viewer/sqlite')) requests.push(request.url());
    });
  });
  afterAll(async () => {
    if (harness) {
      await closeViewerArchives(harness.database.db);
      await closeFileViewers(harness.database.db);
    }
    provider?.dispose();
    await harness?.close();
    await cache?.close();
    if (root) await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  async function open() {
    await page.goto(base);
    await page.locator('.fm-breadcrumb').getByRole('button', { name: 'root', exact: true }).click();
    await page.locator('.fm-filename').getByText('hosting.sqlite', { exact: true }).click();
    await browserExpect(page.locator('.dg-workspace')).toBeVisible();
    await page.locator('.dg-sidebar').getByRole('button', { name: 'players', exact: true }).click();
    await browserExpect(page.getByRole('grid')).toContainText('Player 001');
  }
  it('browses real paginated data, caches previous pages, sorts, filters, and exposes schema', async () => {
    await open();
    const before = downloads;
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await browserExpect(page.getByRole('grid')).toContainText('Player 101');
    const requestCount = requests.length;
    await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await browserExpect(page.getByRole('grid')).toContainText('Player 001');
    expect(requests.length).toBe(requestCount);
    expect(downloads).toBe(before);
    await page
      .getByRole('columnheader')
      .filter({ hasText: /^name/ })
      .getByRole('button')
      .first()
      .click();
    await browserExpect(page.getByRole('grid')).toContainText('Exact integer');
    await page.getByRole('searchbox', { name: 'Search data', exact: true }).fill('100%_match');
    await browserExpect(page.getByRole('grid')).toContainText('9007199254740993');
    await browserExpect(page.getByRole('gridcell')).toHaveCount(5);
    await page.getByRole('searchbox', { name: 'Search data', exact: true }).fill('');
    await browserExpect(page.getByRole('gridcell')).toHaveCount(500);
    await page.getByRole('button', { name: 'Schema', exact: true }).click();
    await browserExpect(page.locator('.dg-workspace')).toContainText('INTEGER');
    await page.getByRole('button', { name: 'Data', exact: true }).click();
    await harness.screenshot(page, 'datagrid-desktop-en');
    const axe = await new AxeBuilder({ page })
      .include('.dg-workspace')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(axe.violations).toEqual([]);
    expect(errors).toEqual([]);
  });
  it('uses keyboard cells, reads long text on demand and restores focus when closing details', async () => {
    await open();
    await page.getByRole('button', { name: 'Back to files', exact: true }).focus();
    await page.keyboard.press('Control+f');
    await browserExpect(
      page.getByRole('searchbox', { name: 'Search data', exact: true }),
    ).toBeFocused();
    const notes = page.getByRole('gridcell').filter({ hasText: 'à😀' }).first();
    await notes.focus();
    await page.keyboard.press('Enter');
    const detail = page.getByRole('region', { name: 'Cell details' });
    await browserExpect(detail).toBeVisible();
    await browserExpect(detail).toContainText('à😀');
    await page.getByRole('button', { name: 'Next text chunk', exact: true }).click();
    await browserExpect(detail).toContainText('à😀');
    await browserExpect(
      page.getByRole('button', { name: 'Previous text chunk', exact: true }),
    ).toBeEnabled();
    await harness.screenshot(page, 'datagrid-cell-detail-en');
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    await browserExpect(notes).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await browserExpect(
      page
        .getByRole('gridcell')
        .filter({ hasText: /^0\.5$/ })
        .first(),
    ).toBeFocused();
    expect(errors).toEqual([]);
  });
  it('resizes arbitrary column names with keyboard and pointer without inherited object values', async () => {
    await open();
    await page
      .locator('.dg-sidebar')
      .getByRole('button', { name: 'odd_columns', exact: true })
      .click();
    const resize = page.getByRole('separator', { name: 'Resize constructor', exact: true });
    await browserExpect(resize).toHaveAttribute('aria-valuenow', '190');
    await resize.focus();
    await page.keyboard.press('ArrowRight');
    await browserExpect(resize).toHaveAttribute('aria-valuenow', '210');
    const handle = await resize.boundingBox();
    if (!handle) throw new Error('Missing resize handle');
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 30, handle.y + handle.height / 2);
    await page.mouse.up();
    await browserExpect(resize).toHaveAttribute('aria-valuenow', '240');
    await browserExpect(
      page.getByRole('separator', { name: 'Resize __proto__', exact: true }),
    ).toHaveAttribute('aria-valuenow', '190');
  });
  it('refuses details from a changed revision and recovers with explicit refresh', async () => {
    await open();
    revision++;
    await page.getByRole('gridcell').filter({ hasText: 'à😀' }).first().dblclick();
    await browserExpect(page.locator('.dg-refresh-needed')).toBeVisible();
    await page
      .locator('.dg-refresh-needed')
      .getByRole('button', { name: 'Refresh database', exact: true })
      .click();
    await browserExpect(page.getByRole('grid')).toContainText('Player 001');
    await browserExpect(page.locator('.dg-refresh-needed')).toHaveCount(0);
  });
  it('clears all cached rows when a detail read reveals revoked access', async () => {
    await open();
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await browserExpect(page.getByRole('grid')).toContainText('Player 101');
    await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await browserExpect(page.getByRole('grid')).toContainText('Player 001');
    await page.route('**/files/viewer/sqlite/cell?*', (route) =>
      route.fulfill({
        status: 403,
        json: { error: { code: 'forbidden', messageKey: 'error.forbidden' } },
      }),
    );
    await page.getByRole('gridcell').first().dblclick();
    await browserExpect(page.locator('.dg-feedback')).toBeVisible();
    await browserExpect(page.getByRole('gridcell')).toHaveCount(0);
    await browserExpect(page.locator('.dg-sidebar button')).toHaveCount(0);
    await page.unroute('**/files/viewer/sqlite/cell?*');
  });
  it('holds its layout during loading and exposes a retryable failure', async () => {
    await open();
    await page.getByRole('button', { name: 'Back to files', exact: true }).click();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/files/viewer/sqlite?*', async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page.locator('.fm-filename').getByText('hosting.sqlite', { exact: true }).click();
      await browserExpect(page.locator('.dg-skeleton')).toBeVisible();
      await harness.screenshot(page, 'datagrid-loading-en');
      release();
      await page
        .locator('.dg-sidebar')
        .getByRole('button', { name: 'players', exact: true })
        .click();
      await browserExpect(page.getByRole('grid')).toContainText('Player 001');
    } finally {
      release();
      await page.unroute('**/files/viewer/sqlite?*');
    }
    await page.route('**/files/viewer/sqlite?*', (route) =>
      route.fulfill({
        status: 422,
        json: { error: { code: 'viewer_sqlite_timeout', messageKey: 'viewer.sqliteTimeout' } },
      }),
    );
    await page.getByRole('button', { name: 'Refresh database', exact: true }).click();
    await browserExpect(page.locator('.dg-feedback')).toBeVisible();
    await harness.screenshot(page, 'datagrid-error-en');
    await page.unroute('**/files/viewer/sqlite?*');
    await page.locator('.dg-feedback').getByRole('button').click();
    await browserExpect(page.getByRole('grid')).toContainText('Player 001');
  });
  it('shows empty states and remains usable on Italian mobile', async () => {
    await open();
    await page
      .locator('.dg-sidebar')
      .getByRole('button', { name: 'empty_table', exact: true })
      .click();
    await browserExpect(page.getByRole('gridcell')).toHaveCount(0);
    await harness.screenshot(page, 'datagrid-empty-en');
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await browserExpect(page.locator('.dg-workspace')).toBeVisible();
    await page.locator('.dg-sidebar').getByRole('button', { name: 'players', exact: true }).click();
    await browserExpect(page.getByRole('grid')).toContainText('Player 001');
    await browserExpect(
      page.getByRole('searchbox', { name: 'Cerca dati', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await harness.screenshot(page, 'datagrid-mobile-it');
    const axe = await new AxeBuilder({ page })
      .include('.dg-workspace')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(axe.violations).toEqual([]);
    await page.getByRole('gridcell').first().dblclick();
    const close = page.getByRole('button', { name: 'Chiudi dettagli', exact: true });
    await browserExpect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.dg-grid'))).toBe(false);
    await close.click();
    await browserExpect(page.getByRole('gridcell').first()).toBeFocused();
  });
});
