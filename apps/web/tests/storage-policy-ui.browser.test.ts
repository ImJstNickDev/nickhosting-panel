import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { AxeBuilder } from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  expect as browserExpect,
  chromium,
  type Page,
} from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  StorageAllocation,
  StorageMode,
  StoragePolicyStatus,
  StorageTransition,
} from '../src/features/owner-storage-policy.api.js';

const screenshots = '.codex/local/m5-browser/screenshots';
const date = new Date().toISOString();
const fixture = (policy: StorageMode = 'PER_USER_BUDGET'): StorageTransition => ({
  id: 'transition-1',
  status: 'draft',
  policy,
  previousPolicy: 'GLOBAL_POOL',
  defaultUserStorageMiB: 4096,
  createdAt: date,
  updatedAt: date,
  errorCode: null,
  users: [
    {
      userId: 'test-user',
      name: 'Ada Rossi',
      quotaMiB: 4096,
      requiredMiB: 9216,
      servers: [
        {
          serverId: 'test-server',
          name: 'Survival world',
          usageBytes: 4 * 1024 ** 3,
          observedAt: date,
          currentDiskMiB: 0,
          minimumDiskMiB: 4608,
          proposedDiskMiB: policy === 'GLOBAL_POOL' ? 0 : 4608,
          backupSlots: 1,
          status: 'pending',
          errorCode: null,
        },
      ],
    },
  ],
});

describe('Owner storage policy guided UI (isolated API fixtures)', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let origin: string;
  let locale: 'en' | 'it';
  let role: 'owner' | 'operator';
  let state: StoragePolicyStatus;
  let draft: StorageTransition;
  let applies: StorageAllocation[][];
  let previewRequests: unknown[];
  let previewFails: boolean;
  let applyFails: boolean;
  let retryFails: boolean;
  let refreshFails: boolean;
  let refreshed: StorageTransition | undefined;
  let refreshRequests: string[];
  let errors: string[];

  beforeAll(async () => {
    server = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/storage-policy-test-vite`,
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    origin = server.resolvedUrls?.local[0] ?? '';
    if (!origin) throw new Error('Isolated Vite server has no origin');
    browser = await chromium.launch({
      headless: true,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${homedir()}/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu`,
      },
    });
    await mkdir(screenshots, { recursive: true });
  });
  beforeEach(async () => {
    locale = 'en';
    role = 'owner';
    applies = [];
    previewRequests = [];
    previewFails = false;
    applyFails = false;
    retryFails = false;
    refreshFails = false;
    refreshed = undefined;
    refreshRequests = [];
    errors = [];
    state = {
      policy: 'GLOBAL_POOL',
      defaultUserStorageMiB: 4096,
      lockedKeys: [],
      transition: null,
    };
    draft = fixture();
    context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const person = {
        id: 'storage-owner',
        name: 'Morgan Rossi',
        email: 'morgan@example.test',
        emailVerified: true,
        locale,
        role,
        twoFactorEnabled: false,
      };
      if (path === '/v1/web/config')
        return route.fulfill({
          json: { instanceName: 'NickHosting', defaultLocale: locale, auth: { email: true } },
        });
      if (path === '/v1/setup')
        return route.fulfill({ json: { ownerClaimed: true, completed: true } });
      if (path === '/v1/web/session')
        return route.fulfill({
          json: {
            context: {
              actorUserId: person.id,
              subjectUserId: person.id,
              role,
              sessionType: 'regular',
              ownerElevation: false,
            },
            actor: person,
            subject: person,
          },
        });
      if (path === '/v1/owner/settings/schema')
        return route.fulfill({
          json: {
            properties: {
              storagePolicy: { type: 'string', enum: ['GLOBAL_POOL', 'PER_USER_BUDGET'] },
              defaultUserStorageMiB: { type: 'number' },
              defaultServerStorageMiB: { type: 'number' },
            },
          },
        });
      if (path === '/v1/owner/settings')
        return route.fulfill({
          json: {
            config: {
              values: {
                storagePolicy: state.policy,
                defaultUserStorageMiB: state.defaultUserStorageMiB,
                defaultServerStorageMiB: 4096,
              },
              sources: {
                storagePolicy: 'database',
                defaultUserStorageMiB: 'database',
                defaultServerStorageMiB: 'database',
              },
              lockedKeys: state.lockedKeys,
            },
            secrets: [],
          },
        });
      if (path === '/v1/owner/storage-policy') return route.fulfill({ json: state });
      if (path === '/v1/owner/storage-policy/preview') {
        const body = route.request().postDataJSON();
        previewRequests.push(body);
        if (previewFails)
          return route.fulfill({
            status: 503,
            json: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
          });
        draft.policy = body.policy;
        draft.defaultUserStorageMiB = body.defaultUserStorageMiB;
        if (body.policy === 'GLOBAL_POOL')
          for (const user of draft.users) for (const item of user.servers) item.proposedDiskMiB = 0;
        state.transition = structuredClone(draft);
        return route.fulfill({ json: state.transition });
      }
      if (path.endsWith('/apply')) {
        applies.push(route.request().postDataJSON().users);
        if (applyFails)
          return route.fulfill({
            status: 409,
            json: { code: 'storage_exhausted', messageKey: 'errors.storage_exhausted' },
          });
        if (!state.transition) throw new Error('Missing preview');
        state.transition.status = 'applying';
        for (const user of state.transition.users) {
          const submitted = applies.at(-1)?.find((entry) => entry.userId === user.userId);
          if (!submitted) throw new Error('Missing submitted user');
          user.quotaMiB = submitted.quotaMiB;
          for (const item of user.servers)
            item.proposedDiskMiB =
              submitted.servers.find((entry) => entry.serverId === item.serverId)?.diskMiB ?? null;
        }
        return route.fulfill({ json: state.transition });
      }
      if (path.endsWith('/retry')) {
        if (retryFails)
          return route.fulfill({
            status: 503,
            json: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
          });
        return route.fulfill({ json: state.transition });
      }
      if (path.endsWith('/refresh')) {
        refreshRequests.push(path);
        if (refreshFails)
          return route.fulfill({
            status: 503,
            json: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
          });
        if (refreshed) state.transition = structuredClone(refreshed);
        return route.fulfill({ json: state.transition });
      }
      errors.push(`Unmocked request: ${method} ${path}`);
      return route.fulfill({ status: 404, json: { code: 'not_found' } });
    });
    await page.route('**/api/auth/**', (route) => route.fulfill({ json: [] }));
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  const panel = () => page.locator('.storage-policy');
  async function open() {
    await page.goto(`${origin}owner/settings`);
    await browserExpect(panel()).toBeVisible({ timeout: 30000 });
  }
  async function preview() {
    await panel().getByLabel('Storage limits', { exact: true }).selectOption('PER_USER_BUDGET');
    await panel().getByRole('button', { name: 'Check occupied space', exact: true }).click();
    await browserExpect(panel().getByRole('heading', { name: 'Review allocations' })).toBeVisible();
  }
  async function accessible(selector = '.storage-policy') {
    const result = await new AxeBuilder({ page })
      .include(selector)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
    ).toEqual([]);
  }

  it('resolves a 4 GiB user over quota, includes backup reservations, confirms and waits for completion', async () => {
    await open();
    await preview();
    await browserExpect(panel().getByText('Server files: 4 GiB', { exact: true })).toBeVisible();
    await browserExpect(
      panel().getByText('Reserved, including backups: 9 GiB', { exact: true }),
    ).toBeVisible();
    const reviewButton = panel().getByRole('button', { name: 'Review and apply', exact: true });
    await browserExpect(reviewButton).toBeDisabled();
    await page.screenshot({
      path: `${screenshots}/storage-preview-shortfall-desktop-en.png`,
      fullPage: true,
    });
    await accessible();
    await panel().getByLabel('Quota for Ada Rossi (GiB)').fill('12');
    await browserExpect(reviewButton).toBeEnabled();
    const disk = panel().getByLabel('Limit for Survival world (GiB)');
    await disk.fill('3');
    await browserExpect(reviewButton).toBeDisabled();
    await disk.fill('10');
    await browserExpect(reviewButton).toBeDisabled();
    await disk.fill('5');
    await browserExpect(reviewButton).toBeEnabled();
    await reviewButton.click();
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await accessible('dialog[open]');
    await page.keyboard.press('Escape');
    await browserExpect(reviewButton).toBeFocused();
    await reviewButton.click();
    await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click();
    await browserExpect(panel().getByText('Applying', { exact: true })).toBeVisible();
    expect(applies).toEqual([
      [
        {
          userId: 'test-user',
          quotaMiB: 12288,
          servers: [{ serverId: 'test-server', diskMiB: 5120 }],
        },
      ],
    ]);
    await browserExpect(
      panel().getByText('Storage policy applied and server limits verified.'),
    ).toHaveCount(0);
    if (!state.transition) throw new Error('Missing fixture transition');
    state.transition.status = 'completed';
    state.policy = 'PER_USER_BUDGET';
    await browserExpect(
      panel().getByText('Storage policy applied and server limits verified.'),
    ).toBeVisible({ timeout: 10000 });
    expect(previewRequests).toEqual([{ policy: 'PER_USER_BUDGET', defaultUserStorageMiB: 4096 }]);
  });

  it('never substitutes zero for a missing measurement and refreshes after cleanup', async () => {
    const item = draft.users[0]?.servers[0];
    if (!item) throw new Error('Missing fixture');
    item.usageBytes = null;
    item.observedAt = null;
    item.minimumDiskMiB = null;
    item.proposedDiskMiB = null;
    await open();
    await preview();
    await browserExpect(
      panel().getByText('Server files: Unavailable', { exact: true }),
    ).toBeVisible();
    await browserExpect(
      panel().getByRole('button', { name: 'Review and apply', exact: true }),
    ).toBeDisabled();
    await browserExpect(panel().getByLabel('Limit for Survival world (GiB)')).toBeDisabled();
    await page.screenshot({
      path: `${screenshots}/storage-preview-unavailable-en.png`,
      fullPage: true,
    });
    item.usageBytes = 0;
    item.observedAt = date;
    item.minimumDiskMiB = 128;
    item.proposedDiskMiB = 128;
    await panel().getByRole('button', { name: 'Refresh preview', exact: true }).click();
    await browserExpect(panel().getByText('Server files: 0 B', { exact: true })).toBeVisible();
    await browserExpect(
      panel().getByRole('button', { name: 'Review and apply', exact: true }),
    ).toBeEnabled();
  });

  it('preserves submitted allocations on apply failure and requires a fresh preview after settings change', async () => {
    await open();
    await preview();
    const quota = panel().getByLabel('Quota for Ada Rossi (GiB)');
    await quota.fill('16');
    await panel().getByRole('button', { name: 'Review and apply', exact: true }).click();
    applyFails = true;
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply changes', exact: true })
      .click();
    await browserExpect(page.getByRole('dialog').getByRole('alert')).toContainText(
      'There is not enough available storage.',
    );
    await browserExpect(quota).toHaveValue('16');
    await page.keyboard.press('Escape');
    await panel().getByLabel('Default quota per user (GiB)').fill('8');
    await browserExpect(
      panel().getByRole('button', { name: 'Review and apply', exact: true }),
    ).toBeDisabled();
    previewFails = true;
    await panel().getByRole('button', { name: 'Refresh preview', exact: true }).click();
    await browserExpect(panel().getByRole('alert')).toContainText(
      'This integration is unavailable.',
    );
    await browserExpect(panel().getByLabel('Default quota per user (GiB)')).toHaveValue('8');
    expect(applies).toHaveLength(1);
  });

  it('restores durable partial updates, offers revised allocations and displays retry failure', async () => {
    draft.status = 'blocked';
    const user = draft.users[0];
    const server = user?.servers[0];
    if (!user || !server) throw new Error('Missing fixture');
    user.quotaMiB = 12288;
    server.status = 'blocked';
    server.errorCode = 'integration_unavailable';
    state.transition = draft;
    retryFails = true;
    await open();
    await browserExpect(panel().getByText('Needs attention', { exact: true })).toBeVisible();
    await browserExpect(panel().getByLabel('Storage limits', { exact: true })).toBeDisabled();
    await panel().getByRole('button', { name: 'Recheck and retry', exact: true }).click();
    await browserExpect(panel().getByRole('alert')).toContainText(
      'This integration is unavailable.',
    );
    await panel().getByLabel('Quota for Ada Rossi (GiB)').fill('16');
    await panel().getByLabel('Limit for Survival world (GiB)').fill('6');
    await panel().getByRole('button', { name: 'Apply revised allocations', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply changes', exact: true })
      .click();
    expect(applies[0]).toEqual([
      {
        userId: 'test-user',
        quotaMiB: 16384,
        servers: [{ serverId: 'test-server', diskMiB: 6144 }],
      },
    ]);
  });

  it('shows Italian mobile allocations without overflow and verifies keyboard and accessibility', async () => {
    locale = 'it';
    state.transition = draft;
    await context.addInitScript(() => localStorage.setItem('nh.locale', 'it'));
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await browserExpect(panel().getByText('Quota superata di 5 GiB')).toBeVisible();
    await panel().getByLabel('Quota di Ada Rossi (GiB)').fill('12');
    await page.screenshot({ path: `${screenshots}/storage-preview-mobile-it.png`, fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await accessible();
  });

  it('remeasures a blocked plan after cleanup without applying or losing unsaved allocations', async () => {
    draft.status = 'blocked';
    const user = draft.users[0];
    const server = user?.servers[0];
    if (!user || !server) throw new Error('Missing fixture');
    server.status = 'blocked';
    server.errorCode = 'integration_unavailable';
    state.transition = structuredClone(draft);
    await open();
    const quota = panel().getByLabel('Quota for Ada Rossi (GiB)');
    const disk = panel().getByLabel('Limit for Survival world (GiB)');
    const apply = panel().getByRole('button', { name: 'Apply revised allocations', exact: true });
    const refresh = panel().getByRole('button', { name: 'Refresh measurements', exact: true });
    await browserExpect(panel().getByLabel('Storage limits', { exact: true })).toBeDisabled();
    await browserExpect(
      panel().getByRole('button', { name: 'Refresh preview', exact: true }),
    ).toHaveCount(0);
    await browserExpect(
      panel().getByRole('link', { name: 'Files for Survival world (opens in a new tab)' }),
    ).toHaveAttribute('href', '/servers/test-server/files');
    await browserExpect(
      panel().getByRole('link', { name: 'Files for Survival world (opens in a new tab)' }),
    ).toHaveAttribute('target', '_blank');
    await browserExpect(
      panel().getByRole('link', { name: 'Backups for Survival world (opens in a new tab)' }),
    ).toHaveAttribute('href', '/servers/test-server/backups');
    await quota.fill('8');
    await disk.fill('2');
    await browserExpect(apply).toBeDisabled();
    await browserExpect(refresh).toBeEnabled();
    refreshFails = true;
    await refresh.click();
    await browserExpect(panel().getByRole('alert')).toContainText(
      'This integration is unavailable.',
    );
    await browserExpect(quota).toHaveValue('8');
    await browserExpect(disk).toHaveValue('2');
    refreshFails = false;
    refreshed = structuredClone(draft);
    const cleaned = refreshed.users[0]?.servers[0];
    if (!cleaned) throw new Error('Missing refreshed server');
    cleaned.usageBytes = 1024 ** 3;
    cleaned.minimumDiskMiB = 1152;
    cleaned.observedAt = new Date(Date.now() + 5000).toISOString();
    cleaned.errorCode = null;
    await refresh.click();
    await browserExpect(panel().getByText('Server files: 1 GiB', { exact: true })).toBeVisible();
    await browserExpect(quota).toHaveValue('8');
    await browserExpect(disk).toHaveValue('2');
    await browserExpect(apply).toBeEnabled();
    await browserExpect(panel().getByText('Needs attention', { exact: true })).toBeVisible();
    expect(applies).toEqual([]);
    expect(previewRequests).toEqual([]);
    expect(refreshRequests).toEqual([
      '/v1/owner/storage-policy/transition-1/refresh',
      '/v1/owner/storage-policy/transition-1/refresh',
    ]);
    await page.screenshot({
      path: `${screenshots}/storage-blocked-cleanup-refreshed-en.png`,
      fullPage: true,
    });
    await accessible();
    await apply.click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply changes', exact: true })
      .click();
    expect(applies).toEqual([
      [
        {
          userId: 'test-user',
          quotaMiB: 8192,
          servers: [{ serverId: 'test-server', diskMiB: 2048 }],
        },
      ],
    ]);
    await browserExpect(panel().getByRole('link', { name: /Files for/ })).toHaveCount(0);
  });

  it('uses zero for unlimited server allocations and has no generic storage/reset bypass', async () => {
    await open();
    await browserExpect(page.locator('.settings-list details')).toHaveCount(0);
    await panel().getByRole('button', { name: 'Check occupied space', exact: true }).click();
    await browserExpect(panel().getByLabel('Limit for Survival world (GiB)')).toHaveCount(0);
    await panel().getByRole('button', { name: 'Review and apply', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply changes', exact: true })
      .click();
    expect(applies[0]?.[0]?.servers).toEqual([{ serverId: 'test-server', diskMiB: 0 }]);
  });

  it('honors environment locks and operator read-only settings', async () => {
    state.lockedKeys = ['storagePolicy'];
    state.transition = draft;
    await open();
    await browserExpect(panel().getByRole('button')).toHaveCount(0);
    await browserExpect(panel().getByLabel('Quota for Ada Rossi (GiB)')).toBeDisabled();
    state.lockedKeys = [];
    role = 'operator';
    await page.reload();
    await browserExpect(panel().getByRole('button')).toHaveCount(0);
    await browserExpect(
      panel().getByText('Your role can view these settings. Only the Owner can change them.'),
    ).toBeVisible();
  });
});
