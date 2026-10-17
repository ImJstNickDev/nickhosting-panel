import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { AxeBuilder } from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  expect as browserExpect,
  chromium,
  firefox,
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
      quotaSource: 'default',
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
  let previewRequests: Array<{ policy: StorageMode; defaultUserStorageMiB: number }>;
  let gatePreview: Promise<void> | undefined;
  let releasePreview: (() => void) | undefined;
  let activePreviews: number;
  let peakPreviews: number;
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
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    origin = server.resolvedUrls?.local[0] ?? '';
    if (!origin) throw new Error('Isolated Vite server has no origin');
    browser = await (process.env.NH_BROWSER === 'firefox' ? firefox : chromium).launch({
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
    gatePreview = undefined;
    releasePreview = undefined;
    activePreviews = 0;
    peakPreviews = 0;
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
        activePreviews += 1;
        peakPreviews = Math.max(peakPreviews, activePreviews);
        if (gatePreview) {
          const gate = gatePreview;
          gatePreview = undefined;
          await gate;
        }
        activePreviews -= 1;
        if (previewFails)
          return route.fulfill({
            status: 503,
            json: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
          });
        const next = structuredClone(draft);
        next.id = `transition-${previewRequests.length}`;
        next.policy = body.policy;
        next.defaultUserStorageMiB = body.defaultUserStorageMiB;
        for (const user of next.users)
          if (user.quotaSource === 'default') user.quotaMiB = body.defaultUserStorageMiB;
        if (body.policy === 'GLOBAL_POOL')
          for (const user of next.users) for (const item of user.servers) item.proposedDiskMiB = 0;
        state.transition = next;
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
          if (submitted.quotaMiB !== state.transition.defaultUserStorageMiB)
            user.quotaSource = 'override';
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
    releasePreview?.();
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
  async function openLimited() {
    state.transition = structuredClone(draft);
    await open();
    await browserExpect(panel().getByRole('heading', { name: 'Users and servers' })).toBeVisible();
  }
  const applyButton = () => panel().getByRole('button', { name: 'Apply changes', exact: true });
  const quotaInput = () => panel().getByLabel('Quota for Ada Rossi (GiB)');
  const diskInput = () => panel().getByLabel('Limit for Survival world (GiB)');
  async function returnToSettings() {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
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

  it('automatically verifies allocations, computes local changes and applies only verified drafts', async () => {
    await openLimited();
    await browserExpect(
      panel().getByRole('button', { name: /preview|measurements|Check occupied/i }),
    ).toHaveCount(0);
    await browserExpect(panel().getByText('Reserved: 9 GiB', { exact: true })).toBeVisible();
    await browserExpect(applyButton()).toBeDisabled();
    await quotaInput().fill('12');
    await diskInput().fill('3');
    await browserExpect(applyButton()).toBeDisabled();
    await diskInput().fill('5');
    await browserExpect(panel().getByText('Reserved: 10 GiB', { exact: true })).toBeVisible();
    await browserExpect(quotaInput()).toBeEnabled();
    await browserExpect(applyButton()).toBeEnabled();
    await panel().screenshot({ path: `${screenshots}/storage-compact-desktop-en.png` });
    await accessible();
    await applyButton().click();
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await accessible('dialog[open]');
    await page.keyboard.press('Escape');
    await browserExpect(applyButton()).toBeFocused();
    await applyButton().click();
    await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click();
    await browserExpect(panel().getByText('Verified: 0 of 1 servers.')).toBeVisible();
    await browserExpect(panel().getByRole('heading', { name: 'Users and servers' })).toBeFocused();
    expect(applies).toEqual([
      [
        {
          userId: 'test-user',
          quotaMiB: 12288,
          servers: [{ serverId: 'test-server', diskMiB: 5120 }],
        },
      ],
    ]);
    expect(peakPreviews).toBe(1);
    if (!state.transition) throw new Error('Missing transition');
    state.transition.status = 'completed';
    state.policy = 'PER_USER_BUDGET';
    await browserExpect(
      panel().getByText('Storage policy applied and server limits verified.'),
    ).toBeVisible({ timeout: 10000 });
  });

  it('renders cached data and coalesces slow responses without overwriting newer inputs', async () => {
    draft.users.push({
      userId: 'override-user',
      name: 'Sam Bianchi',
      quotaMiB: 32768,
      quotaSource: 'override',
      requiredMiB: 0,
      servers: [],
    });
    gatePreview = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    await openLimited();
    await expect.poll(() => previewRequests.length).toBe(1);
    await browserExpect(panel().getByText('Server files: 4 GiB', { exact: true })).toBeVisible();
    const defaultQuota = panel().getByLabel('Default quota per user (GiB)');
    await defaultQuota.fill('8');
    await defaultQuota.fill('12');
    await defaultQuota.fill('16');
    await diskInput().fill('6');
    await browserExpect(quotaInput()).toHaveValue('16');
    await browserExpect(panel().getByLabel('Quota for Sam Bianchi (GiB)')).toHaveValue('32');
    await browserExpect(applyButton()).toBeDisabled();
    await page.waitForTimeout(450);
    expect(previewRequests).toHaveLength(1);
    releasePreview?.();
    await expect.poll(() => previewRequests.length).toBe(2);
    await browserExpect(applyButton()).toBeEnabled();
    await browserExpect(defaultQuota).toHaveValue('16');
    await browserExpect(quotaInput()).toHaveValue('16');
    await browserExpect(diskInput()).toHaveValue('6');
    expect(previewRequests.map((entry) => entry.defaultUserStorageMiB)).toEqual([4096, 16384]);
    expect(peakPreviews).toBe(1);
    expect(applies).toEqual([]);
  });

  it('retains cached rows and edited values on failed background checks without stealing focus', async () => {
    previewFails = true;
    await openLimited();
    await quotaInput().fill('12');
    await browserExpect(panel().getByRole('alert')).toContainText(
      'This integration is unavailable.',
    );
    await browserExpect(quotaInput()).toHaveValue('12');
    await browserExpect(quotaInput()).toBeFocused();
    await browserExpect(applyButton()).toBeDisabled();
    previewFails = false;
    await panel().getByRole('button', { name: 'Try again', exact: true }).click();
    await browserExpect(applyButton()).toBeEnabled();
    await browserExpect(quotaInput()).toHaveValue('12');
  });

  it('recovers from a stale cached draft when another tab has a blocked transition', async () => {
    gatePreview = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    await openLimited();
    await expect.poll(() => previewRequests.length).toBe(1);
    await quotaInput().fill('12');
    state.transition = {
      ...structuredClone(draft),
      id: 'other-transition',
      status: 'blocked',
      defaultUserStorageMiB: 8192,
    };
    previewFails = true;
    releasePreview?.();
    await expect
      .poll(() => refreshRequests)
      .toContain('/v1/owner/storage-policy/other-transition/refresh');
    await browserExpect(panel().getByLabel('Storage limits', { exact: true })).toBeDisabled();
    await browserExpect(panel().getByLabel('Default quota per user (GiB)')).toHaveValue('8');
    await browserExpect(quotaInput()).toHaveValue('12');
    await browserExpect(
      panel().getByRole('button', { name: 'Apply revised allocations', exact: true }),
    ).toBeEnabled();
    expect(applies).toEqual([]);
  });

  it('allows an individual zero quota, restores finite drafts, and rejects a zero default', async () => {
    await openLimited();
    await quotaInput().fill('16');
    await diskInput().fill('6');
    await quotaInput().fill('0');
    await browserExpect(diskInput()).toHaveCount(0);
    expect(
      await quotaInput().evaluate((element: HTMLInputElement) => element.checkValidity()),
    ).toBe(true);
    await quotaInput().fill('16');
    await browserExpect(diskInput()).toHaveValue('6');
    await quotaInput().fill('0');
    const defaultQuota = panel().getByLabel('Default quota per user (GiB)');
    await defaultQuota.fill('0');
    expect(
      await defaultQuota.evaluate((element: HTMLInputElement) => element.checkValidity()),
    ).toBe(false);
    await browserExpect(applyButton()).toBeDisabled();
    await panel().getByLabel('Storage limits', { exact: true }).selectOption('GLOBAL_POOL');
    await browserExpect(applyButton()).toBeEnabled();
    await panel().getByLabel('Storage limits', { exact: true }).selectOption('PER_USER_BUDGET');
    await browserExpect(defaultQuota).toHaveValue('4');
    await browserExpect(applyButton()).toBeEnabled();
    await applyButton().click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply changes', exact: true })
      .click();
    await expect
      .poll(() => applies)
      .toEqual([
        [{ userId: 'test-user', quotaMiB: 0, servers: [{ serverId: 'test-server', diskMiB: 0 }] }],
      ]);
  });

  it('restores a finite safe proposal for a previously unlimited user and preserves explicit overrides', async () => {
    const user = draft.users[0];
    const server = user?.servers[0];
    if (!user || !server) throw new Error('Missing fixture');
    user.quotaMiB = 0;
    user.quotaSource = 'override';
    server.proposedDiskMiB = 0;
    await openLimited();
    await browserExpect(quotaInput()).toHaveValue('0');
    await panel().getByLabel('Default quota per user (GiB)').fill('24');
    await browserExpect(quotaInput()).toHaveValue('0');
    await quotaInput().fill('16');
    await browserExpect(diskInput()).toHaveValue('4.5');
    await browserExpect(applyButton()).toBeEnabled();
    await browserExpect(quotaInput()).toHaveValue('16');
  });

  it('steps whole GiB in native number fields and keeps zero-based Firefox arrows', async () => {
    await openLimited();
    const defaultQuota = panel().getByLabel('Default quota per user (GiB)');
    await defaultQuota.fill('4');
    await defaultQuota.press('ArrowDown');
    await browserExpect(defaultQuota).toHaveValue('3');
    await defaultQuota.press('ArrowUp');
    await browserExpect(defaultQuota).toHaveValue('4');
    await quotaInput().fill('12');
    await quotaInput().press('ArrowDown');
    await browserExpect(quotaInput()).toHaveValue('11');
    await diskInput().fill('6');
    await diskInput().press('ArrowDown');
    await browserExpect(diskInput()).toHaveValue('5');
    await diskInput().press('ArrowDown');
    await browserExpect(diskInput()).toHaveValue('4');
    await browserExpect(applyButton()).toBeDisabled();
    await browserExpect(diskInput()).toHaveAttribute('aria-invalid', 'true');
    expect(await diskInput().getAttribute('min')).toBe('0');
  });

  it('keeps missing readings unavailable and refreshes them when returning to the tab', async () => {
    const server = draft.users[0]?.servers[0];
    if (!server) throw new Error('Missing fixture');
    server.usageBytes = null;
    server.observedAt = null;
    server.minimumDiskMiB = null;
    server.proposedDiskMiB = null;
    await openLimited();
    await browserExpect(
      panel().getByText('Server files: Unavailable', { exact: true }),
    ).toBeVisible();
    await browserExpect(applyButton()).toBeDisabled();
    await browserExpect(diskInput()).toBeDisabled();
    server.usageBytes = 0;
    server.observedAt = date;
    server.minimumDiskMiB = 128;
    server.proposedDiskMiB = 128;
    await returnToSettings();
    await browserExpect(panel().getByText('Server files: 0 B', { exact: true })).toBeVisible();
    await browserExpect(applyButton()).toBeEnabled();
  });

  it('refreshes the same blocked plan after cleanup and preserves unsaved inputs', async () => {
    draft.status = 'blocked';
    const server = draft.users[0]?.servers[0];
    if (!server) throw new Error('Missing fixture');
    server.status = 'blocked';
    server.errorCode = 'integration_unavailable';
    await openLimited();
    await browserExpect(panel().getByLabel('Storage limits', { exact: true })).toBeDisabled();
    await quotaInput().fill('8');
    await diskInput().fill('2');
    const resume = panel().getByRole('button', { name: 'Apply revised allocations', exact: true });
    await browserExpect(resume).toBeDisabled();
    await browserExpect(
      panel().getByRole('link', { name: 'Files for Survival world (opens in a new tab)' }),
    ).toHaveAttribute('target', '_blank');
    refreshed = structuredClone(draft);
    const cleaned = refreshed.users[0]?.servers[0];
    if (!cleaned) throw new Error('Missing cleaned fixture');
    cleaned.usageBytes = 1024 ** 3;
    cleaned.minimumDiskMiB = 1152;
    cleaned.errorCode = null;
    await returnToSettings();
    await browserExpect(panel().getByText('Server files: 1 GiB', { exact: true })).toBeVisible();
    await browserExpect(quotaInput()).toHaveValue('8');
    await browserExpect(diskInput()).toHaveValue('2');
    await browserExpect(resume).toBeEnabled();
    expect(previewRequests).toEqual([]);
    expect(applies).toEqual([]);
    expect(refreshRequests.length).toBeGreaterThan(0);
    expect(
      refreshRequests.every((path) => path === '/v1/owner/storage-policy/transition-1/refresh'),
    ).toBe(true);
    await panel().screenshot({ path: `${screenshots}/storage-compact-blocked-en.png` });
    await accessible();
    await resume.click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply changes', exact: true })
      .click();
    await expect
      .poll(() => applies[0])
      .toEqual([
        {
          userId: 'test-user',
          quotaMiB: 8192,
          servers: [{ serverId: 'test-server', diskMiB: 2048 }],
        },
      ]);
  });

  it('retains edited allocations after apply failure and automatically reverifies before retry', async () => {
    await openLimited();
    await quotaInput().fill('16');
    await browserExpect(applyButton()).toBeEnabled();
    await applyButton().click();
    applyFails = true;
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply changes', exact: true })
      .click();
    await browserExpect(page.getByRole('dialog').getByRole('alert')).toContainText(
      'There is not enough available storage.',
    );
    await browserExpect(quotaInput()).toHaveValue('16');
    applyFails = false;
    await browserExpect(
      page.getByRole('dialog').getByRole('button', { name: 'Apply changes', exact: true }),
    ).toBeEnabled();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply changes', exact: true })
      .click();
    await expect.poll(() => applies.length).toBe(2);
    expect(applies[1]).toEqual(applies[0]);
  });

  it('automatically prepares recovery when a running application becomes blocked', async () => {
    await openLimited();
    await quotaInput().fill('12');
    await browserExpect(applyButton()).toBeEnabled();
    await applyButton().click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply changes', exact: true })
      .click();
    await browserExpect(panel().getByText('Verified: 0 of 1 servers.')).toBeVisible();
    if (!state.transition) throw new Error('Missing transition');
    state.transition.status = 'blocked';
    await expect.poll(() => refreshRequests.length, { timeout: 10000 }).toBeGreaterThan(0);
    await browserExpect(quotaInput()).toHaveValue('12');
    const resume = panel().getByRole('button', { name: 'Apply revised allocations', exact: true });
    await browserExpect(resume).toBeEnabled();
    await resume.click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply changes', exact: true })
      .click();
    await expect.poll(() => applies.length).toBe(2);
  });

  it('keeps explanations in accessible circular help controls and compacts Italian mobile rows', async () => {
    locale = 'it';
    state.transition = draft;
    await context.addInitScript(() => localStorage.setItem('nh.locale', 'it'));
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await panel().getByLabel('Quota di Ada Rossi (GiB)').fill('12');
    const info = panel().getByRole('button', { name: 'Informazioni sulla quota di Ada Rossi' });
    await info.focus();
    await browserExpect(page.getByRole('tooltip')).toContainText('Imposta 0');
    await page.keyboard.press('Escape');
    await browserExpect(page.getByRole('tooltip')).toHaveCount(0);
    await panel().getByLabel('Quota di Ada Rossi (GiB)').focus();
    await info.hover();
    await browserExpect(page.getByRole('tooltip')).toContainText('Imposta 0');
    await page.mouse.move(0, 0);
    await info.dispatchEvent('pointerdown', { pointerType: 'touch' });
    await browserExpect(page.getByRole('tooltip')).toContainText('Imposta 0');
    await info.dispatchEvent('pointerdown', { pointerType: 'touch' });
    await browserExpect(page.getByRole('tooltip')).toHaveCount(0);
    expect(
      await info.evaluate((element) => ({
        border: getComputedStyle(element).borderTopWidth,
        radius: getComputedStyle(element).borderRadius,
      })),
    ).toEqual({ border: '0px', radius: '50%' });
    await panel().screenshot({ path: `${screenshots}/storage-compact-mobile-it.png` });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await accessible();
  });

  it('automatically previews shared storage and has no generic storage/reset bypass', async () => {
    state.transition = { ...fixture('GLOBAL_POOL'), status: 'completed' };
    await open();
    await browserExpect(page.locator('.settings-list details')).toHaveCount(0);
    await browserExpect(diskInput()).toHaveCount(0);
    await browserExpect(applyButton()).toBeEnabled();
    await applyButton().click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Apply changes', exact: true })
      .click();
    await expect
      .poll(() => applies[0]?.[0]?.servers)
      .toEqual([{ serverId: 'test-server', diskMiB: 0 }]);
  });

  it('honors environment locks and operator read-only settings without starting previews', async () => {
    state.lockedKeys = ['storagePolicy'];
    state.transition = draft;
    await open();
    await browserExpect(applyButton()).toHaveCount(0);
    await browserExpect(quotaInput()).toBeDisabled();
    expect(previewRequests).toEqual([]);
    state.lockedKeys = [];
    role = 'operator';
    await page.reload();
    await browserExpect(panel().getByRole('button')).toHaveCount(0);
    await browserExpect(
      panel().getByText('Your role can view these settings. Only the Owner can change them.'),
    ).toBeVisible();
    expect(previewRequests).toEqual([]);
  });
});
