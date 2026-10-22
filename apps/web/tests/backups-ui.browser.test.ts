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
const fixture = (number = 1) => ({
  uuid: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  name: number === 1 ? 'Before world update' : 'Weekly snapshot',
  is_successful: true,
  is_locked: number === 2,
  ignored_files: [],
  checksum: 'fixture',
  bytes: 157286400,
  created_at: '2026-10-16T12:00:00Z',
  completed_at: '2026-10-16T12:01:00Z' as string | null,
});

describe('Backups interface (isolated API responses, real rendered component)', () => {
  let permissionKeys: string[] | undefined;
  let vite: ViteDevServer, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let backups: ReturnType<typeof fixture>[],
    writes: { method: string; body: Record<string, unknown> }[],
    errors: string[],
    fail: boolean,
    failList: boolean,
    running: boolean,
    required: boolean,
    limit: number,
    manage: boolean,
    listReads: number,
    jobState: string,
    activeOperationId: string | null,
    effectState: string | null,
    backupResult: {
      state: string;
      resume: string;
      cleanupFailed: boolean;
      retentionFailed: boolean;
    } | null;
  beforeAll(async () => {
    vite = await createServer({
      root: `${process.cwd()}/apps/web`,
      configFile: false,
      cacheDir: `${process.cwd()}/.codex/local/backups-ui-vite`,
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
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
    backups = [fixture(), fixture(2)];
    writes = [];
    errors = [];
    fail = false;
    failList = false;
    running = false;
    required = false;
    limit = 5;
    manage = true;
    permissionKeys = undefined;
    listReads = 0;
    jobState = 'queued';
    activeOperationId = null;
    effectState = null;
    backupResult = null;
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (!localStorage.getItem('nh.locale')) localStorage.setItem('nh.locale', 'en');
      class FixtureEvents {
        onopen?: () => void;
        onerror?: () => void;
        listener?: () => void;
        constructor() {
          (window as unknown as { backupEvents: FixtureEvents }).backupEvents = this;
          setTimeout(() => this.onopen?.(), 0);
        }
        addEventListener(_event: string, listener: () => void) {
          this.listener = listener;
        }
        close() {
          this.listener = undefined;
        }
      }
      Object.defineProperty(window, 'EventSource', { value: FixtureEvents });
    });
    await page.route('**/backups-fixture-page*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><head><title>Backups</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/backups-page.tsx"></script></body></html>',
      }),
    );
    await page.route('**/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname,
        method = route.request().method();
      if (path === '/v1/web/session') {
        const user = {
          id: 'fixture-user',
          name: 'Fixture owner',
          email: 'fixture@example.test',
          emailVerified: true,
          locale: 'en',
          role: 'owner',
          twoFactorEnabled: false,
        };
        return route.fulfill({
          json: {
            actor: user,
            subject: user,
            context: {
              actorUserId: user.id,
              subjectUserId: user.id,
              role: 'owner',
              sessionType: 'regular',
              ownerElevation: false,
            },
          },
        });
      }
      if (path.endsWith('/sleep-policy'))
        return route.fulfill({
          json: {
            policy: null,
            state: null,
            proposedPolicy: null,
            idleTimeout: null,
            policyControlsEditable: false,
          },
        });
      if (path.endsWith('/automation-consent'))
        return route.fulfill({
          json: {
            allowed: true,
            expectedIntent: 'fixture-intent',
            gatewayConfigured: true,
            gatewayEnabled: true,
            grantBlockedReason: null,
          },
        });
      if (path.endsWith('/schedules/preview'))
        return route.fulfill({
          json: { nextRuns: [new Date(Date.now() + 3600000).toISOString()] },
        });
      if (path.endsWith('/schedules') && method === 'GET') return route.fulfill({ json: [] });
      if (path.endsWith('/transfers'))
        return route.fulfill({
          json: {
            backups: {
              supported: true,
              canCreate: manage,
              canRestore: manage && !running,
              limit,
              policy: { offline: required ? 'required' : 'recommended' },
              events: true,
            },
          },
        });
      if (path === '/v1/platform/servers/backup-fixture')
        return route.fulfill({
          json: {
            name: 'Fixture server',
            capabilities: { backups: true },
            permissions: { manage },
            permissionKeys:
              permissionKeys ??
              (manage
                ? [
                    'backups.read',
                    'backups.create',
                    'backups.download',
                    'backups.restore',
                    'backups.delete',
                    'schedules.read',
                    'schedules.write',
                    'schedules.run',
                    'schedules.delete',
                    'settings.read',
                    'settings.write',
                  ]
                : ['backups.read', 'backups.download', 'schedules.read']),
            runtimeState: running ? 'running' : 'offline',
            activeOperationId,
          },
        });
      if (path.endsWith('/backups') && method === 'GET') {
        listReads++;
        return failList
          ? route.fulfill({ status: 503, json: { code: 'integration_unavailable' } })
          : route.fulfill({ json: backups });
      }
      if (path.startsWith('/v1/platform/jobs/'))
        return route.fulfill({
          json: {
            id: 'job-1',
            action: writes.at(-1)?.body.action ?? 'backup',
            state: jobState,
            phase: null,
            effectState,
            backupResult,
          },
        });
      if (method !== 'GET') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        writes.push({ method, body });
        if (fail) return route.fulfill({ status: 503, json: { code: 'integration_unavailable' } });
        if (path.endsWith('/operations')) return route.fulfill({ json: { jobId: 'job-1' } });
        const uuid = path.split('/').at(-1);
        if (method === 'PATCH')
          backups = backups.map((backup) =>
            backup.uuid === uuid
              ? {
                  ...backup,
                  ...(typeof body.name === 'string' ? { name: body.name } : {}),
                  ...(typeof body.isLocked === 'boolean' ? { is_locked: body.isLocked } : {}),
                }
              : backup,
          );
        if (method === 'DELETE') backups = backups.filter((backup) => backup.uuid !== uuid);
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ status: 404, json: { code: 'not_found' } });
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
  const open = async () => {
    await page.goto(`${origin}backups-fixture-page`);
    await check(page.getByText('Before world update', { exact: true })).toBeVisible();
  };
  const change = async () =>
    page.evaluate(() =>
      (window as unknown as { backupEvents: { listener?: () => void } }).backupEvents.listener?.(),
    );

  it('exposes only the additional backup action that a direct grant permits', async () => {
    manage = false;
    permissionKeys = ['backups.read', 'backups.delete'];
    await open();
    await check(
      page.getByRole('button', { name: 'Delete Before world update', exact: true }),
    ).toBeVisible();
    for (const name of [
      'Create backup',
      'Restore Before world update',
      'Download Before world update',
      'Rename Before world update',
    ])
      await check(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Delete Before world update', exact: true }).click();
    await check(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    expect(writes).toEqual([]);
  });

  it('renders responsive accessible EN/IT tables and locked actions', async () => {
    await open();
    await check(page.getByText('2 / 5 backups')).toBeVisible();
    await check(
      page.getByRole('button', { name: 'Unlock this backup before deleting it' }),
    ).toBeDisabled();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `${screenshots}/backups-desktop-en.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await check(page.getByRole('button', { name: 'Download Before world update' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `${screenshots}/backups-mobile-en.png`, fullPage: true });
    await page.evaluate(() => localStorage.setItem('nh.locale', 'it'));
    await page.reload();
    await check(page.getByRole('button', { name: 'Crea backup', exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `${screenshots}/backups-mobile-it.png`, fullPage: true });
  });

  it('creates with explicit offline interruption, exclusions and lock, retaining the job', async () => {
    running = true;
    await open();
    await page.getByRole('button', { name: 'Create backup', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await check(dialog.getByRole('radio', { name: /Stop for the backup/ })).toBeChecked();
    await dialog.getByRole('textbox', { name: 'Name (optional)' }).fill('Before upgrade');
    await dialog.getByLabel('Lock this backup against deletion').check();
    await dialog.getByText('Advanced options').click();
    await dialog.getByRole('textbox', { name: 'Excluded files' }).fill('logs/**\ncache/**');
    await page.screenshot({ path: `${screenshots}/backups-create-en.png`, fullPage: true });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await dialog.getByText('Advanced options').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${screenshots}/backups-create-mobile-en.png`, fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const reads = listReads;
    await dialog.getByRole('button', { name: 'Create backup', exact: true }).click();
    await check(page.getByRole('dialog')).toHaveCount(0);
    await check(page.getByRole('link', { name: 'View operation' })).toHaveAttribute(
      'href',
      '/activity/job-1',
    );
    await check(page.getByText('Queued', { exact: true })).toBeVisible();
    expect(writes[0]?.body).toMatchObject({
      action: 'backup',
      name: 'Before upgrade',
      ignored: 'logs/**\ncache/**',
      isLocked: true,
      mode: 'offline',
    });
    expect(writes[0]?.body.idempotencyKey).toBeTruthy();
    expect(listReads).toBeGreaterThan(reads);
    await page.screenshot({ path: `${screenshots}/backups-queued-en.png`, fullPage: true });
    effectState = 'uncertain';
    await change();
    await check(page.getByText('Outcome not confirmed')).toBeVisible();
    await page.screenshot({ path: `${screenshots}/backups-uncertain-en.png`, fullPage: true });
    jobState = 'succeeded';
    effectState = null;
    backups.push(fixture(3));
    await change();
    await check(page.getByText('3 / 5 backups')).toBeVisible();
  });

  it('enforces required offline policy and preserves failed creation drafts', async () => {
    running = true;
    required = true;
    fail = true;
    await open();
    await page.getByRole('button', { name: 'Create backup', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await check(dialog.getByRole('radio', { name: /Keep running/ })).toHaveCount(0);
    await dialog.getByRole('textbox', { name: 'Name (optional)' }).fill('Keep this draft');
    await dialog.getByRole('button', { name: 'Create backup', exact: true }).click();
    await check(dialog.getByRole('alert')).toBeVisible();
    await check(dialog.getByRole('textbox', { name: 'Name (optional)' })).toHaveValue(
      'Keep this draft',
    );
    expect(writes).toHaveLength(1);
    await page.screenshot({ path: `${screenshots}/backups-create-error-en.png`, fullPage: true });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await check(page.getByRole('button', { name: 'Create backup', exact: true })).toBeFocused();
  });

  it('restores with explicit file semantics and a pre-backup; Cancel starts focused', async () => {
    await open();
    await page.getByRole('button', { name: 'Restore Before world update' }).click();
    const dialog = page.getByRole('dialog');
    await check(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await check(dialog.getByRole('radio', { name: /Replace all files/ })).toBeChecked();
    await dialog.getByRole('radio', { name: /Keep extra files/ }).check();
    await dialog.getByLabel('Back up current files before restoring').check();
    await page.screenshot({ path: `${screenshots}/backups-restore-en.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${screenshots}/backups-restore-mobile-en.png`, fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await check(page.getByRole('dialog')).toHaveCount(0);
    expect(writes[0]?.body).toMatchObject({
      action: 'restore',
      backupId: fixture().uuid,
      confirm: true,
      truncate: false,
      backupBefore: true,
    });
  });

  it('renames, locks/unlocks and confirms deletion without false success', async () => {
    await open();
    await page.getByRole('button', { name: 'Rename Before world update' }).click();
    await page
      .getByRole('dialog')
      .getByRole('textbox', { name: 'Name', exact: true })
      .fill('Before update');
    await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
    await check(page.getByText('Before update', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Lock Before update', exact: true }).click();
    await check(
      page.getByRole('button', { name: 'Unlock Before update', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Unlock Before update', exact: true }).click();
    await page.getByRole('button', { name: 'Delete Before update', exact: true }).click();
    await check(page.getByRole('dialog').getByRole('button', { name: 'Cancel' })).toBeFocused();
    fail = true;
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await check(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    expect(backups).toHaveLength(2);
    fail = false;
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await check(page.getByRole('dialog')).toHaveCount(0);
    await check(page.getByText('1 / 5 backups')).toBeVisible();
    await check(page.getByRole('heading', { name: 'Backups', exact: true })).toBeFocused();
    expect(writes.map((write) => write.method)).toEqual([
      'PATCH',
      'PATCH',
      'PATCH',
      'DELETE',
      'DELETE',
    ]);
  });

  it('keeps stale rows during refresh errors and shows quota/permission restrictions', async () => {
    limit = 2;
    await open();
    await check(page.getByRole('button', { name: 'Create backup', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Restore Before world update' }).click();
    await check(
      page.getByRole('dialog').getByLabel('Back up current files before restoring'),
    ).toBeDisabled();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    failList = true;
    await change();
    await check(page.getByRole('alert')).toBeVisible();
    await check(page.getByText('Before world update', { exact: true })).toBeVisible();
    await page.screenshot({ path: `${screenshots}/backups-stale-error-en.png`, fullPage: true });
    failList = false;
    manage = false;
    await change();
    await check(page.getByRole('button', { name: 'Create backup', exact: true })).toHaveCount(0);
    await check(
      page.getByRole('button', { name: 'Delete Before world update', exact: true }),
    ).toHaveCount(0);
    await check(
      page.getByRole('button', { name: 'Download Before world update', exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: `${screenshots}/backups-read-only-en.png`, fullPage: true });
  });

  it('shows a newer server operation instead of a previously submitted job', async () => {
    await open();
    await page.getByRole('button', { name: 'Create backup', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Create backup', exact: true })
      .click();
    await check(page.getByRole('link', { name: 'View operation' })).toHaveAttribute(
      'href',
      '/activity/job-1',
    );
    jobState = 'succeeded';
    await change();
    activeOperationId = 'job-2';
    jobState = 'running';
    await change();
    await check(page.getByRole('link', { name: 'View operation' })).toHaveAttribute(
      'href',
      '/activity/job-2',
    );
  });

  it('separates a saved backup from restart and retention failures', async () => {
    await open();
    await page.getByRole('button', { name: 'Create backup', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Create backup', exact: true })
      .click();
    await check(page.getByText('Queued', { exact: true })).toBeVisible();
    jobState = 'failed';
    backupResult = {
      state: 'succeeded',
      resume: 'failed',
      cleanupFailed: false,
      retentionFailed: true,
    };
    await change();
    await check(page.getByText('The backup was saved.')).toBeVisible();
    await check(
      page.getByText('Server restart failed. Open the operation for details.'),
    ).toBeVisible();
    await check(
      page.getByText(
        'Older backups could not be removed. Check the operation and available backup slots.',
      ),
    ).toBeVisible();
    await page.screenshot({
      path: `${screenshots}/backups-partial-outcome-en.png`,
      fullPage: true,
    });
  });

  it('excludes failed backups from quota, hides generated IDs and supports an explicit live backup', async () => {
    limit = 2;
    running = true;
    backups[1] = {
      ...fixture(2),
      is_successful: false,
      is_locked: false,
      name: 'nickhosting-operation-00000000-0000-4000-8000-000000000002',
    };
    await open();
    await check(page.getByText('1 / 2 backups')).toBeVisible();
    await check(page.getByRole('cell', { name: /nickhosting-operation/ })).toHaveCount(0);
    await check(page.getByRole('cell', { name: /^Backup ·/ })).toBeVisible();
    await page.getByRole('button', { name: 'Create backup', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('radio', { name: /Keep running/ })
      .check();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Create backup', exact: true })
      .click();
    await check(page.getByRole('dialog')).toHaveCount(0);
    expect(writes[0]?.body).toMatchObject({ action: 'backup', mode: 'live', isLocked: false });
  });

  it('schedules backups with the selected mode and retention within the available capacity', async () => {
    limit = 5;
    await page.goto(`${origin}backups-fixture-page?page=automation`);
    await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Daily world backup');
    await dialog.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('interval');
    await dialog.getByRole('spinbutton', { name: 'Interval (minutes)', exact: true }).fill('1440');
    await dialog.getByRole('combobox', { name: 'Server during backup' }).selectOption('live');
    await dialog.locator('summary').click();
    const retention = dialog.getByRole('checkbox', { name: 'Remove older automatic backups' });
    await check(retention).not.toBeChecked();
    await retention.check();
    const keep = dialog.getByRole('spinbutton', { name: 'Successful backups to keep' });
    await check(keep).toHaveValue('4');
    await check(keep).toHaveAttribute('min', '1');
    await check(keep).toHaveAttribute('max', '4');
    await check(
      dialog.getByText(
        'Only successful automatic backups from this schedule are removed. Locked backups are retained.',
      ),
    ).toBeVisible();
    await keep.fill('5');
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect(writes).toHaveLength(0);
    expect(await keep.evaluate((input) => (input as HTMLInputElement).validity.rangeOverflow)).toBe(
      true,
    );
    await keep.fill('3');
    await page.screenshot({
      path: `${screenshots}/backups-schedule-retention-en.png`,
      fullPage: true,
    });
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await check(dialog).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: 'POST',
      body: {
        name: 'Daily world backup',
        action: 'backup',
        backupOptions: { mode: 'live' },
        retention: { enabled: true, keepLast: 3 },
        enabled: true,
        timing: { kind: 'interval', everySeconds: 86400 },
      },
    });
    expect(writes[0]?.body.timeZone).toEqual(expect.any(String));
  });

  it.each([0, 1])('schedules backups without retention when capacity is %s', async (capacity) => {
    limit = capacity;
    required = true;
    await page.goto(`${origin}backups-fixture-page?page=automation`);
    await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Automatic backup');
    const mode = dialog.getByRole('combobox', { name: 'Server during backup' });
    await check(mode).toHaveValue('auto');
    await check(mode.locator('option[value=live]')).toHaveCount(0);
    await dialog.locator('summary').click();
    await check(
      dialog.getByRole('checkbox', { name: 'Remove older automatic backups' }),
    ).toBeDisabled();
    await check(dialog.getByRole('spinbutton', { name: 'Successful backups to keep' })).toHaveCount(
      0,
    );
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await check(dialog).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toMatchObject({
      action: 'backup',
      backupOptions: { mode: 'auto' },
      retention: { enabled: false, keepLast: 7 },
    });
  });

  it('schedules offline backups with retention defaulting to seven when capacity permits', async () => {
    limit = 12;
    await page.goto(`${origin}backups-fixture-page?page=automation`);
    await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Offline backup');
    await dialog.getByRole('combobox', { name: 'Server during backup' }).selectOption('offline');
    await dialog.locator('summary').click();
    await dialog.getByRole('checkbox', { name: 'Remove older automatic backups' }).check();
    const keep = dialog.getByRole('spinbutton', { name: 'Successful backups to keep' });
    await check(keep).toHaveValue('7');
    await check(keep).toHaveAttribute('max', '11');
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await check(dialog).toHaveCount(0);
    expect(writes[0]?.body).toMatchObject({
      action: 'backup',
      backupOptions: { mode: 'offline' },
      retention: { enabled: true, keepLast: 7 },
    });
  });

  it('shows truthful empty, loading and running rows without a fake size', async () => {
    await page.route('**/v1/servers/backup-fixture/backups', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return route.fulfill({ json: backups });
    });
    backups = [];
    await page.goto(`${origin}backups-fixture-page`);
    await check(page.getByRole('status', { name: 'Loading…' })).toBeVisible();
    await page.screenshot({ path: `${screenshots}/backups-loading-en.png`, fullPage: true });
    await check(page.getByText('No backups yet', { exact: true })).toBeVisible();
    await page.screenshot({ path: `${screenshots}/backups-empty-en.png`, fullPage: true });
    backups = [{ ...fixture(), completed_at: null }];
    await change();
    await check(page.getByText('Running', { exact: true })).toBeVisible();
    await check(page.getByRole('cell', { name: '—', exact: true })).toBeVisible();
    await check(page.getByRole('button', { name: 'Download Before world update' })).toHaveCount(0);
  });
});
