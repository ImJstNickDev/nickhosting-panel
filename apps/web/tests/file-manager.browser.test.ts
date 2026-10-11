import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 file manager interactions with isolated real API handlers', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let base: string;
  const errors: string[] = [];
  let editorRequests = 0;
  const stage = `./mountdata/test-assets/file-browser-${randomUUID()}`;
  beforeAll(async () => {
    harness = await browserHarness();
    harness.env.NH_FILE_OPERATIONS_ROOT = stage;
    const identities = await prepareJourneyIdentities(harness);
    user = identities.user;
    user.on('pageerror', (error) => errors.push(error.message));
    user.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/file-text-editor.tsx')) editorRequests++;
    });
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    const files = await provider.files();
    files.set('alpha.txt', Buffer.from('Alpha notes'));
    files.set('beta.json', Buffer.from('{"enabled":true}'));
    files.set('gamma.yaml', Buffer.from('enabled: true'));
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
    await rm(stage, { recursive: true, force: true });
  });
  const row = (name: string) =>
    user.locator('.fm-entry').filter({ has: user.getByRole('button', { name, exact: true }) });
  const dialog = () => user.getByRole('dialog');
  async function menu(name: string) {
    await row(name)
      .getByRole('button', { name: `Actions for ${name}`, exact: true })
      .click();
  }
  it('navigates breadcrumbs and direct paths, searches/sorts folders first, and switches grid without changing inventory', async () => {
    await user.goto(base);
    await browserExpect.poll(() => editorRequests).toBe(1);
    await browserExpect(user.locator('.fm-sort-arrow')).toHaveCount(0);
    await browserExpect(
      user.locator('.fm-column-button').getByText('Modified', { exact: true }),
    ).toBeVisible();
    await row('world').getByRole('button', { name: 'world', exact: true }).click();
    await browserExpect(user.getByRole('navigation', { name: 'File location' })).toContainText(
      'world',
    );
    await user.getByRole('button', { name: 'root', exact: true }).click();
    await user.getByRole('button', { name: 'Enter path (ALT + G)', exact: true }).click();
    await user.getByLabel('Path', { exact: true }).fill('/world');
    await user.getByLabel('Path', { exact: true }).press('Enter');
    await browserExpect(row('level.dat')).toBeVisible();
    await user.getByRole('button', { name: 'Parent folder', exact: true }).click();
    await user.getByLabel('Search this folder', { exact: true }).fill('BETA');
    await browserExpect(user.locator('.fm-entry')).toHaveCount(1);
    await browserExpect(row('beta.json')).toBeVisible();
    await user.getByLabel('Search this folder', { exact: true }).fill('');
    await user.getByRole('button', { name: 'Size', exact: true }).click();
    await browserExpect(user.locator('.fm-sort-arrow')).toHaveAttribute('data-order', 'ascending');
    await user.getByRole('button', { name: 'Size', exact: true }).click();
    await browserExpect(user.locator('.fm-sort-arrow')).toHaveAttribute('data-order', 'descending');
    await browserExpect(user.locator('.fm-entry').first()).toContainText('world');
    const count = await user.locator('.fm-entry').count();
    await user.getByRole('button', { name: 'Grid', exact: true }).click();
    await browserExpect(user.locator('.fm-grid')).toBeVisible();
    await browserExpect(user.locator('.fm-entry')).toHaveCount(count);
    await harness.screenshot(user, 'file-manager-grid-desktop-en');
    await user.getByRole('button', { name: 'List', exact: true }).click();
    await user.getByRole('button', { name: 'Name', exact: true }).click();
    await browserExpect(user.locator('.fm-sort-arrow')).toHaveCount(0);
    await user.getByRole('button', { name: 'Modified', exact: true }).focus();
    await user.keyboard.press('Enter');
    await browserExpect(user.locator('.fm-sort-arrow')).toHaveAttribute('data-order', 'ascending');
    await user.getByRole('button', { name: 'Name', exact: true }).click();
  });
  it('does not force tab focus after click or reload, while keeping keyboard navigation visible', async () => {
    await user.goto(base);
    const tabs = user.locator('.tabs');
    const filesTab = tabs.getByRole('link', { name: 'Files', exact: true });
    await tabs.getByRole('link', { name: 'Connection', exact: true }).click();
    await filesTab.click();
    await browserExpect(user.locator('.fm-tools')).toBeVisible();
    expect(await filesTab.evaluate((link) => link.matches(':focus-visible'))).toBe(false);
    await user.reload();
    await browserExpect(user.locator('.fm-tools')).toBeVisible();
    await browserExpect(filesTab).toHaveAttribute('aria-current', 'page');
    await browserExpect(filesTab).not.toBeFocused();
    expect(await filesTab.evaluate((link) => getComputedStyle(link).outlineStyle)).toBe('none');
    // Tab/Shift+Tab retain the native focus indicator without activating another route.
    await filesTab.click();
    await user.keyboard.press('Tab');
    await user.keyboard.press('Shift+Tab');
    await browserExpect(filesTab).toBeFocused();
    expect(await filesTab.evaluate((link) => link.matches(':focus-visible'))).toBe(true);
    expect(await filesTab.evaluate((link) => getComputedStyle(link).outlineStyle)).toBe('solid');
  });
  it('supports keyboard context menus, range selection, batch copy/move and streamed ZIP download', async () => {
    await row('alpha.txt').getByRole('button', { name: 'alpha.txt', exact: true }).focus();
    await user.keyboard.press('Shift+F10');
    await browserExpect(user.getByRole('menu')).toBeVisible();
    await user.keyboard.press('End');
    await browserExpect(user.getByRole('menuitem', { name: 'Delete', exact: true })).toBeFocused();
    await user.keyboard.press('Escape');
    await browserExpect(
      row('alpha.txt').getByRole('button', { name: 'alpha.txt', exact: true }),
    ).toBeFocused();
    await user.getByRole('checkbox', { name: 'Select alpha.txt', exact: true }).focus();
    await user.keyboard.press('Control+a');
    await browserExpect(
      user.getByRole('checkbox', { name: 'Select beta.json', exact: true }),
    ).toBeChecked();
    await user.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await user.getByRole('checkbox', { name: 'Select alpha.txt', exact: true }).check();
    await user
      .getByRole('checkbox', { name: 'Select gamma.yaml', exact: true })
      .click({ modifiers: ['Shift'] });
    await browserExpect(
      user.getByRole('checkbox', { name: 'Select beta.json', exact: true }),
    ).toBeChecked();
    const selection = user.getByRole('region', { name: 'Selected files' });
    await selection.getByRole('button', { name: 'Copy', exact: true }).click();
    await dialog().getByLabel('Destination folder', { exact: true }).fill('/world');
    await dialog().getByRole('button', { name: 'Copy', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect((await provider.files()).get('world/alpha.txt')?.toString()).toBe('Alpha notes');
    await menu('gamma.yaml');
    await user.getByRole('menuitem', { name: 'Move', exact: true }).click();
    // Copy already created this filename: refusing overwrite keeps both files intact.
    await dialog().getByLabel('Destination folder', { exact: true }).fill('/world');
    await dialog().getByRole('button', { name: 'Move', exact: true }).click();
    await browserExpect(dialog().getByRole('alert')).toBeVisible();
    await dialog().getByRole('button', { name: 'Close', exact: true }).click();
    await user.getByRole('checkbox', { name: 'Select alpha.txt', exact: true }).check();
    await user.getByRole('checkbox', { name: 'Select beta.json', exact: true }).check();
    const downloading = user.waitForEvent('download');
    await selection.getByRole('button', { name: 'Download ZIP', exact: true }).click();
    const downloaded = await downloading;
    const path = await downloaded.path();
    expect(path).toBeTruthy();
    const bytes = await readFile(path as string);
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.toString()).toContain('alpha.txt');
    expect(bytes.toString()).toContain('beta.json');
    (await provider.files()).set('selection.zip', bytes);
    await user.getByRole('button', { name: 'Clear selection', exact: true }).click();
  });
  it('extracts a ZIP into a new folder and moves files by folder and breadcrumb drops', async () => {
    await user.reload();
    await menu('selection.zip');
    await user.getByRole('menuitem', { name: 'Extract', exact: true }).click();
    await dialog().getByLabel('New destination folder', { exact: true }).fill('extracted');
    const extraction = user.waitForResponse(
      (response) =>
        response.url().endsWith('/files/extract') && response.request().method() === 'POST',
    );
    await dialog().getByRole('button', { name: 'Extract', exact: true }).click();
    const extracted = await extraction;
    expect(
      extracted.status(),
      JSON.stringify({ body: await extracted.json(), logs: harness.errors }),
    ).toBe(200);
    await browserExpect(dialog()).not.toBeVisible();
    expect((await provider.files()).get('extracted/alpha.txt')?.toString()).toBe('Alpha notes');
    await row('gamma.yaml').dragTo(row('extracted'));
    await browserExpect(dialog().getByLabel('Destination folder', { exact: true })).toHaveValue(
      '/extracted',
    );
    await dialog().getByRole('button', { name: 'Move', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect((await provider.files()).has('gamma.yaml')).toBe(false);
    await row('extracted').getByRole('button', { name: 'extracted', exact: true }).click();
    await row('gamma.yaml').dragTo(user.getByRole('button', { name: 'root', exact: true }));
    await browserExpect(dialog().getByLabel('Destination folder', { exact: true })).toHaveValue(
      '/',
    );
    await dialog().getByRole('button', { name: 'Move', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect((await provider.files()).has('gamma.yaml')).toBe(true);
    await user.getByRole('button', { name: 'root', exact: true }).click();
  });
  it('edits JSON with keyboard save and refuses concurrent overwrite while retaining the draft', async () => {
    const beforeNavigation = editorRequests;
    await user.goto(base);
    await browserExpect.poll(() => editorRequests).toBe(beforeNavigation + 1);
    const beforeEditor = editorRequests;
    await row('beta.json').getByRole('button', { name: 'beta.json', exact: true }).click();
    const editor = dialog().getByRole('textbox', { name: 'Contents', exact: true });
    await editor.fill('{"enabled":false}');
    await editor.press('Control+s');
    await browserExpect(dialog()).not.toBeVisible();
    expect((await provider.files()).get('beta.json')?.toString()).toBe('{"enabled":false}');
    await row('beta.json').getByRole('button', { name: 'beta.json', exact: true }).click();
    await editor.fill('{"local":true}');
    (await provider.files()).set('beta.json', Buffer.from('{"remote":true}'));
    await editor.press('Control+s');
    await browserExpect(dialog().getByRole('alert')).toContainText('changed after you opened');
    await browserExpect(editor).toContainText('"local":true');
    expect((await provider.files()).get('beta.json')?.toString()).toBe('{"remote":true}');
    expect(editorRequests).toBe(beforeEditor);
    await harness.screenshot(user, 'file-manager-editor-conflict-desktop-en');
    user.once('dialog', (confirmation) => confirmation.accept());
    await dialog().getByRole('button', { name: 'Close', exact: true }).click();
  });
  it('retains the open editor and prevents further editing until a save finishes', async () => {
    await user.goto(base);
    await row('alpha.txt').getByRole('button', { name: 'alpha.txt', exact: true }).click();
    const editor = dialog().getByRole('textbox', { name: 'Contents', exact: true });
    await editor.fill('Saved after pending request');
    let release: () => void = () => {};
    let started: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    await user.route('**/files/editor', async (route) => {
      if (route.request().method() === 'PUT') {
        started();
        await pending;
      }
      await route.continue();
    });
    try {
      await editor.press('Control+s');
      await began;
      await browserExpect(editor).toHaveAttribute('contenteditable', 'false');
      await dialog().getByRole('button', { name: 'Close', exact: true }).click();
      await browserExpect(dialog()).toBeVisible();
      await user.keyboard.press('Escape');
      await browserExpect(dialog()).toBeVisible();
      release();
      await browserExpect(dialog()).not.toBeVisible();
      expect((await provider.files()).get('alpha.txt')?.toString()).toBe(
        'Saved after pending request',
      );
    } finally {
      release();
      await user.unroute('**/files/editor');
    }
  });
  it('uploads multiple files sequentially and confirms replacement instead of silently overwriting', async () => {
    await user.goto(base);
    await browserExpect(user.getByRole('button', { name: 'Upload', exact: true })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    await user.getByLabel('Choose file', { exact: true }).setInputFiles([
      { name: 'upload-a.txt', mimeType: 'text/plain', buffer: Buffer.from('one') },
      { name: 'upload-b.txt', mimeType: 'text/plain', buffer: Buffer.from('two') },
    ]);
    await browserExpect(user.getByText('Completed', { exact: true })).toHaveCount(2);
    expect((await provider.files()).get('upload-a.txt')?.toString()).toBe('one');
    expect((await provider.files()).get('upload-b.txt')?.toString()).toBe('two');
    await user.getByLabel('Choose file', { exact: true }).setInputFiles({
      name: 'upload-a.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('replacement'),
    });
    await browserExpect(dialog()).toContainText('Existing content will be lost');
    expect((await provider.files()).get('upload-a.txt')?.toString()).toBe('one');
    await dialog().getByRole('button', { name: 'Replace and upload', exact: true }).click();
    await browserExpect(user.getByText('Completed', { exact: true })).toHaveCount(3);
    expect((await provider.files()).get('upload-a.txt')?.toString()).toBe('replacement');
    await user.getByRole('button', { name: 'Clear finished uploads', exact: true }).click();
  });
  it('uploads a whole folder with nested paths and rejects an existing folder without overwriting', async () => {
    await user.goto(base);
    const local = resolve(stage, 'client-pack');
    await mkdir(`${local}/nested/地図`, { recursive: true });
    await writeFile(`${local}/notes.txt`, 'folder notes');
    await writeFile(`${local}/nested/地図/data.bin`, Buffer.from([0, 255, 12, 7]));
    await writeFile(`${local}/empty.txt`, '');
    const picker = user.locator('input[webkitdirectory]');
    await browserExpect(
      user.getByRole('button', { name: 'Upload folder', exact: true }),
    ).toHaveAttribute('aria-disabled', 'false');
    await picker.setInputFiles(local);
    await browserExpect(user.getByText('Completed', { exact: true })).toHaveCount(3);
    const remote = await provider.files();
    expect(remote.get('client-pack/notes.txt')?.toString()).toBe('folder notes');
    expect(remote.get('client-pack/nested/地図/data.bin')).toEqual(Buffer.from([0, 255, 12, 7]));
    expect(remote.get('client-pack/empty.txt')).toEqual(Buffer.alloc(0));
    expect(remote.has('data.bin')).toBe(false);
    await browserExpect(
      user.getByRole('button', { name: 'Upload folder', exact: true }),
    ).toHaveAttribute('aria-disabled', 'false');
    await writeFile(`${local}/notes.txt`, 'must not overwrite');
    await picker.setInputFiles(local);
    await browserExpect(user.getByRole('alert')).toContainText('folder name already exists');
    expect(remote.get('client-pack/notes.txt')?.toString()).toBe('folder notes');
  });
  it('shows platform-specific search shortcuts and scopes them to Files outside dialogs', async () => {
    for (const platform of ['Win32', 'Linux x86_64', 'MacIntel']) {
      const page = await user.context().newPage();
      try {
        await page.addInitScript((value) => {
          Object.defineProperty(navigator, 'platform', { get: () => value });
        }, platform);
        await page.goto(base);
        const search = page.getByRole('searchbox', { name: 'Search this folder' });
        const mac = platform === 'MacIntel';
        const keys = mac ? 'Meta+k' : 'Control+k';
        await browserExpect(search).toHaveAttribute('placeholder', 'Search');
        await browserExpect(page.locator('.fm-search kbd')).toHaveText(mac ? '⌘ + K' : 'CTRL + K');
        await page.keyboard.press(keys);
        await browserExpect(search).toBeFocused();
        if (platform === 'Linux x86_64')
          await harness.screenshot(page, 'file-manager-search-focused-en');
        await search.fill('alpha');
        await page.keyboard.press(keys);
        expect(
          await search.evaluate((input: HTMLInputElement) => [
            input.selectionStart,
            input.selectionEnd,
          ]),
        ).toEqual([0, 5]);
        await page.keyboard.press('Alt+g');
        const path = page.getByRole('textbox', { name: 'Path', exact: true });
        await browserExpect(path).toBeFocused();
        await browserExpect(path).toHaveValue('/');
        if (platform === 'Linux x86_64')
          await harness.screenshot(page, 'file-manager-path-focused-en');
        await path.press('Escape');
        await page.getByRole('button', { name: 'New folder', exact: true }).click();
        const input = page.getByRole('dialog').getByRole('textbox').first();
        await input.focus();
        await page.keyboard.press(keys);
        await browserExpect(input).toBeFocused();
        await page.keyboard.press('Alt+g');
        await browserExpect(input).toBeFocused();
        await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
        await page.locator('.tabs').getByRole('link', { name: 'Console', exact: true }).click();
        await browserExpect(page.locator('.file-manager')).toHaveCount(0);
        expect(
          await page.evaluate((isMac) => {
            const event = new KeyboardEvent('keydown', {
              key: 'k',
              ctrlKey: !isMac,
              metaKey: isMac,
              bubbles: true,
              cancelable: true,
            });
            return document.dispatchEvent(event);
          }, mac),
        ).toBe(true);
      } finally {
        await page.close();
      }
    }
  });
  it('renders compact desktop and Italian mobile layouts with keyboard accessible controls and no axe violations', async () => {
    for (const locale of ['en', 'it'] as const) {
      await journeyRequest(harness, user, '/api/auth/update-user', { locale });
      await user.setViewportSize(
        locale === 'en' ? { width: 1440, height: 1000 } : { width: 390, height: 844 },
      );
      await user.goto(base);
      await browserExpect(user.locator('.fm-entry').first()).toBeVisible();
      expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const audit = await new AxeBuilder({ page: user })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        audit.violations.map((violation) => ({
          id: violation.id,
          nodes: violation.nodes.map((node) => node.target),
        })),
      ).toEqual([]);
      await harness.screenshot(
        user,
        `file-manager-${locale === 'en' ? 'desktop-en' : 'mobile-it'}`,
      );
    }
    expect(errors).toEqual([]);
  });
});
