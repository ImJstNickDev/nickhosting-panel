import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 browser files, backups, console and automation', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let base: string;
  const errors: string[] = [];
  beforeAll(async () => {
    harness = await browserHarness();
    identities = await prepareJourneyIdentities(harness);
    user = identities.user;
    user.on('pageerror', (error) => errors.push(error.message));
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    base = `${harness.origin}/servers/${provider.ids.serverId}`;
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  function row(name: string) {
    return user.getByRole('row').filter({ has: user.getByRole('cell', { name, exact: true }) });
  }
  it('creates, edits, renames and deletes files with explicit consequences and restores keyboard focus', async () => {
    await user.goto(`${base}/files`);
    await user.getByRole('button', { name: 'New text file', exact: true }).click();
    const dialog = user.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('notes.txt');
    await dialog.getByLabel('Contents', { exact: true }).fill('Original world notes');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(row('notes.txt')).toBeVisible();
    expect((await provider.files()).get('notes.txt')?.toString()).toBe('Original world notes');
    await row('notes.txt').getByRole('button', { name: 'Edit', exact: true }).click();
    await dialog.getByLabel('Contents', { exact: true }).fill('Updated notes');
    user.once('dialog', (confirmation) => confirmation.dismiss());
    await user.keyboard.press('Escape');
    await browserExpect(dialog.getByLabel('Contents', { exact: true })).toHaveValue(
      'Updated notes',
    );
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(dialog).not.toBeVisible();
    expect((await provider.files()).get('notes.txt')?.toString()).toBe('Updated notes');
    await row('notes.txt').getByRole('button', { name: 'Rename', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('readme.txt');
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(row('readme.txt')).toBeVisible();
    await row('readme.txt').getByRole('button', { name: 'Delete', exact: true }).click();
    await browserExpect(dialog).toContainText('readme.txt');
    await user.keyboard.press('Escape');
    await browserExpect(dialog).not.toBeVisible();
    expect(await user.evaluate(() => document.activeElement?.textContent)).toBe('Delete');
    await harness.screenshot(user, 'files-desktop-en');
    const audit = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(audit.violations.map((v) => v.id)).toEqual([]);
  });
  it('streams a 12 MiB binary upload/download through actual handlers with identical bytes', async () => {
    await user.goto(`${base}/files`);
    const bytes = Buffer.alloc(12 * 1024 ** 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    await user.getByLabel('Choose file', { exact: true }).setInputFiles({
      name: 'world-export.bin',
      mimeType: 'application/octet-stream',
      buffer: bytes,
    });
    await user.getByRole('button', { name: 'Upload', exact: true }).click();
    await browserExpect(user.getByText('Upload completed', { exact: true })).toBeVisible();
    expect(
      createHash('sha256')
        .update((await provider.files()).get('world-export.bin')!)
        .digest('hex'),
    ).toBe(createHash('sha256').update(bytes).digest('hex'));
    const waiting = user.waitForEvent('download');
    await row('world-export.bin').getByRole('button', { name: 'Download', exact: true }).click();
    const result = await waiting;
    expect(result.url()).toContain('/v1/servers/');
    const file = await result.path();
    expect(file).toBeTruthy();
    expect(
      createHash('sha256')
        .update(await readFile(file!))
        .digest('hex'),
    ).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await user.context().cookies()).every((c) => !c.name.includes('pterodactyl'))).toBe(
      true,
    );
  });
  it('does not replace a second editor with a late first-file response', async () => {
    const files = await provider.files();
    files.set('first.txt', Buffer.from('First file'));
    files.set('second.txt', Buffer.from('Second file'));
    const original = provider.adapter.downloadFile;
    let release: () => void = () => {};
    let started: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    provider.adapter.downloadFile = async (id, name, input) => {
      if (name === 'first.txt') {
        started();
        await pending;
      }
      return original(id, name, input);
    };
    try {
      await user.reload();
      await row('first.txt').getByRole('button', { name: 'Edit', exact: true }).click();
      await began;
      await user.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await row('second.txt').getByRole('button', { name: 'Edit', exact: true }).click();
      await browserExpect(
        user.getByRole('dialog').getByLabel('Contents', { exact: true }),
      ).toHaveValue('Second file');
      release();
      await browserExpect(
        user.getByRole('dialog').getByLabel('Contents', { exact: true }),
      ).toHaveValue('Second file');
      await user.keyboard.press('Escape');
    } finally {
      release();
      provider.adapter.downloadFile = original;
    }
  });
  it('shows mediated console output, sends commands and presents actual telemetry units', async () => {
    await user.goto(`${base}/console`);
    await user.getByLabel('Command', { exact: true }).fill('list');
    await user.getByRole('button', { name: 'Send', exact: true }).click();
    await browserExpect(user.locator('.console pre')).toContainText(
      'There are 0 of a max of 20 players online',
    );
    await browserExpect(
      user.getByRole('heading', { name: 'Resource usage', exact: true }),
    ).toBeVisible();
    await browserExpect(user.locator('figure.metric-chart')).toHaveCount(4);
    await harness.screenshot(user, 'console-telemetry-desktop-en');
    const audit = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(audit.violations.map((v) => v.id)).toEqual([]);
  });
  it('creates a durable backup, confirms replacement and restores original file contents', async () => {
    const files = await provider.files();
    files.set('restore-proof.txt', Buffer.from('Before backup'));
    await user.goto(`${base}/backups`);
    await user.getByRole('button', { name: 'Create backup', exact: true }).click();
    await browserExpect(user.getByText('Operation requested', { exact: false })).toBeVisible();
    const progress = await provider.processPending();
    expect(
      progress.every((p) => p.result !== 'failed'),
      JSON.stringify(progress),
    ).toBe(true);
    files.set('restore-proof.txt', Buffer.from('After backup'));
    await user.reload();
    await user.getByRole('button', { name: 'Restore backup', exact: true }).click();
    const dialog = user.getByRole('dialog');
    await dialog.getByLabel('Confirm', { exact: true }).check();
    await dialog.getByRole('button', { name: 'Restore backup', exact: true }).click();
    await browserExpect(dialog).not.toBeVisible();
    const results = await provider.processPending();
    expect(
      results.every((p) => p.result !== 'failed'),
      JSON.stringify(results),
    ).toBe(true);
    expect((await provider.files()).get('restore-proof.txt')?.toString()).toBe('Before backup');
    await user.reload();
    await browserExpect(
      user.getByRole('button', { name: 'Restore backup', exact: true }),
    ).toBeVisible();
    await harness.screenshot(user, 'backups-desktop-en');
  });
  it('issues, rotates and revokes scoped SFTP credentials without claiming retained transport revocation', async () => {
    await user.goto(`${base}/sftp`);
    await user.getByRole('button', { name: 'Create SFTP credential', exact: true }).click();
    await browserExpect(user.getByLabel('Password', { exact: true })).not.toHaveValue('');
    await user.getByRole('button', { name: 'Close', exact: true }).click();
    const active = user
      .getByRole('row')
      .filter({ has: user.getByRole('button', { name: 'Rotate password', exact: true }) });
    await active.getByRole('checkbox').first().check();
    await active.getByRole('button', { name: 'Rotate password', exact: true }).click();
    await browserExpect(user.getByLabel('Password', { exact: true })).not.toHaveValue('');
    await user.getByRole('button', { name: 'Close', exact: true }).click();
    await active.getByLabel('Confirm', { exact: true }).check();
    await active.getByRole('button', { name: 'Revoke', exact: true }).click();
    await browserExpect(user.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
    await harness.screenshot(user, 'sftp-desktop-en');
  });
  it('persists schedules and explicit automation consent, and presents unavailable routing truthfully', async () => {
    await user.goto(`${base}/automation`);
    await user.getByRole('button', { name: 'Add schedule', exact: true }).click();
    const dialog = user.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('Daily backup');
    await dialog.getByLabel('Repeat', { exact: true }).selectOption('interval');
    await dialog.getByLabel('Interval (minutes)', { exact: true }).fill('1440');
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(user.getByText('Daily backup', { exact: true })).toBeVisible();
    await harness.screenshot(user, 'automation-desktop-en');
    await user.goto(`${base}/network`);
    await browserExpect(
      user.getByRole('cell', { name: 'Not configured', exact: true }).first(),
    ).toBeVisible();
    await browserExpect(user.getByText('games.example.test', { exact: false })).toHaveCount(0);
    await harness.screenshot(user, 'network-unavailable-desktop-en');
    provider.setProviderAvailable(false);
    await user.goto(`${base}/files`);
    await browserExpect(user.getByRole('alert').first()).toBeVisible();
    await harness.screenshot(user, 'files-provider-unavailable-desktop-en');
    provider.setProviderAvailable(true);
    expect(errors).toEqual([]);
  });
  it('shows partial reconciliation failures without claiming all providers were checked', async () => {
    const factory = provider.management.externalOptions.sftpFactory!;
    provider.management.externalOptions.sftpFactory = (...args) => ({
      ...factory(...args),
      ensureCredential: async () => {
        throw new Error('Isolated external provider outage');
      },
    });
    const failed = await user.request.post(
      `${harness.origin}/v1/servers/${provider.ids.serverId}/sftp`,
      { headers: { Origin: harness.origin }, data: { credentialId: randomUUID() } },
    );
    expect(failed.ok()).toBe(false);
    const original = provider.adapter.getApplicationServer;
    provider.adapter.getApplicationServer = async () => {
      throw new Error('Isolated provider observation unavailable');
    };
    try {
      const owner = identities.owner;
      await owner.goto(`${harness.origin}/owner/operations`);
      await owner.getByRole('button', { name: 'Check managed servers', exact: true }).click();
      await browserExpect(
        owner.getByText('These servers could not be checked:', { exact: true }),
      ).toBeVisible();
      await browserExpect(
        owner.getByText('External operations: 0 recovered, 1 failed.', { exact: true }),
      ).toBeVisible();
      await browserExpect(owner.getByText('Some checks failed.', { exact: false })).toBeVisible();
      await harness.screenshot(owner, 'owner-partial-reconciliation-desktop-en');
    } finally {
      provider.adapter.getApplicationServer = original;
      provider.management.externalOptions.sftpFactory = factory;
    }
  });

  it('keeps files, backups and telemetry usable in Italian mobile and pseudolocalized layouts', async () => {
    await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'it' });
    await user.setViewportSize({ width: 390, height: 844 });
    for (const [tab, label] of [
      ['files', 'Scegli file'],
      ['backups', 'Crea backup'],
      ['console', 'Comando'],
    ] as const) {
      await user.goto(`${base}/${tab}`);
      if (tab === 'backups')
        await browserExpect(user.getByRole('button', { name: label, exact: true })).toBeVisible();
      else await browserExpect(user.getByLabel(label, { exact: true })).toBeVisible();
      expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const axe = await new AxeBuilder({ page: user })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(axe.violations.map((v) => v.id)).toEqual([]);
      await harness.screenshot(user, `${tab}-mobile-it`);
    }
    const pseudo = await harness.page('pseudo', true);
    await pseudo.context().addCookies(await user.context().cookies());
    await pseudo.goto(`${base}/files`);
    await browserExpect(
      pseudo.getByRole('heading', { name: 'Survival', exact: true }),
    ).toBeVisible();
    await browserExpect(pseudo.locator('main')).toContainText('［');
    await browserExpect(pseudo.locator('input[type="file"]')).toBeVisible();
    await pseudo.setViewportSize({ width: 320, height: 800 });
    const tableRegion = pseudo.locator('section.table-scroll');
    await tableRegion.focus();
    expect(
      await pseudo
        .locator('.file-table tbody tr')
        .first()
        .evaluate((row) => row.getBoundingClientRect().height),
    ).toBeLessThan(110);
    await pseudo.keyboard.press('ArrowRight');
    await browserExpect
      .poll(() => tableRegion.evaluate((region) => region.scrollLeft))
      .toBeGreaterThan(0);
    await tableRegion.evaluate((region) => {
      region.scrollLeft = 0;
    });
    expect(await pseudo.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await harness.screenshot(pseudo, 'files-mobile-pseudo');
    await pseudo.context().close();
  });
});
