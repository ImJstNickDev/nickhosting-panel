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
import type { ConnectionOptions } from '../src/features/connection.api.js';

const domain = {
  id: 'main',
  hostname: 'games.example.test',
  zoneId: 'a'.repeat(32),
  target: '192.0.2.1',
  enabled: true,
};
describe('Domain choices and management (isolated responses, real components)', () => {
  let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let options: ConnectionOptions,
    values: Record<string, unknown>,
    lockedKeys: string[],
    writes: Array<{ path: string; body: unknown }>,
    errors: string[],
    canManage: boolean;
  let addressState: string;
  let assignments: Array<{ id: string; state: string; connection: { displayAddress: string } }>;
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/domains-ui-vite`,
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await vite.listen();
    origin = vite.resolvedUrls?.local[0] ?? '';
    browser = await firefox.launch({
      headless: true,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${homedir()}/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu`,
      },
    });
    await mkdir('.codex/local/m5-browser/screenshots', { recursive: true });
  });
  beforeEach(async () => {
    options = {
      mode: 'custom-subdomain',
      customizable: true,
      domains: [{ id: 'main', hostname: domain.hostname }],
      defaultDomainId: 'main',
      defaultHostname: null,
      supportsSrv: true,
      configured: true,
    };
    values = {
      dnsDomains: [domain],
      dnsDefaultDomainId: 'main',
      dnsBlockedTerms: [],
      dnsGamePolicies: {},
    };
    lockedKeys = [];
    writes = [];
    errors = [];
    assignments = [];
    canManage = true;
    addressState = 'unconfigured';
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (!localStorage.getItem('nh.locale')) localStorage.setItem('nh.locale', 'en');
    });
    await page.route('**/domains-fixture*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><title>Domains</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/domains-page.tsx"></script></body></html>',
      }),
    );
    await page.route('**/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname,
        method = route.request().method();
      if (path === '/v1/web/session') {
        const user = {
          id: 'owner',
          name: 'Fixture owner',
          email: 'owner@example.test',
          emailVerified: true,
          twoFactorEnabled: false,
          locale: 'en',
          role: 'owner',
        };
        return route.fulfill({
          json: {
            context: {
              actorUserId: user.id,
              subjectUserId: user.id,
              role: 'owner',
              sessionType: 'regular',
              ownerElevation: false,
            },
            actor: user,
            subject: user,
          },
        });
      }
      if (path.endsWith('/connection-options')) return route.fulfill({ json: options });
      if (path === '/v1/owner/settings') {
        if (method === 'PATCH') {
          const body = route.request().postDataJSON();
          writes.push({ path, body });
          Object.assign(values, body);
        }
        return route.fulfill({ json: { config: { values, lockedKeys } } });
      }
      if (path === '/v1/platform/servers/domain-fixture')
        return route.fulfill({
          json: { name: 'Fixture server', permissions: { manage: canManage } },
        });
      if (path.endsWith('/connections'))
        return route.fulfill({
          json: {
            connectionMode: 'gateway',
            addressState,
            primaryDnsAssignmentId: assignments.at(-1)?.id ?? null,
            mode: options.mode,
            ports: [
              {
                primary: true,
                role: 'game',
                hostname: '192.0.2.1',
                port: 28000,
                transport: 'tcp',
                status: 'configured',
                displayAddress: '192.0.2.1:28000',
              },
            ],
          },
        });
      if (path.endsWith('/dns/preview')) {
        writes.push({ path, body: route.request().postDataJSON() });
        return route.fulfill({
          json: {
            displayAddress: `blue-panda-bag.${domain.hostname}`,
            domainId: 'main',
            subdomain: 'blue-panda-bag',
            shared: false,
          },
        });
      }
      if (path.includes('/dns')) {
        if (method === 'DELETE') {
          writes.push({ path, body: route.request().postDataJSON() });
          assignments = assignments.filter((entry) => entry.id !== path.split('/').at(-1));
          return route.fulfill({ json: {} });
        }
        if (method !== 'GET') {
          writes.push({ path, body: route.request().postDataJSON() });
          assignments = [
            {
              id: 'assignment',
              state: 'pending',
              connection: { displayAddress: `blue-panda-bag.${domain.hostname}` },
            },
          ];
        }
        return route.fulfill({ json: assignments });
      }
      errors.push(`${method} ${path}`);
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
  async function open(view = 'network') {
    await page.goto(`${origin}domains-fixture?view=${view}`);
  }
  it('uses automatic labels and only shows domain selection when necessary', async () => {
    await open('creation');
    await check(page.getByPlaceholder('Automatic')).toBeVisible();
    await check(page.getByRole('combobox')).toHaveCount(0);
    options.domains.push({ id: 'other', hostname: 'other.example.test' });
    await page.reload();
    await page.getByLabel('Domain', { exact: true }).selectOption('other');
    await page.getByLabel('Subdomain', { exact: true }).fill('my-world');
    await check(page.locator('output')).toHaveText('{"domainId":"other","subdomain":"my-world"}');
    expect(writes).toEqual([]);
  });
  it('keeps fixed and unavailable options honest', async () => {
    options = {
      ...options,
      mode: 'shared-host',
      customizable: false,
      defaultHostname: 'shared.example.test',
    };
    await open('creation');
    await check(page.getByText('shared.example.test', { exact: true })).toBeVisible();
    await check(page.getByRole('textbox')).toHaveCount(0);
    options.configured = false;
    await page.reload();
    await check(page.getByText('Custom addresses are not configured.')).toBeVisible();
  });
  it('requires explicit activation, pins automatic preview and does not claim pending DNS is ready', async () => {
    await open();
    expect(writes).toEqual([]);
    await page.getByRole('button', { name: 'Change address', exact: true }).click();
    await page.getByRole('button', { name: 'Preview address', exact: true }).click();
    await check(
      page.getByRole('dialog').getByText(`blue-panda-bag.${domain.hostname}`, { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect(writes.at(-1)?.body).toEqual({ domainId: 'main', subdomain: 'blue-panda-bag' });
    await check(page.getByRole('button', { name: 'Create default address' })).toHaveCount(0);
    await check(page.getByText('192.0.2.1:28000', { exact: true }).first()).toBeVisible();
  });
  it('activates only on request and hides DNS actions for fixed static endpoints or unauthorized users', async () => {
    await open();
    await page.getByRole('button', { name: 'Create default address' }).click();
    expect(writes.at(-1)?.body).toEqual({});
    assignments = [];
    addressState = 'pending';
    await page.reload();
    await check(page.getByRole('button', { name: 'Create default address' })).toHaveCount(0);
    addressState = 'unconfigured';
    canManage = false;
    await page.reload();
    await check(page.getByRole('button', { name: 'Change address' })).toHaveCount(0);
    canManage = true;
    assignments = [];
    options.mode = 'static-host-port';
    options.customizable = false;
    await page.reload();
    await check(page.getByRole('button', { name: 'Create default address' })).toHaveCount(0);
  });
  it('confirms cancellation of uncertain addresses and makes a fresh choice possible', async () => {
    assignments = [
      { id: 'older', state: 'active', connection: { displayAddress: 'older.example.test' } },
      { id: 'blocked', state: 'uncertain', connection: { displayAddress: 'old.example.test' } },
    ];
    await open();
    await page.getByRole('button', { name: 'Remove address', exact: true }).click();
    await check(
      page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }),
    ).toBeFocused();
    expect(writes).toEqual([]);
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    expect(writes.at(-1)).toEqual({
      path: '/v1/servers/domain-fixture/dns/blocked',
      body: { confirm: true },
    });
    await check(page.getByRole('button', { name: 'Change address', exact: true })).toBeEnabled();
  });
  it('preserves legacy configuration and empty blacklist, and edits integration domain filtering', async () => {
    values = {
      dnsDomains: [],
      dnsBaseDomain: domain.hostname,
      cloudflareZoneId: domain.zoneId,
      dnsTarget: domain.target,
      dnsBlockedTerms: [],
      dnsGamePolicies: {},
    };
    await open('owner');
    await check(page.getByLabel('Domain', { exact: true })).toHaveValue(domain.hostname);
    await page.getByRole('button', { name: 'Save changes' }).first().click();
    expect((writes.at(-1)?.body as { dnsDomains: unknown[] } | undefined)?.dnsDomains).toEqual([
      { ...domain, id: 'legacy' },
    ]);
    expect(values.dnsBlockedTerms).toEqual([]);
    await page.getByText('Domains', { exact: true }).click();
    await page.getByLabel('Available domains').selectOption('allow');
    await page.getByRole('button', { name: domain.hostname, exact: true }).click();
    await page.getByRole('button', { name: 'Save changes' }).last().click();
    expect(values.dnsGamePolicies).toEqual({
      fixture: { selection: 'allow', domainIds: ['legacy'] },
    });
    await page.getByText('Blocked names', { exact: true }).click();
    await page.getByRole('button', { name: 'Add term' }).click();
    await page.getByLabel('Term', { exact: true }).fill('reserved');
    await page.getByLabel('Match', { exact: true }).selectOption('word');
    await page.getByRole('button', { name: 'Save changes' }).nth(1).click();
    expect(values.dnsBlockedTerms).toEqual([{ value: 'reserved', match: 'word' }]);
    await page.getByRole('heading').click();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/domains-owner-en.png',
      fullPage: true,
    });
  });
  it('respects environment locks and keeps desktop/mobile EN/IT accessible', async () => {
    lockedKeys = ['dnsDomains'];
    await open('owner');
    await check(page.getByLabel('Domain', { exact: true })).toBeDisabled();
    for (const locale of ['en', 'it']) {
      await page.evaluate((locale) => localStorage.setItem('nh.locale', locale), locale);
      await page.setViewportSize(
        locale === 'it' ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      );
      await open();
      await check(
        page.getByRole('button', {
          name: locale === 'en' ? 'Change address' : 'Modifica indirizzo',
        }),
      ).toBeVisible();
      expect(
        await page
          .locator('.connection-ports code')
          .first()
          .evaluate((element) => getComputedStyle(element).whiteSpace),
      ).toBe('nowrap');
      const axe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(axe.violations).toEqual([]);
      await page
        .getByRole('button', { name: locale === 'en' ? 'Change address' : 'Modifica indirizzo' })
        .focus();
      await page.keyboard.press('Enter');
      await check(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await check(page.getByRole('dialog')).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.getByRole('heading', { name: 'Domains fixture', exact: true }).click();
      await page.screenshot({
        path: `.codex/local/m5-browser/screenshots/domains-${locale}.png`,
        fullPage: true,
      });
    }
  });
});
