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
  const editorView = () => user.getByRole('region', { name: 'Text editor', exact: true });
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
    await user.getByLabel('Path', { exact: true }).fill('/world/');
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
  it('reserves the Files viewport with accessible skeletons for initial and folder loads without hiding cached files', async () => {
    for (const locale of ['en', 'it'] as const) {
      await journeyRequest(harness, user, '/api/auth/update-user', { locale });
      await user.setViewportSize(
        locale === 'en' ? { width: 1440, height: 1000 } : { width: 390, height: 844 },
      );
      let release = () => {};
      let pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let blockedPath = '';
      const url = `**/v1/servers/${provider.ids.serverId}/files?*`;
      await user.route(url, async (route) => {
        if (new URL(route.request().url()).searchParams.get('path') === blockedPath) await pending;
        await route.continue();
      });
      try {
        await user.goto(base);
        const list = user.locator('.fm-list');
        const manager = user.locator('.file-manager');
        await browserExpect(list).toHaveAttribute('aria-busy', 'true');
        await browserExpect(list.locator('button, input, [tabindex]')).toHaveCount(0);
        const height = (await manager.boundingBox())?.height;
        expect(height).toBeGreaterThan(400);
        const status = manager.getByRole('status');
        await browserExpect(status).toHaveText(locale === 'en' ? 'Loading…' : 'Caricamento…');
        expect(await status.evaluate((element) => getComputedStyle(element).clipPath)).toBe(
          'inset(50%)',
        );
        expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        const audit = await new AxeBuilder({ page: user })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(audit.violations.map(({ id }) => id)).toEqual([]);
        await harness.screenshot(
          user,
          `file-skeleton-list-${locale === 'en' ? 'desktop-en' : 'mobile-it'}`,
        );
        release();
        await browserExpect(row('world')).toBeVisible();
        expect((await manager.boundingBox())?.height).toBe(height);
        // Revalidation keeps useful existing data, not skeleton rows.
        pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        await user
          .getByRole('button', {
            name: locale === 'en' ? 'Refresh files' : 'Aggiorna file',
            exact: true,
          })
          .click();
        await browserExpect(row('world')).toBeVisible();
        await browserExpect(user.locator('.fm-loading')).toHaveCount(0);
        release();
        // A new folder uses the current grid view while its listing is unknown.
        await user
          .getByRole('button', { name: locale === 'en' ? 'Grid' : 'Griglia', exact: true })
          .click();
        blockedPath = 'world';
        pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        const gridHeight = (await manager.boundingBox())?.height;
        await row('world').getByRole('button', { name: 'world', exact: true }).click();
        await browserExpect(user.locator('.fm-grid.fm-loading')).toBeVisible();
        expect((await manager.boundingBox())?.height).toBe(gridHeight);
        await browserExpect(list.getByRole('button')).toHaveCount(0);
        await harness.screenshot(
          user,
          `file-skeleton-grid-${locale === 'en' ? 'desktop-en' : 'mobile-it'}`,
        );
        release();
        await browserExpect(row('level.dat')).toBeVisible();
        expect((await manager.boundingBox())?.height).toBe(gridHeight);
      } finally {
        release();
        await user.unroute(url);
      }
    }
    await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'en' });
    await user.setViewportSize({ width: 1440, height: 1000 });
    expect(errors).toEqual([]);
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
    await user.goto(base);
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
  it('keeps bulk file actions compact and labelled across desktop and mobile with keyboard clear', async () => {
    try {
      for (const [locale, width] of [
        ['en', 1440],
        ['it', 390],
        ['it', 361],
        ['it', 320],
      ] as const) {
        await journeyRequest(harness, user, '/api/auth/update-user', { locale });
        await user.setViewportSize({ width, height: width > 760 ? 1000 : 844 });
        await user.goto(base);
        for (const name of ['alpha.txt', 'beta.json'])
          await user
            .getByRole('checkbox', {
              name: `${locale === 'it' ? 'Seleziona' : 'Select'} ${name}`,
              exact: true,
            })
            .check();
        const selection = user.getByRole('region', {
          name: locale === 'it' ? 'File selezionati' : 'Selected files',
        });
        await browserExpect(selection).toContainText(
          locale === 'it' ? '2 selezionati' : '2 selected',
        );
        await browserExpect(selection.getByRole('button')).toHaveCount(5);
        const labels =
          locale === 'it'
            ? ['Scarica ZIP', 'Sposta', 'Copia', 'Elimina', 'Deseleziona']
            : ['Download ZIP', 'Move', 'Copy', 'Delete', 'Clear selection'];
        for (const label of labels) {
          const button = selection.getByRole('button', { name: label, exact: true });
          await browserExpect(button).toBeVisible();
          expect(await button.innerText()).toBe('');
          await browserExpect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true');
        }
        const remove = selection.getByRole('button', {
          name: locale === 'it' ? 'Elimina' : 'Delete',
          exact: true,
        });
        await remove.hover();
        await browserExpect(user.getByRole('tooltip')).toHaveText(
          locale === 'it' ? 'Elimina' : 'Delete',
        );
        expect(await remove.evaluate((button) => getComputedStyle(button).color)).toBe(
          'rgb(155, 32, 32)',
        );
        await user.mouse.move(0, 0);
        const rect = await selection.boundingBox();
        expect(rect?.height).toBeLessThanOrEqual(width > 360 ? 48 : 88);
        expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        const audit = await new AxeBuilder({ page: user })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          audit.violations.map(({ id, nodes }) => ({
            id,
            nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
          })),
        ).toEqual([]);
        if (width === 1440 || width === 390)
          await harness.screenshot(
            user,
            `file-selection-toolbar-${locale === 'it' ? 'mobile-it' : 'desktop-en'}`,
          );
        await remove.click();
        await browserExpect(dialog()).toBeVisible();
        await browserExpect(dialog()).toContainText('alpha.txt');
        await browserExpect(dialog()).toContainText('beta.json');
        await dialog()
          .getByRole('button', { name: locale === 'it' ? 'Chiudi' : 'Close', exact: true })
          .click();
        const clear = selection.getByRole('button', {
          name: locale === 'it' ? 'Deseleziona' : 'Clear selection',
          exact: true,
        });
        await clear.focus();
        await browserExpect(user.getByRole('tooltip')).toHaveText(
          locale === 'it' ? 'Deseleziona' : 'Clear selection',
        );
        await clear.press('Enter');
        await browserExpect(selection).toHaveCount(0);
        const first = user.getByRole('checkbox', {
          name: `${locale === 'it' ? 'Seleziona' : 'Select'} alpha.txt`,
          exact: true,
        });
        await browserExpect(first).not.toBeChecked();
        await browserExpect(first).toBeFocused();
      }
    } finally {
      await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'en' });
      await user.setViewportSize({ width: 1440, height: 1000 });
    }
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
    await browserExpect(row('gamma.yaml')).toHaveCount(0);
    await browserExpect(dialog()).not.toBeVisible();
    expect((await provider.files()).has('gamma.yaml')).toBe(false);
    await row('extracted').getByRole('button', { name: 'extracted', exact: true }).click();
    await row('gamma.yaml').dragTo(user.getByRole('button', { name: 'root', exact: true }));
    await browserExpect(row('gamma.yaml')).toHaveCount(0);
    await browserExpect(dialog()).not.toBeVisible();
    expect((await provider.files()).has('gamma.yaml')).toBe(true);
    await user.getByRole('button', { name: 'root', exact: true }).click();
  });
  it('asks only for file collisions on drop, supports cancellation and scopes overwrite to freshly confirmed names', async () => {
    await journeyRequest(harness, user, `/v1/servers/${provider.ids.serverId}/files`, {
      action: 'mkdir',
      root: '',
      name: 'drop-target',
    });
    const remote = await provider.files();
    remote.set('move-a.txt', Buffer.from('new a'));
    remote.set('move-b.txt', Buffer.from('new b'));
    remote.set('drop-target/move-a.txt', Buffer.from('old a'));
    const selectAndDrop = async (italian = false) => {
      await user
        .getByRole('checkbox', {
          name: `${italian ? 'Seleziona' : 'Select'} move-a.txt`,
          exact: true,
        })
        .check();
      await user
        .getByRole('checkbox', {
          name: `${italian ? 'Seleziona' : 'Select'} move-b.txt`,
          exact: true,
        })
        .check();
      await row('move-a.txt').dragTo(row('drop-target'));
    };
    for (const locale of ['en', 'it'] as const) {
      await journeyRequest(harness, user, '/api/auth/update-user', { locale });
      await user.setViewportSize(
        locale === 'it' ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      );
      await user.goto(base);
      await selectAndDrop(locale === 'it');
      await browserExpect(dialog()).toHaveAccessibleName(
        locale === 'it'
          ? 'File con lo stesso nome presente in drop-target'
          : 'A file with the same name exists in drop-target',
      );
      await browserExpect(dialog().getByRole('button')).toHaveCount(2);
      const cancel = dialog().getByRole('button', {
        name: locale === 'it' ? 'Annulla' : 'Cancel',
        exact: true,
      });
      await browserExpect(cancel).toBeFocused();
      const overwrite = dialog().getByRole('button', {
        name: locale === 'it' ? 'Sovrascrivi' : 'Overwrite',
        exact: true,
      });
      await browserExpect(overwrite).toHaveClass('danger');
      expect(
        await dialog()
          .getByRole('heading')
          .evaluate((heading) => getComputedStyle(heading).textAlign),
      ).toBe('center');
      expect(
        await dialog()
          .getByRole('heading')
          .evaluate((heading) => Number.parseFloat(getComputedStyle(heading).fontSize)),
      ).toBeGreaterThanOrEqual(24);
      expect((await overwrite.boundingBox())?.height).toBeGreaterThanOrEqual(48);
      expect(remote.get('drop-target/move-a.txt')?.toString()).toBe('old a');
      expect(remote.has('move-a.txt')).toBe(true);
      const audit = await new AxeBuilder({ page: user })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(audit.violations.map(({ id }) => id)).toEqual([]);
      await harness.screenshot(
        user,
        `file-drop-collision-${locale === 'it' ? 'mobile-it' : 'desktop-en'}`,
      );
      await cancel.click();
      await browserExpect(dialog()).not.toBeVisible();
      expect(remote.get('drop-target/move-a.txt')?.toString()).toBe('old a');
      expect(remote.has('move-b.txt')).toBe(true);
    }
    await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'en' });
    await user.setViewportSize({ width: 1440, height: 1000 });
    await user.goto(base);
    await selectAndDrop();
    await browserExpect(dialog()).toBeVisible();
    // A new conflict after the first prompt requires another explicit confirmation.
    remote.set('drop-target/move-b.txt', Buffer.from('old b'));
    await dialog().getByRole('button', { name: 'Overwrite', exact: true }).click();
    await browserExpect(dialog()).toHaveAccessibleName(
      'Files with the same names exist in drop-target',
    );
    expect(remote.get('drop-target/move-a.txt')?.toString()).toBe('old a');
    expect(remote.get('drop-target/move-b.txt')?.toString()).toBe('old b');
    await dialog().getByRole('button', { name: 'Overwrite', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect(remote.get('drop-target/move-a.txt')?.toString()).toBe('new a');
    expect(remote.get('drop-target/move-b.txt')?.toString()).toBe('new b');
    expect(remote.has('move-a.txt')).toBe(false);
    expect(remote.has('move-b.txt')).toBe(false);
    // Existing folder collisions are not converted into recursive deletion/replacement.
    await journeyRequest(harness, user, `/v1/servers/${provider.ids.serverId}/files`, {
      action: 'mkdir',
      root: '',
      name: 'drop-folder',
    });
    await user.getByRole('button', { name: 'Refresh files', exact: true }).click();
    await row('drop-folder').dragTo(row('drop-target'));
    await browserExpect(row('drop-folder')).toHaveCount(0);
    await journeyRequest(harness, user, `/v1/servers/${provider.ids.serverId}/files`, {
      action: 'mkdir',
      root: '',
      name: 'drop-folder',
    });
    await user.getByRole('button', { name: 'Refresh files', exact: true }).click();
    await row('drop-folder').dragTo(row('drop-target'));
    await browserExpect(user.getByRole('alert')).toContainText(
      'A folder, link or differently capitalized name already exists',
    );
    await browserExpect(dialog()).not.toBeVisible();
  });
  it('requests consent when a collision appears after drop preflight without replaying the move', async () => {
    await journeyRequest(harness, user, `/v1/servers/${provider.ids.serverId}/files`, {
      action: 'mkdir',
      root: '',
      name: 'late-target',
    });
    const remote = await provider.files();
    remote.set('late-drop.txt', Buffer.from('source'));
    let attempts = 0;
    let failOverwrite = false;
    await user.route('**/files', async (route) => {
      if (
        route.request().method() === 'POST' &&
        route.request().postDataJSON()?.action === 'rename'
      ) {
        attempts++;
        if (failOverwrite)
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: 'integration_unavailable',
                messageKey: 'errors.integration_unavailable',
              },
            },
          });
        remote.set('late-target/late-drop.txt', Buffer.from('appeared after preflight'));
      }
      await route.continue();
    });
    try {
      await user.goto(base);
      await row('late-drop.txt').dragTo(row('late-target'));
      await browserExpect(dialog()).toHaveAccessibleName(
        'A file with the same name exists in late-target',
      );
      expect(attempts).toBe(1);
      expect(remote.get('late-drop.txt')?.toString()).toBe('source');
      expect(remote.get('late-target/late-drop.txt')?.toString()).toBe('appeared after preflight');
      await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(attempts).toBe(1);
      failOverwrite = true;
      await row('late-drop.txt').dragTo(row('late-target'));
      await dialog().getByRole('button', { name: 'Overwrite', exact: true }).click();
      await browserExpect(dialog().getByRole('alert')).toBeVisible();
      await browserExpect(
        dialog().getByRole('button', { name: 'Cancel', exact: true }),
      ).toBeEnabled();
      expect(attempts).toBe(2);
      expect(remote.get('late-drop.txt')?.toString()).toBe('source');
      expect(remote.get('late-target/late-drop.txt')?.toString()).toBe('appeared after preflight');
      await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(attempts).toBe(2);
    } finally {
      await user.unroute('**/files');
    }
  });
  it('opens text inline with a stable skeleton and preserves dirty edits across breadcrumb and app navigation', async () => {
    for (const locale of ['en', 'it'] as const) {
      await journeyRequest(harness, user, '/api/auth/update-user', { locale });
      await user.setViewportSize(
        locale === 'en' ? { width: 1440, height: 1000 } : { width: 390, height: 844 },
      );
      await user.goto(base);
      const manager = user.locator('.file-manager');
      await browserExpect(row('beta.json')).toBeVisible();
      let release = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await user.route('**/files/editor?*', async (route) => {
        await pending;
        await route.continue();
      });
      try {
        await row('beta.json').getByRole('button', { name: 'beta.json', exact: true }).focus();
        await user.keyboard.press('Enter');
        await browserExpect(user.locator('.fm-editor-view')).toBeFocused();
        await browserExpect(user.getByRole('dialog')).toHaveCount(0);
        const view = user.locator('.fm-editor-view');
        await browserExpect(view.locator('.fm-editor-skeleton')).toHaveAttribute(
          'aria-busy',
          'true',
        );
        const rect = await view.boundingBox();
        await browserExpect(user.locator('.fm-tools,.fm-search,.fm-view')).toHaveCount(0);
        await browserExpect(view.getByRole('textbox')).toHaveCount(0);
        await harness.screenshot(
          user,
          `file-inline-editor-loading-${locale === 'en' ? 'desktop-en' : 'mobile-it'}`,
        );
        release();
        const editor = view.getByRole('textbox', {
          name: locale === 'en' ? 'Contents' : 'Contenuto',
          exact: true,
        });
        await browserExpect(editor).toContainText('enabled');
        await browserExpect(editor).toBeFocused();
        expect((await view.boundingBox())?.height).toBe(rect?.height);
        const toolbar = user.getByRole('toolbar', {
          name: locale === 'en' ? 'Text editor' : 'Editor di testo',
          exact: true,
        });
        expect(
          await toolbar
            .getByRole('button')
            .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
        ).toEqual(
          locale === 'en'
            ? ['Back to files', 'Save changes', 'Undo', 'Redo', 'Find']
            : ['Torna ai file', 'Salva modifiche', 'Annulla', 'Ripristina', 'Cerca'],
        );
        await user.keyboard.press('Control+f');
        await browserExpect(user.locator('.fm-search-panel input[name="search"]')).toBeFocused();
        const searchPanel = user.getByRole('search', {
          name: locale === 'en' ? 'Find' : 'Cerca',
          exact: true,
        });
        await searchPanel
          .getByRole('textbox', { name: locale === 'en' ? 'Find' : 'Cerca', exact: true })
          .fill('enabled');
        await browserExpect(searchPanel.locator('output')).toHaveText('0 / 1');
        await searchPanel
          .getByRole('button', { name: locale === 'en' ? 'Next' : 'Successivo', exact: true })
          .click();
        await browserExpect(searchPanel.locator('output')).toHaveText('1 / 1');
        await browserExpect(searchPanel.getByRole('checkbox')).toHaveCount(0);
        await searchPanel
          .getByRole('button', {
            name: locale === 'en' ? 'Match case' : 'Maiuscole e minuscole',
            exact: true,
          })
          .click();
        await browserExpect(
          searchPanel.getByRole('button', {
            name: locale === 'en' ? 'Match case' : 'Maiuscole e minuscole',
            exact: true,
          }),
        ).toHaveAttribute('aria-pressed', 'true');
        await user.mouse.move(0, 0);
        await browserExpect(user.getByRole('tooltip')).toHaveCount(0);
        // The query/content belong to isolated fixtures, so keep the search field visible for UX review.
        await user.screenshot({
          path: resolve(
            '.codex/local/m5-browser/screenshots',
            `file-inline-editor-search-${locale === 'en' ? 'desktop-en' : 'mobile-it'}.png`,
          ),
          fullPage: true,
        });
        expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        expect(
          (
            await new AxeBuilder({ page: user })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
              .analyze()
          ).violations.map((violation) => violation.id),
        ).toEqual([]);
        if (locale === 'it') {
          await user.setViewportSize({ width: 320, height: 844 });
          expect(
            await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await browserExpect(
            searchPanel.getByRole('button', { name: 'Chiudi', exact: true }),
          ).toBeInViewport();
          await user.setViewportSize({ width: 390, height: 844 });
        }
        await searchPanel
          .getByRole('button', { name: locale === 'en' ? 'Replace' : 'Sostituisci', exact: true })
          .click();
        await searchPanel
          .getByRole('textbox', {
            name: locale === 'en' ? 'Replace with' : 'Sostituisci con',
            exact: true,
          })
          .fill('active');
        await searchPanel
          .getByRole('button', {
            name: locale === 'en' ? 'Replace all' : 'Sostituisci tutto',
            exact: true,
          })
          .click();
        await browserExpect(editor).toContainText('active');
        const searchInput = searchPanel.getByRole('textbox', {
          name: locale === 'en' ? 'Find' : 'Cerca',
          exact: true,
        });
        await searchInput.fill('not-present');
        await browserExpect(searchPanel.locator('output')).toHaveText('0 / 0');
        await searchPanel
          .getByRole('button', {
            name: locale === 'en' ? 'Whole words' : 'Parole intere',
            exact: true,
          })
          .click();
        await browserExpect(
          searchPanel.getByRole('button', {
            name: locale === 'en' ? 'Whole words' : 'Parole intere',
            exact: true,
          }),
        ).toHaveAttribute('aria-pressed', 'true');
        await searchPanel
          .getByRole('button', {
            name: locale === 'en' ? 'Regular expression' : 'Espressione regolare',
            exact: true,
          })
          .click();
        await searchInput.fill('[');
        await browserExpect(searchInput).toHaveAttribute('aria-invalid', 'true');
        await browserExpect(searchPanel.getByRole('status')).toHaveAccessibleName(
          locale === 'en' ? 'Invalid pattern' : 'Espressione non valida',
        );
        expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await searchPanel
          .getByRole('button', { name: locale === 'en' ? 'Close' : 'Chiudi', exact: true })
          .click();
        await browserExpect(editor).toBeFocused();
        await toolbar
          .getByRole('button', { name: locale === 'en' ? 'Undo' : 'Annulla', exact: true })
          .click();
        await browserExpect(editor).toContainText('enabled');
        await editor.fill('{"draft":true}');
        user.once('dialog', (confirmation) => confirmation.dismiss());
        await user.getByRole('button', { name: 'root', exact: true }).click();
        await browserExpect(editor).toContainText('draft');
        user.once('dialog', (confirmation) => confirmation.dismiss());
        await user.locator('.tabs').getByRole('link', { name: 'Console', exact: true }).click();
        await browserExpect(editor).toContainText('draft');
        await editor.focus();
        await user.keyboard.press('Alt+k');
        await browserExpect(editor).toBeFocused();
        await user.keyboard.press('Alt+g');
        await browserExpect(
          user.getByRole('combobox', { name: locale === 'en' ? 'Path' : 'Percorso', exact: true }),
        ).toBeFocused();
        await user.keyboard.press('Escape');
        const audit = await new AxeBuilder({ page: user })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          audit.violations.map((violation) => ({
            id: violation.id,
            nodes: violation.nodes.map((node) => node.target),
          })),
        ).toEqual([]);
        expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await harness.screenshot(
          user,
          `file-inline-editor-${locale === 'en' ? 'desktop-en' : 'mobile-it'}`,
        );
        user.once('dialog', (confirmation) => confirmation.accept());
        await user.getByRole('button', { name: 'root', exact: true }).click();
        await browserExpect(manager.locator('.fm-list')).toBeVisible();
      } finally {
        release();
        await user.unroute('**/files/editor?*');
      }
    }
    await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'en' });
    await user.setViewportSize({ width: 1440, height: 1000 });
  });
  it('renames the open file without leaving the editor and protects unsaved content', async () => {
    await user.goto(base);
    await row('alpha.txt').getByRole('button', { name: 'alpha.txt', exact: true }).click();
    const editor = editorView().getByRole('textbox', { name: 'Contents', exact: true });
    await browserExpect(editor).toBeFocused();
    await browserExpect(user.getByRole('button', { name: /Edit path/ })).toHaveCount(0);
    await editor.fill('Unsaved rename draft');
    await browserExpect(user.getByRole('button', { name: 'Rename', exact: true })).toBeDisabled();
    await editor.press('Control+s');
    await browserExpect(editorView().getByRole('status')).toHaveText('No unsaved changes');
    await user.getByRole('button', { name: 'Rename', exact: true }).click();
    const rename = user.locator('.fm-inline-rename input');
    await browserExpect(rename).toBeFocused();
    expect(
      await rename.evaluate((input: HTMLInputElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    ).toEqual([0, 5]);
    await browserExpect(dialog()).toHaveCount(0);
    const width = await rename.evaluate((input) => {
      const sizer = input.parentElement?.querySelector('.fm-inline-rename-sizer');
      if (!sizer) throw new Error('Missing inline name sizer');
      const range = document.createRange();
      range.selectNodeContents(sizer);
      return {
        input: input.getBoundingClientRect().width,
        text: range.getBoundingClientRect().width,
      };
    });
    expect(width.input - width.text).toBeGreaterThanOrEqual(0);
    expect(width.input - width.text).toBeLessThanOrEqual(8);
    await user.screenshot({
      path: resolve('.codex/local/m5-browser/screenshots/file-editor-inline-rename-desktop-en.png'),
      fullPage: true,
    });
    await rename.fill('../invalid');
    await rename.press('Enter');
    await browserExpect(rename).toHaveAttribute('aria-invalid', 'true');
    expect((await provider.files()).has('alpha.txt')).toBe(true);
    await rename.fill('i.txt');
    expect((await rename.boundingBox())?.width).toBeLessThan(width.input);
    await rename.fill('renamed-alpha.txt');
    expect((await rename.boundingBox())?.width).toBeGreaterThan(width.input);
    await rename.press('Enter');
    await browserExpect(dialog()).toHaveCount(0);
    await browserExpect(user.locator('.fm-current-file')).toHaveText('renamed-alpha.txt');
    await browserExpect(editor).toHaveText('Unsaved rename draft');
    await browserExpect(editor).toBeFocused();
    await editor.fill('Saved after rename');
    await editor.press('Control+s');
    await browserExpect(editorView().getByRole('status')).toHaveText('No unsaved changes');
    expect((await provider.files()).get('renamed-alpha.txt')?.toString()).toBe(
      'Saved after rename',
    );
    // Restore this isolated fixture through the same UI so later journeys retain their starting path.
    await user.getByRole('button', { name: 'Rename', exact: true }).click();
    await rename.fill('alpha.txt');
    await editor.click();
    await browserExpect(user.locator('.fm-current-file')).toHaveText('alpha.txt');
    await browserExpect(editor).toHaveText('Saved after rename');
    await user.getByRole('button', { name: 'Back to files', exact: true }).click();
  });
  it('returns to the same editable cursor immediately during rename and preserves scroll and undo after confirmation', async () => {
    const original = Array.from({ length: 120 }, (_, index) => `Line ${index + 1}: contents`).join(
      '\n',
    );
    (await provider.files()).set('rename-position.txt', Buffer.from(original));
    await user.goto(base);
    await row('rename-position.txt')
      .getByRole('button', { name: 'rename-position.txt', exact: true })
      .click();
    const editor = editorView().getByRole('textbox', { name: 'Contents', exact: true });
    const scroller = user.locator('.cm-scroller');
    await browserExpect(editor).toBeFocused();
    await editor.press('Control+End');
    await editor.press('ArrowLeft');
    await editor.evaluate((element) => {
      element.setAttribute('data-rename-preserve', 'yes');
    });
    const position = () =>
      editor.evaluate(() => {
        const selection = document.getSelection();
        const anchor = selection?.anchorNode;
        const line = anchor?.parentElement?.closest('.cm-line');
        if (!anchor || !line || !selection) throw new Error('Missing editor caret');
        const range = document.createRange();
        range.setStart(line, 0);
        range.setEnd(anchor, selection.anchorOffset);
        return [line.textContent, range.toString().length, selection.isCollapsed];
      });
    const before = await position();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    await user.route('**/files', async (route) => {
      if (
        route.request().method() === 'POST' &&
        route.request().postDataJSON()?.action === 'rename'
      ) {
        requests++;
        await pending;
      }
      await route.continue();
    });
    try {
      await user.getByRole('button', { name: 'Rename', exact: true }).click();
      const rename = user.locator('.fm-inline-rename input');
      await rename.fill('rename-position.jar');
      await rename.press('Enter');
      await browserExpect(user.locator('.fm-inline-rename-error-popup')).toContainText(
        'Rename the file from the file list',
      );
      expect(requests).toBe(0);
      await rename.fill('rename-position.properties');
      await rename.press('Enter');
      await browserExpect(editor).toBeFocused();
      await browserExpect(editor).toHaveAttribute('contenteditable', 'true');
      await browserExpect(rename).toHaveCount(0);
      expect(await position()).toEqual(before);
      await editor.press('x');
      const whilePending = await position();
      const scroll = await scroller.evaluate((element) => element.scrollTop);
      expect(scroll).toBeGreaterThan(0);
      await editor.press('Control+s');
      await browserExpect(
        user.getByRole('button', { name: 'Save changes', exact: true }),
      ).toBeDisabled();
      expect((await provider.files()).get('rename-position.txt')?.toString()).toBe(original);
      await harness.screenshot(user, 'file-editor-rename-pending-desktop-en');
      release();
      await browserExpect(user.locator('.fm-current-file')).toHaveText(
        'rename-position.properties *',
      );
      await browserExpect(editor).toHaveAttribute('data-rename-preserve', 'yes');
      await browserExpect(editor).toBeFocused();
      expect(await position()).toEqual(whilePending);
      expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scroll);
      expect(requests).toBe(1);
      expect((await provider.files()).get('rename-position.properties')?.toString()).toBe(original);
      await editor.press('Control+z');
      await browserExpect(editorView().getByRole('status')).toHaveText('No unsaved changes');
      expect(await position()).toEqual(before);
      await user.getByRole('button', { name: 'Back to files', exact: true }).click();
    } finally {
      release();
      await user.unroute('**/files');
    }
  });
  it('does not steal focus on blur rename completion or lose text on rename failure', async () => {
    (await provider.files()).set('rename-focus.txt', Buffer.from('Keep this text'));
    await user.goto(base);
    await row('rename-focus.txt')
      .getByRole('button', { name: 'rename-focus.txt', exact: true })
      .click();
    const editor = editorView().getByRole('textbox', { name: 'Contents', exact: true });
    for (const fails of [false, true]) {
      let release = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await user.route('**/files', async (route) => {
        if (
          route.request().method() === 'POST' &&
          route.request().postDataJSON()?.action === 'rename'
        ) {
          await pending;
          if (fails)
            return route.fulfill({
              status: 409,
              json: { error: { code: 'conflict', messageKey: 'errors.conflict' } },
            });
        }
        await route.continue();
      });
      try {
        await user.getByRole('button', { name: 'Rename', exact: true }).click();
        await user
          .locator('.fm-inline-rename input')
          .fill(fails ? 'failed-rename.txt' : 'renamed-focus.txt');
        await user.getByRole('button', { name: 'Find', exact: true }).click();
        const search = user.locator('.fm-search-panel-host input').first();
        await browserExpect(search).toBeFocused();
        if (fails) {
          await editor.press('Control+End');
          await editor.press('!');
        }
        release();
        if (fails) {
          await browserExpect(
            user.locator('.fm-inline-rename-error-popup').getByRole('alert'),
          ).toBeVisible();
          await browserExpect(editor).toBeFocused();
          await browserExpect(editor).toHaveText('Keep this text!');
          expect((await provider.files()).get('renamed-focus.txt')?.toString()).toBe(
            'Keep this text',
          );
          await user.locator('.fm-inline-rename input').press('Escape');
          await editor.press('Control+z');
        } else {
          await browserExpect(user.locator('.fm-current-file')).toHaveText('renamed-focus.txt');
          await browserExpect(search).toBeFocused();
        }
        await search.press('Escape');
      } finally {
        release();
        await user.unroute('**/files');
      }
    }
    await user.getByRole('button', { name: 'Back to files', exact: true }).click();
  });
  it('keeps inline rename compact on Italian mobile with keyboard cancel and visible validation', async () => {
    await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'it' });
    await user.setViewportSize({ width: 390, height: 844 });
    try {
      await user.goto(base);
      await row('alpha.txt').getByRole('button', { name: 'alpha.txt', exact: true }).click();
      await user.getByRole('button', { name: 'Rinomina', exact: true }).click();
      const name = user.locator('.fm-inline-rename input');
      await browserExpect(name).toBeFocused();
      await user.screenshot({
        path: resolve(
          '.codex/local/m5-browser/screenshots/file-editor-inline-rename-mobile-it.png',
        ),
        fullPage: true,
      });
      await name.fill('..');
      await name.press('Enter');
      await browserExpect(name).toHaveAttribute('aria-invalid', 'true');
      await browserExpect(
        user.locator('.fm-inline-rename-error-popup').getByRole('alert'),
      ).toBeVisible();
      const audit = await new AxeBuilder({ page: user })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(audit.violations.map(({ id }) => id)).toEqual([]);
      expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await user.screenshot({
        path: resolve(
          '.codex/local/m5-browser/screenshots/file-editor-inline-rename-invalid-mobile-it.png',
        ),
        fullPage: true,
      });
      await name.press('Escape');
      await browserExpect(name).toHaveCount(0);
      await browserExpect(user.locator('.fm-current-file')).toHaveText('alpha.txt');
    } finally {
      await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'en' });
      await user.setViewportSize({ width: 1440, height: 1000 });
    }
  });
  it('keeps edits when browser Back is cancelled and leaves only after confirmation', async () => {
    await user.goto(base.replace(/files$/, 'console'));
    await user.locator('.tabs').getByRole('link', { name: 'Files', exact: true }).click();
    await row('alpha.txt').getByRole('button', { name: 'alpha.txt', exact: true }).click();
    const editor = editorView().getByRole('textbox', { name: 'Contents', exact: true });
    await editor.fill('Keep this draft');
    user.once('dialog', (confirmation) => confirmation.dismiss());
    await user.evaluate(() => history.back());
    await browserExpect(editor).toContainText('Keep this draft');
    await browserExpect(user).toHaveURL(base);
    user.once('dialog', (confirmation) => confirmation.accept());
    await user.evaluate(() => history.back());
    await browserExpect(user).toHaveURL(base.replace(/files$/, 'console'));
    await user.locator('.tabs').getByRole('link', { name: 'Files', exact: true }).click();
  });
  it('keeps known binary jars and world data out of the text endpoint and mounted editor', async () => {
    await user.goto(base);
    let reads = 0;
    const track = (request: import('@playwright/test').Request) => {
      if (new URL(request.url()).pathname.endsWith('/files/editor') && request.method() === 'GET')
        reads++;
    };
    user.on('request', track);
    try {
      await row('server.properties').scrollIntoViewIfNeeded();
      await harness.screenshot(user, 'file-type-icons-desktop-en');
      await menu('server.jar');
      await browserExpect(user.getByRole('menuitem', { name: 'Edit', exact: true })).toBeDisabled();
      await user.keyboard.press('Escape');
      await row('server.jar').getByRole('button', { name: 'server.jar', exact: true }).click();
      await browserExpect(user.locator('.fm-editor-view')).toContainText('binary file');
      await browserExpect(user.locator('.file-text-editor')).toHaveCount(0);
      await browserExpect(
        user.getByRole('button', { name: 'Download', exact: true }),
      ).toBeEnabled();
      await user.getByRole('button', { name: 'root', exact: true }).click();
      await row('world').getByRole('button', { name: 'world', exact: true }).click();
      await row('level.dat').getByRole('button', { name: 'level.dat', exact: true }).click();
      await browserExpect(user.locator('.fm-editor-view')).toContainText('binary file');
      await browserExpect(user.locator('.file-text-editor')).toHaveCount(0);
      expect(reads).toBe(0);
      await harness.screenshot(user, 'file-inline-binary-unavailable-desktop-en');
      await user.getByRole('button', { name: 'root', exact: true }).click();
    } finally {
      user.off('request', track);
    }
  });
  it('edits JSON with keyboard save and refuses concurrent overwrite while retaining the draft', async () => {
    const beforeNavigation = editorRequests;
    await user.goto(base);
    await browserExpect.poll(() => editorRequests).toBe(beforeNavigation + 1);
    const beforeEditor = editorRequests;
    await row('beta.json').getByRole('button', { name: 'beta.json', exact: true }).click();
    const editor = editorView().getByRole('textbox', { name: 'Contents', exact: true });
    await editor.fill('{"enabled":false}');
    await editor.press('Control+s');
    await browserExpect(editorView().getByRole('status')).toHaveText('No unsaved changes');
    expect((await provider.files()).get('beta.json')?.toString()).toBe('{"enabled":false}');
    await editor.fill('{"local":true}');
    (await provider.files()).set('beta.json', Buffer.from('{"remote":true}'));
    await editor.press('Control+s');
    await browserExpect(editorView().getByRole('alert')).toContainText('changed after you opened');
    await browserExpect(editor).toContainText('"local":true');
    expect((await provider.files()).get('beta.json')?.toString()).toBe('{"remote":true}');
    expect(editorRequests).toBe(beforeEditor);
    await harness.screenshot(user, 'file-inline-editor-conflict-desktop-en');
    user.once('dialog', (confirmation) => confirmation.accept());
    await user.getByRole('button', { name: 'Back to files', exact: true }).click();
    await browserExpect(
      row('beta.json').getByRole('button', { name: 'beta.json', exact: true }),
    ).toBeFocused();
  });
  it('indents with Tab and outdents with Shift+Tab without trapping keyboard focus', async () => {
    await user.goto(base);
    await row('alpha.txt').getByRole('button', { name: 'alpha.txt', exact: true }).click();
    const editor = editorView().getByRole('textbox', { name: 'Contents', exact: true });
    await browserExpect(editor).toHaveAttribute('aria-description', /Escape.*Tab/);
    await editor.fill('first\nsecond');
    await editor.press('Control+a');
    await editor.press('Tab');
    await browserExpect(editor.locator('.cm-line')).toHaveText(['  first', '  second']);
    await browserExpect(editor).toBeFocused();
    await editor.press('Shift+Tab');
    await browserExpect(editor.locator('.cm-line')).toHaveText(['first', 'second']);
    await browserExpect(editor).toBeFocused();
    await editor.press('Control+z');
    await browserExpect(editor.locator('.cm-line')).toHaveText(['  first', '  second']);
    await editor.press('Control+y');
    await browserExpect(editor.locator('.cm-line')).toHaveText(['first', 'second']);

    await editor.press('ArrowRight');
    await editor.press('Home');
    await editor.press('ArrowRight');
    await editor.press('ArrowRight');
    await editor.press('Tab');
    await browserExpect(editor.locator('.cm-line')).toHaveText(['first', 'se  cond']);
    await editor.press('X');
    await browserExpect(editor.locator('.cm-line')).toHaveText(['first', 'se  Xcond']);
    await editor.press('Home');
    await editor.press('Tab');
    await browserExpect(editor.locator('.cm-line')).toHaveText(['first', '  se  Xcond']);
    await editor.press('Shift+Tab');
    await browserExpect(editor.locator('.cm-line')).toHaveText(['first', 'se  Xcond']);
    await editor.fill('first\nsecond');

    await editor.press('Control+f');
    const search = user.locator('.fm-search-panel input[name=search]');
    await browserExpect(search).toBeFocused();
    await search.press('Tab');
    await browserExpect(search).not.toBeFocused();
    await browserExpect(editor.locator('.cm-line')).toHaveText(['first', 'second']);
    await user
      .locator('.fm-search-panel')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    for (const key of ['Tab', 'Shift+Tab']) {
      await editor.focus();
      await editor.press('Escape');
      await user.keyboard.press(key);
      await browserExpect(editor).not.toBeFocused();
      await browserExpect(editor.locator('.cm-line')).toHaveText(['first', 'second']);
    }
    user.once('dialog', (confirmation) => confirmation.accept());
    await user.getByRole('button', { name: 'Back to files', exact: true }).click();
  });
  it('saves in the background while preserving new edits, navigation and recoverable failures', async () => {
    await user.goto(base);
    await row('alpha.txt').getByRole('button', { name: 'alpha.txt', exact: true }).click();
    const editor = editorView().getByRole('textbox', { name: 'Contents', exact: true });
    await editor.fill('Submitted snapshot');
    let release = () => {};
    let began = () => {};
    let requests = 0;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    await user.route('**/files/editor', async (route) => {
      if (route.request().method() === 'PUT') {
        requests++;
        began();
        await pending;
      }
      await route.continue();
    });
    try {
      await editor.press('Control+s');
      await started;
      await browserExpect(editor).toHaveAttribute('contenteditable', 'true');
      await editor.fill('Typed while saving');
      await editor.press('Control+s');
      expect(requests).toBe(1);
      await harness.screenshot(user, 'file-editor-background-save-desktop-en');
      release();
      await browserExpect(editorView().getByRole('status')).toHaveText('Unsaved changes');
      await browserExpect(editor).toHaveText('Typed while saving');
      expect((await provider.files()).get('alpha.txt')?.toString()).toBe('Submitted snapshot');
      await editor.press('Control+s');
      await browserExpect(editorView().getByRole('status')).toHaveText('No unsaved changes');
      expect((await provider.files()).get('alpha.txt')?.toString()).toBe('Typed while saving');
    } finally {
      release();
      await user.unroute('**/files/editor');
    }

    let fail = () => {};
    let failureBegan = () => {};
    const failurePending = new Promise<void>((resolve) => {
      fail = resolve;
    });
    const failureStarted = new Promise<void>((resolve) => {
      failureBegan = resolve;
    });
    await user.route('**/files/editor', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      failureBegan();
      await failurePending;
      await route.fulfill({
        status: 503,
        json: {
          error: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
        },
      });
    });
    try {
      await editor.fill('Recoverable draft');
      await editor.press('Control+s');
      await failureStarted;
      await user.getByRole('button', { name: 'Back to files', exact: true }).click();
      await user.locator('.file-save-notices').getByRole('link').click();
      await browserExpect(editor).toHaveText('Recoverable draft');
      await browserExpect(editorView().getByRole('status')).toHaveText('Saving…');
      await user.getByRole('button', { name: 'Back to files', exact: true }).click();
      await row('beta.json').getByRole('button', { name: 'beta.json', exact: true }).click();
      await browserExpect(editor).not.toContainText('Recoverable draft');
      // Leaving Files must not drop the in-flight write or its eventual error.
      await user.locator('.tabs').getByRole('link', { name: 'Console', exact: true }).click();
      fail();
      const notice = user.locator('.file-save-notices');
      await browserExpect(notice).toContainText('Could not save alpha.txt');
      await user.locator('.tabs').getByRole('link', { name: 'Files', exact: true }).click();
      await row('beta.json').getByRole('button', { name: 'beta.json', exact: true }).click();
      await editor.fill('Another unsaved file');
      let confirmations = 0;
      const confirm = (dialog: import('@playwright/test').Dialog) => {
        confirmations++;
        void (confirmations === 2 ? dialog.accept() : dialog.dismiss());
      };
      user.on('dialog', confirm);
      try {
        await notice.getByRole('link').click();
        await browserExpect(editor).toHaveText('Another unsaved file');
        await browserExpect.poll(() => confirmations).toBe(1);
        await notice.getByRole('link').click();
        await browserExpect(editor).toHaveText('Recoverable draft');
        await browserExpect.poll(() => confirmations).toBe(2);
      } finally {
        user.off('dialog', confirm);
      }
      await browserExpect(editor).toHaveText('Recoverable draft');
      await browserExpect(editorView().getByRole('alert')).toBeVisible();
      await browserExpect(
        user.getByRole('button', { name: 'Save changes', exact: true }),
      ).toBeEnabled();
    } finally {
      fail();
      await user.unroute('**/files/editor');
    }
    await editor.press('Control+s');
    await browserExpect(editorView().getByRole('status')).toHaveText('No unsaved changes');
    await browserExpect(user.locator('.file-save-notices')).toHaveCount(0);
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
  it('completes actual folders and files with arrows, Space and Enter without per-character listing requests', async () => {
    const remote = await provider.files();
    remote.set('world/path notes.txt', Buffer.from('Nested original'));
    remote.set('path notes.txt', Buffer.from('Root untouched'));
    await user.goto(base);
    await browserExpect(row('world')).toBeVisible();
    const path = user.getByRole('combobox', { name: 'Path', exact: true });
    const listings: string[] = [];
    const track = (request: import('@playwright/test').Request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/files') && request.method() === 'GET') listings.push(url.search);
    };
    user.on('request', track);
    try {
      await user.keyboard.press('Alt+g');
      await browserExpect(
        user.getByRole('button', { name: 'Open folder', exact: true }),
      ).toHaveCount(0);
      await path.fill('/w');
      await browserExpect(user.getByRole('option', { name: 'world/', exact: true })).toBeVisible();
      await path.press('o');
      await path.press('r');
      await path.press('ArrowDown');
      await path.press('Space');
      await browserExpect(path).toHaveValue('/world/');
      await browserExpect(
        user.getByRole('option', { name: 'path notes.txt', exact: true }),
      ).toBeVisible();
      await path.fill('/world/path');
      await path.press('Space');
      await browserExpect(path).toHaveValue('/world/path ');
      await path.press('n');
      await browserExpect(
        user.getByRole('option', { name: 'path notes.txt', exact: true }),
      ).toBeVisible();
      await path.press('ArrowDown');
      await path.press('Enter');
      const editor = editorView().getByRole('textbox', { name: 'Contents', exact: true });
      await browserExpect(editor).toContainText('Nested original');
      await editor.fill('Nested saved');
      await editor.press('Control+s');
      await browserExpect(editorView().getByRole('status')).toHaveText('No unsaved changes');
      expect(remote.get('world/path notes.txt')?.toString()).toBe('Nested saved');
      expect(remote.get('path notes.txt')?.toString()).toBe('Root untouched');
      // Current folder and autocomplete share a cache; only entering world needs a listing.
      expect(listings.filter((query) => query === '?path=')).toHaveLength(0);
      // Saving refetches the active listing; there is still no listing per typed character.
      expect(listings.filter((query) => query === '?path=world').length).toBeLessThanOrEqual(2);
      await user.keyboard.press('Alt+g');
      await path.fill('/world/');
      await path.press('Enter');
      await browserExpect(path).toHaveCount(0);
      await browserExpect(user.getByRole('navigation', { name: 'File location' })).toContainText(
        'world',
      );
    } finally {
      user.off('request', track);
    }
  });
  it('completes the sole path candidate on Enter and keeps folder input ready for nested paths', async () => {
    const remote = await provider.files();
    const paths = ['libraries/module/config.json', 'libraries/module/configuration.txt'] as const;
    for (const [root, name] of [
      ['', 'libraries'],
      ['libraries', 'module'],
    ])
      await journeyRequest(harness, user, `/v1/servers/${provider.ids.serverId}/files`, {
        action: 'mkdir',
        root,
        name,
      });
    remote.set(paths[0], Buffer.from('{"nested":true}'));
    remote.set(paths[1], Buffer.from('Another file'));
    try {
      await user.goto(base);
      await browserExpect(row('libraries')).toBeVisible();
      await user.keyboard.press('Alt+g');
      const path = user.getByRole('combobox', { name: 'Path', exact: true });
      await path.fill('lib');
      await browserExpect(user.getByRole('option')).toHaveCount(1);
      await path.press('Enter');
      await browserExpect(path).toHaveValue('/libraries/');
      await browserExpect(path).toBeFocused();
      await browserExpect(user.getByRole('option', { name: 'module/', exact: true })).toBeVisible();
      // A trailing slash opens this folder, even when it has only one child.
      await path.press('Enter');
      await browserExpect(path).toHaveCount(0);
      await browserExpect(row('module')).toBeVisible();
      await user.keyboard.press('Alt+g');
      await path.press('End');
      await path.pressSequentially('mo');
      await path.press('Enter');
      await browserExpect(path).toHaveValue('/libraries/module/');
      await browserExpect(path).toBeFocused();
      await browserExpect(user.getByRole('option')).toHaveCount(2);
      await path.pressSequentially('con');
      await path.press('Enter');
      await browserExpect(path).toHaveValue('/libraries/module/con');
      await browserExpect(
        user.getByText('File or folder not found.', { exact: true }),
      ).toBeVisible();
      await path.pressSequentially('fig.j');
      await browserExpect(user.getByRole('option')).toHaveCount(1);
      await path.press('Enter');
      await browserExpect(
        editorView().getByRole('textbox', { name: 'Contents', exact: true }),
      ).toContainText('"nested":true');
      await browserExpect(path).toHaveCount(0);
      await user.getByRole('button', { name: 'Back to files', exact: true }).click();
    } finally {
      for (const path of paths) remote.delete(path);
    }
  });
  it('keeps path errors visible and never commits a stale candidate after editing the prefix', async () => {
    await user.goto(base);
    await browserExpect(user.locator('.fm-tools')).toBeVisible();
    await user.keyboard.press('Alt+g');
    const path = user.getByRole('combobox', { name: 'Path', exact: true });
    await path.fill('/wo');
    await browserExpect(user.getByRole('option', { name: 'world/', exact: true })).toBeVisible();
    await path.press('ArrowDown');
    await path.fill('/missing-folder');
    await path.press('Enter');
    await browserExpect(path).toBeVisible();
    await browserExpect(user.getByText('File or folder not found.', { exact: true })).toBeVisible();
    await browserExpect(dialog()).toHaveCount(0);
    await path.fill('/../world');
    await path.press('Enter');
    await browserExpect(path).toBeVisible();
    await browserExpect(user.getByRole('option')).toHaveCount(0);
    await path.press('Escape');
    await browserExpect(path).toHaveCount(0);
    await browserExpect(row('world')).toBeVisible();
  });
  it('renders bounded path suggestions on desktop and Italian mobile with accessible keyboard selection', async () => {
    for (const locale of ['en', 'it'] as const) {
      await journeyRequest(harness, user, '/api/auth/update-user', { locale });
      await user.setViewportSize(
        locale === 'en' ? { width: 1440, height: 1000 } : { width: 390, height: 844 },
      );
      await user.goto(base);
      await browserExpect(user.locator('.fm-tools')).toBeVisible();
      await user.keyboard.press('Alt+g');
      const path = user.getByRole('combobox', {
        name: locale === 'en' ? 'Path' : 'Percorso',
        exact: true,
      });
      await path.fill('/');
      await browserExpect(user.getByRole('option', { name: 'world/', exact: true })).toBeVisible();
      await path.press('ArrowUp');
      await browserExpect
        .poll(() => user.getByRole('listbox').evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      await path.press('ArrowDown');
      await browserExpect(path).toBeFocused();
      expect(await path.getAttribute('aria-activedescendant')).toBeTruthy();
      expect(
        await user.getByRole('listbox').evaluate((element) => {
          const list = element.getBoundingClientRect();
          const panel = element.parentElement?.getBoundingClientRect();
          return Boolean(panel && list.bottom <= panel.bottom - 4);
        }),
      ).toBe(true);
      expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const audit = await new AxeBuilder({ page: user })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        audit.violations.map(({ id, nodes }) => ({
          id,
          targets: nodes.map((node) => node.target),
        })),
      ).toEqual([]);
      await harness.screenshot(
        user,
        `file-path-picker-${locale === 'en' ? 'desktop-en' : 'mobile-it'}`,
      );
      await path.press('Escape');
    }
    await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'en' });
    await user.setViewportSize({ width: 1440, height: 1000 });
    expect(errors).toEqual([]);
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
        const keys = 'Alt+k';
        await browserExpect(search).toHaveAttribute('placeholder', 'Search');
        await browserExpect(search).toHaveAttribute('aria-keyshortcuts', 'Alt+K');
        await browserExpect(page.locator('.fm-search kbd')).toHaveText(mac ? '⌥ + K' : 'ALT + K');
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
        const path = page.getByRole('combobox', { name: 'Path', exact: true });
        await browserExpect(path).toBeFocused();
        await browserExpect(path).toHaveValue('/');
        if (platform === 'Linux x86_64')
          await harness.screenshot(page, 'file-manager-path-focused-en');
        await page.keyboard.press(keys);
        await browserExpect(search).toBeFocused();
        await browserExpect(path).toHaveCount(0);
        await page.keyboard.press('Alt+g');
        await browserExpect(path).toBeFocused();
        await path.fill('/wo');
        await page.keyboard.press('Alt+g');
        expect(
          await path.evaluate((input: HTMLInputElement) => [
            input.selectionStart,
            input.selectionEnd,
          ]),
        ).toEqual([0, 3]);
        await search.click();
        await browserExpect(path).toHaveCount(0);
        await page.keyboard.press('Alt+g');
        await browserExpect(path).toBeFocused();
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
          await page.evaluate(() => {
            const event = new KeyboardEvent('keydown', {
              key: 'k',
              code: 'KeyK',
              altKey: true,
              bubbles: true,
              cancelable: true,
            });
            return document.dispatchEvent(event);
          }),
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
