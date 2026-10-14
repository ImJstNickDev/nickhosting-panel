import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { AxeBuilder } from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  expect as check,
  firefox,
  type Page,
} from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const screenshots = '.codex/local/m5-browser/screenshots';
const password = 'isolated-sftp-password-123';
const fixture = (id = 'one', kind: 'primary' | 'auxiliary' = 'auxiliary') => ({
  kind,
  label: kind === 'auxiliary' ? 'Backup script' : null,
  id,
  serverId: 'sftp-fixture',
  actorId: 'owner',
  state: 'active',
  username: kind === 'primary' ? 'fixture-a3f92c18' : `nh-fixture-${id}`,
  createdAt: '2026-10-14T12:00:00Z',
  expiresAt: kind === 'primary' ? null : '2035-01-01T12:00:00Z',
});

describe('SFTP interface (isolated API responses, real rendered component)', () => {
  let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let credentials: ReturnType<typeof fixture>[],
    writes: string[],
    errors: string[],
    fail: boolean,
    configured: boolean,
    canIssue: boolean;
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/sftp-ui-vite`,
      server: { host: '127.0.0.1', port: 0 },
    });
    await vite.listen();
    origin = vite.resolvedUrls?.local[0] ?? '';
    if (!origin) throw new Error('Missing fixture origin');
    browser = await firefox.launch({
      headless: true,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${homedir()}/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu`,
      },
    });
    await mkdir(screenshots, { recursive: true });
  });
  beforeEach(async () => {
    credentials = [fixture()];
    writes = [];
    errors = [];
    fail = false;
    configured = true;
    canIssue = true;
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      if (!localStorage.getItem('nh.locale')) localStorage.setItem('nh.locale', 'en');
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            (window as unknown as { copied: string }).copied = value;
          },
        },
      });
    });
    await page.route('**/sftp-fixture-page', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><title>SFTP</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/sftp-page.tsx"></script></body></html>',
      }),
    );
    await page.route('**/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname,
        method = route.request().method();
      if (path.endsWith('/transfers'))
        return route.fulfill({
          json: {
            sftp: {
              configured,
              canIssue,
              auxiliaryLimit: 3,
              endpoint: configured ? { hostname: 'sftp.example.test', port: 2023 } : null,
            },
          },
        });
      if (path === '/v1/platform/servers/sftp-fixture')
        return route.fulfill({
          json: { permissions: { manage: canIssue }, name: 'Fixture server' },
        });
      if (method === 'GET' && path.endsWith('/sftp')) return route.fulfill({ json: credentials });
      if (path.includes('/sftp')) {
        writes.push(`${method} ${path}`);
        if (fail) return route.fulfill({ status: 503, json: { code: 'integration_unavailable' } });
        if (method === 'DELETE') {
          const id = path.split('/').at(-1);
          credentials = credentials.map((c) => (c.id === id ? { ...c, state: 'revoked' } : c));
          return route.fulfill({ json: credentials.find((c) => c.id === id) });
        }
        if (path.endsWith('/rotate')) {
          const id = path.split('/').at(-2);
          return route.fulfill({ json: { ...credentials.find((c) => c.id === id), password } });
        }
        const input = route.request().postDataJSON();
        const created = fixture(`created-${credentials.length}`, input.kind);
        if (input.label) created.label = input.label;
        credentials.push(created);
        return route.fulfill({ status: 201, json: { ...created, password } });
      }
      errors.push(`Unexpected request ${method} ${path}`);
      return route.fulfill({ status: 404, json: {} });
    });
  });
  afterEach(async () => {
    await context.close();
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });
  async function open() {
    await page.goto(`${origin}sftp-fixture-page`);
    await check(page.getByRole('heading', { name: 'SFTP', exact: true })).toBeVisible();
  }

  it('copies connection data and confirms rotation/revocation without per-row forms', async () => {
    await open();
    await check(page.getByText('sftp://sftp.example.test', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Copy hostname', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(
      'sftp://sftp.example.test',
    );
    await page.getByRole('button', { name: 'Rotate password', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await check(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    expect(writes).toEqual([]);
    await page.getByRole('button', { name: 'Rotate password', exact: true }).click();
    await dialog.getByRole('button', { name: 'Rotate password', exact: true }).click();
    await check(page.getByLabel('Password', { exact: true })).toHaveValue(password);
    await check(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await check(page.getByLabel('Password', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();
    await check(page.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
    expect(writes).toHaveLength(2);
  });

  it('hides only revoked accesses and toggles them with the keyboard without changing the limit', async () => {
    credentials = [
      fixture('primary', 'primary'),
      fixture('one'),
      { ...fixture('pending'), label: 'Pending access', state: 'pending' },
      { ...fixture('expired'), label: 'Expired access', state: 'expired' },
      { ...fixture('revoked'), label: 'Old backup', state: 'revoked' },
    ];
    await open();
    const additional = page.locator('.sftp-additional');
    const toggle = page.getByRole('switch', { name: 'Show revoked', exact: true });
    await check(additional.getByRole('table')).toBeVisible();
    await check(additional.getByRole('columnheader')).toHaveText([
      'Name',
      'Username',
      'Status',
      'Expires',
      'Actions',
    ]);
    await check(toggle).toHaveAttribute('aria-checked', 'false');
    await check(additional.getByText('Old backup', { exact: true })).toHaveCount(0);
    await check(additional.getByText('Pending access', { exact: true })).toBeVisible();
    await check(additional.getByText('Expired access', { exact: true })).toBeVisible();
    await check(additional.getByRole('row')).toHaveCount(4);
    await check(additional).toContainText('3 / 3');
    await check(page.getByRole('button', { name: 'Add access', exact: true })).toBeDisabled();
    await toggle.focus();
    await page.keyboard.press('Space');
    await check(toggle).toHaveAttribute('aria-checked', 'true');
    await check(additional.getByText('Old backup', { exact: true })).toBeVisible();
    await check(additional.getByRole('row')).toHaveCount(5);
    await check(additional).toContainText('3 / 3');
    await check(page.getByRole('button', { name: 'Add access', exact: true })).toBeDisabled();
    await page.keyboard.press('Enter');
    await check(toggle).toHaveAttribute('aria-checked', 'false');
    await check(additional.getByText('Old backup', { exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
  });

  it('immediately hides a revoked access and releases its place while preserving other accesses', async () => {
    credentials = [
      fixture('primary', 'primary'),
      fixture('one'),
      fixture('two'),
      fixture('three'),
      { ...fixture('revoked'), label: 'Old backup', state: 'revoked' },
    ];
    await open();
    const additional = page.locator('.sftp-additional');
    const row = additional.getByRole('row').filter({ hasText: 'nh-fixture-one' });
    await check(additional).toContainText('3 / 3');
    await check(page.getByRole('button', { name: 'Add access', exact: true })).toBeDisabled();
    await row.getByRole('button', { name: 'Revoke', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke', exact: true }).click();
    await check(row).toHaveCount(0);
    await check(additional).toContainText('2 / 3');
    await check(additional.getByRole('row')).toHaveCount(3);
    await check(page.getByRole('button', { name: 'Add access', exact: true })).toBeEnabled();
    await check(page.getByText('fixture-a3f92c18', { exact: true })).toBeVisible();
    await page.getByRole('switch', { name: 'Show revoked', exact: true }).click();
    await check(row).toBeVisible();
    await check(row.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
    await check(row.getByRole('button', { name: 'Rotate password', exact: true })).toHaveCount(0);
    await check(additional).toContainText('2 / 3');
    await check(additional.getByRole('row')).toHaveCount(5);
    await check(page.getByRole('button', { name: 'Add access', exact: true })).toBeEnabled();
    expect(writes).toEqual(['DELETE /v1/servers/sftp-fixture/sftp/one']);
  });

  it('keeps confirmation open on failure and does not claim success', async () => {
    fail = true;
    await open();
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke', exact: true }).click();
    await check(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    await check(page.getByText('nh-fixture-one', { exact: true }).first()).toBeVisible();
  });

  it('renders EN/IT desktop/mobile without overflow or automatic accessibility violations', async () => {
    credentials = [
      fixture('primary', 'primary'),
      fixture(),
      { ...fixture('revoked'), label: 'Old backup', state: 'revoked' },
    ];
    await open();
    for (const [locale, width, height] of [
      ['en', 1280, 800],
      ['it', 390, 844],
    ] as const) {
      await page.evaluate((locale) => localStorage.setItem('nh.locale', locale), locale);
      await page.setViewportSize({ width, height });
      await page.reload();
      await check(
        page.getByRole('heading', {
          name: locale === 'it' ? 'Connessione' : 'Connection',
          exact: true,
        }),
      ).toBeVisible();
      await check(page.getByText('sftp://sftp.example.test', { exact: true })).toBeVisible();
      await check(page.getByRole('table')).toBeVisible();
      await check(page.getByRole('cell', { name: 'Backup script', exact: true })).toBeVisible();
      await check(page.getByText('Old backup', { exact: true })).toHaveCount(0);
      await check(
        page.getByRole('switch', { name: locale === 'it' ? 'Mostra revocati' : 'Show revoked' }),
      ).toHaveAttribute('aria-checked', 'false');
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
      await page.screenshot({
        path: `${screenshots}/sftp-polish-${locale}-${width}.png`,
        fullPage: true,
      });
      await page
        .getByRole('switch', { name: locale === 'it' ? 'Mostra revocati' : 'Show revoked' })
        .click();
      await check(page.getByRole('cell', { name: 'Old backup', exact: true })).toBeVisible();
      await page.screenshot({
        path: `${screenshots}/sftp-polish-revoked-${locale}-${width}.png`,
        fullPage: true,
      });
    }
  });

  it('issues a masked one-time password, handles clipboard failure and clears it on reload', async () => {
    credentials = [];
    await open();
    await page.getByRole('button', { name: 'Generate SFTP password', exact: true }).click();
    const field = page.getByLabel('Password', { exact: true });
    await check(field).toHaveValue(password);
    await check(field).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Show password', exact: true }).click();
    await check(field).toHaveAttribute('type', 'text');
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }),
    );
    await page.getByRole('button', { name: 'Copy password', exact: true }).click();
    await check(page.getByRole('alert')).toContainText('Could not copy');
    await page.reload();
    await check(page.getByText('fixture-a3f92c18', { exact: true })).toBeVisible();
    await check(page.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
    await check(page.getByLabel('Password', { exact: true })).toHaveCount(0);
    expect(writes).toHaveLength(1);
  });

  it('creates named additional access and respects its independent limit', async () => {
    credentials = [fixture('primary', 'primary'), fixture('one'), fixture('two')];
    await open();
    await page.getByRole('button', { name: 'Add access', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('Nightly backup');
    await dialog.getByRole('button', { name: 'Add access', exact: true }).click();
    await check(page.getByText('Nightly backup', { exact: true })).toBeVisible();
    await check(page.getByRole('button', { name: 'Add access', exact: true })).toBeDisabled();
    await check(
      page.locator('.sftp-primary').getByRole('button', { name: 'Rotate password' }),
    ).toBeEnabled();
    expect(writes).toHaveLength(1);
  });

  it('hides issuance when unconfigured or forbidden', async () => {
    configured = false;
    canIssue = false;
    credentials = [];
    await open();
    await check(
      page.getByRole('button', { name: 'Generate SFTP password', exact: true }),
    ).toHaveCount(0);
    expect(writes).toEqual([]);
  });
});
