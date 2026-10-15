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
  let displayAddress: string | null;
  let availabilityRequests: Array<{ domainId: string; subdomain: string }>;
  let releaseSlow: (() => void) | undefined;
  let reservationExpiry: string;
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
    displayAddress = '192.0.2.1:28000';
    availabilityRequests = [];
    releaseSlow = undefined;
    reservationExpiry = new Date(Date.now() + 15 * 60_000).toISOString();
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
      if (path === '/v1/games')
        return route.fulfill({
          json: [
            { id: 'minecraft', access: { canCreate: true }, manifest: { runtimes: ['vanilla'] } },
          ],
        });
      if (path === '/v1/platform/quotas')
        return route.fulfill({
          json: {
            remaining: { memoryMiB: 8192, cpuPercent: 400, storageMiB: null },
            storagePolicy: 'GLOBAL_POOL',
            creationStorage: { mode: 'shared', defaultDiskMiB: 4096 },
          },
        });
      if (path === '/v1/minecraft/choices')
        return route.fulfill({
          json: [
            {
              id: '10000000-0000-4000-8000-000000000001',
              version: '26.1',
              runtime: 'vanilla',
              capabilities: { playerManagement: true },
            },
          ],
        });
      if (path.endsWith('/connection-availability')) {
        const body = route.request().postDataJSON();
        availabilityRequests.push(body);
        if (body.subdomain === 'slow')
          await new Promise<void>((resolve) => {
            releaseSlow = resolve;
          });
        if (body.subdomain === 'unreachable')
          return route.fulfill({ status: 503, json: { code: 'integration_unavailable' } });
        return route.fulfill({
          json: {
            available: body.subdomain !== 'taken',
            hostname: `${body.subdomain}.${domain.hostname}`,
          },
        });
      }
      if (path.endsWith('/connection-reservation')) {
        const body = route.request().postDataJSON();
        writes.push({ path, body });
        return route.fulfill({
          json: {
            reservationId: '20000000-0000-4000-8000-000000000002',
            domainId: 'main',
            subdomain: body.subdomain,
            hostname: `${body.subdomain}.${domain.hostname}`,
            expiresAt: reservationExpiry,
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
                displayAddress,
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
    releaseSlow?.();
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
  it('debounces availability, blocks unchecked custom names, and never checks empty or invalid input', async () => {
    await open('availability');
    const input = page.getByLabel('Subdomain', { exact: true }),
      next = page.getByRole('button', { name: 'Next', exact: true });
    await check(input).toBeFocused();
    await check(next).toBeEnabled();
    await input.fill('one');
    await page.waitForTimeout(200);
    await input.fill('two');
    await page.waitForTimeout(250);
    expect(availabilityRequests).toEqual([]);
    await check(next).toBeDisabled();
    await check(page.locator('.connection-availability')).toHaveText('Available');
    expect(availabilityRequests).toEqual([{ domainId: 'main', subdomain: 'two' }]);
    await input.fill('bad-');
    await page.waitForTimeout(650);
    expect(availabilityRequests).toHaveLength(1);
    await check(next).toBeDisabled();
    await input.fill('');
    await check(next).toBeEnabled();
    await page.waitForTimeout(650);
    expect(availabilityRequests).toHaveLength(1);
    await input.press('Enter');
    await check(page.locator('output')).toHaveText('continued');
  });
  it('ignores late availability responses, does not retry errors or refetch on focus, and invalidates results on domain change', async () => {
    options.domains.push({ id: 'other', hostname: 'other.example.test' });
    await open('availability');
    const input = page.getByLabel('Subdomain', { exact: true }),
      next = page.getByRole('button', { name: 'Next', exact: true });
    await input.fill('slow');
    await check.poll(() => availabilityRequests.length).toBe(1);
    await input.fill('taken');
    await check(page.locator('.connection-availability')).toHaveText(
      'This name is already in use.',
    );
    releaseSlow?.();
    await page.waitForTimeout(100);
    await check(next).toBeDisabled();
    await check(page.locator('.connection-availability')).toHaveText(
      'This name is already in use.',
    );
    await input.fill('unreachable');
    await check(page.locator('.connection-availability')).toContainText(
      'Availability could not be checked',
    );
    const count = availabilityRequests.length;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(700);
    expect(availabilityRequests).toHaveLength(count);
    await input.fill('free');
    await check(page.locator('.connection-availability')).toHaveText('Available');
    await page.getByLabel('Domain', { exact: true }).selectOption('other');
    await check(next).toBeDisabled();
    await check(page.locator('.connection-availability')).toHaveText('Available');
    expect(availabilityRequests.at(-1)).toEqual({ domainId: 'other', subdomain: 'free' });
  });
  it('renders the SDK address step after version, reserves on Next and reuses the hold when navigating back', async () => {
    await open('wizard');
    await page.getByRole('button', { name: 'Minecraft', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByText('Vanilla', { exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByLabel('Server name', { exact: true }).fill('Island');
    await page.getByLabel('Server name', { exact: true }).press('Enter');
    await check(page.getByRole('heading', { name: 'Choose a version', exact: true })).toBeVisible();
    await page.getByText('26.1', { exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await check(
      page.getByRole('heading', { name: 'Choose an address', exact: true }),
    ).toBeVisible();
    const input = page.getByLabel('Subdomain', { exact: true });
    await check(input).toBeFocused();
    await input.fill('island');
    await check(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    await check(page.locator('.connection-availability')).toHaveText('Available');
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/address-wizard-en.png',
      fullPage: true,
    });
    await input.press('Enter');
    await check(
      page.getByRole('heading', { name: 'Who should be an operator?', exact: true }),
    ).toBeVisible();
    expect(writes.filter((entry) => entry.path.endsWith('/connection-reservation'))).toHaveLength(
      1,
    );
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await check(
      page.getByRole('heading', { name: 'Choose an address', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    expect(writes.filter((entry) => entry.path.endsWith('/connection-reservation'))).toHaveLength(
      1,
    );
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await input.fill('island-two');
    await check(page.locator('.connection-availability')).toHaveText('Available');
    await input.press('Enter');
    expect(writes.at(-1)?.body).toEqual({
      domainId: 'main',
      subdomain: 'island-two',
      previousReservationId: '20000000-0000-4000-8000-000000000002',
    });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.evaluate(() => {
      const original = Date.now.bind(Date);
      Date.now = () => original() + 16 * 60_000;
    });
    await page.getByRole('button', { name: 'Create server', exact: true }).click();
    await check(
      page.getByRole('heading', { name: 'Choose an address', exact: true }),
    ).toBeVisible();
    await check(page.getByRole('alert')).toContainText('Your address reservation expired');
  });
  it('keeps the address step usable on mobile in Italian with accessible status and keyboard controls', async () => {
    await page.addInitScript(() => localStorage.setItem('nh.locale', 'it'));
    await page.setViewportSize({ width: 390, height: 844 });
    await open('wizard');
    await page.getByRole('button', { name: 'Minecraft', exact: true }).click();
    await page.getByRole('button', { name: 'Avanti', exact: true }).click();
    await page.getByText('Vanilla', { exact: true }).click();
    await page.getByRole('button', { name: 'Avanti', exact: true }).click();
    await page.getByLabel('Nome del server', { exact: true }).fill('Isola');
    await page.getByLabel('Nome del server', { exact: true }).press('Enter');
    await page.getByText('26.1', { exact: true }).click();
    await page.getByRole('button', { name: 'Avanti', exact: true }).click();
    await check(
      page.getByRole('heading', { name: 'Scegli un indirizzo', exact: true }),
    ).toBeVisible();
    const input = page.getByLabel('Sottodominio', { exact: true });
    await check(input).toBeFocused();
    await input.fill('isola');
    await check(page.locator('.connection-availability')).toHaveText('Disponibile');
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/address-wizard-it-mobile.png',
      fullPage: true,
    });
    await input.fill('');
    await input.press('Enter');
    await check(
      page.getByRole('heading', { name: 'Chi sarà operatore?', exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([]);
  });
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
  it('shows DNS state without falling back to raw addresses in Network or Console', async () => {
    displayAddress = null;
    for (const [state, label] of [
      ['pending', 'Preparing address…'],
      ['uncertain', 'Address unavailable'],
    ] as const) {
      addressState = state;
      assignments = [
        { id: 'assignment', state, connection: { displayAddress: 'unconfirmed.example.test' } },
      ];
      for (const view of ['network', 'summary']) {
        await open(view);
        await check(page.getByText(label, { exact: true }).first()).toBeVisible();
        await check(page.locator('main')).not.toContainText('192.0.2.1');
        await check(page.locator('main')).not.toContainText('unconfirmed.example.test');
        if (state === 'uncertain')
          await page.screenshot({
            path: `.codex/local/m5-browser/screenshots/dns-unavailable-${view}.png`,
            fullPage: true,
          });
      }
    }
    displayAddress = 'old.example.test';
    for (const view of ['network', 'summary']) {
      await open(view);
      await check(page.getByText('old.example.test', { exact: true }).first()).toBeVisible();
    }
  });
  it('copies the console address with keyboard feedback and keeps connection settings separate', async () => {
    displayAddress = 'blue-panda-bag.games.example.test';
    addressState = 'active';
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => sessionStorage.setItem('copied-address', value),
        },
      });
    });
    await open('summary');
    const copy = page.locator('button.console-summary-address');
    await check(copy).toContainText(displayAddress);
    await copy.focus();
    await copy.press('Enter');
    await check
      .poll(() => page.evaluate(() => sessionStorage.getItem('copied-address')))
      .toBe(displayAddress);
    await check(page.getByRole('status')).toHaveText('Copied');
    await check(
      page.getByRole('link', { name: 'Connection settings', exact: true }),
    ).toHaveAttribute('href', '/servers/domain-fixture/network');
    await check(page.getByRole('status')).toHaveText('', { timeout: 4000 });
    await page.mouse.move(0, 0);
    await copy.blur();
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/console-address-en.png',
      fullPage: true,
    });
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('Clipboard denied');
          },
        },
      });
    });
    await copy.click();
    await check(page.getByRole('alert')).toContainText('Could not copy.');
    await check(page.getByRole('status')).toHaveText('');
    expect(writes).toEqual([]);
  });
  it('truncates long console hostnames on mobile, exposes their full value and localizes actions', async () => {
    displayAddress = `${'long-'.repeat(10)}hostname.games.example.test`;
    addressState = 'active';
    await page.addInitScript(() => localStorage.setItem('nh.locale', 'it'));
    await page.setViewportSize({ width: 390, height: 844 });
    await open('summary');
    const copy = page.locator('button.console-summary-address');
    await check(copy).toContainText(displayAddress);
    await check(
      page.getByRole('link', { name: 'Impostazioni connessione', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      await page
        .locator('.console-summary-address-text')
        .evaluate(
          (element) =>
            element.scrollWidth > element.clientWidth &&
            getComputedStyle(element).textOverflow === 'ellipsis',
        ),
    ).toBe(true);
    await copy.hover();
    await check(page.getByRole('tooltip')).toContainText(displayAddress);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: '.codex/local/m5-browser/screenshots/console-address-it-mobile.png',
      fullPage: true,
    });
    expect(writes).toEqual([]);
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
