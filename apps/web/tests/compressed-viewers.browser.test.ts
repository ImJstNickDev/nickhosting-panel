import { Buffer } from 'node:buffer';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('single compressed viewers', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let base: string;
  let endpoint: string;
  const reads: URL[] = [];
  const errors: string[] = [];
  const preferences: { scope: string; extension: string; viewerId: string }[] = [];
  let rejectArchive = false;
  beforeAll(async () => {
    harness = await browserHarness();
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
    endpoint = `/v1/servers/${provider.ids.serverId}/files/viewer`;
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    const remote = await provider.files();
    for (const name of [
      'config.json.gz',
      'config.json.bz2',
      'config.json.xz',
      'config.json.zst',
      'backup.tar.gz',
      'nested.zip',
      'bundle.zip.gz',
      'config.json',
      'error.json.gz',
    ])
      remote.set(name, Buffer.from('isolated protocol fixture'));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(
      (url) => url.pathname.startsWith(`${endpoint}/`),
      async (route) => {
        const url = new URL(route.request().url());
        reads.push(url);
        const action = url.pathname.slice(endpoint.length);
        if (action === '/capabilities') return route.fulfill({ json: { available: true } });
        if (action === '/preferences') {
          if (route.request().method() === 'PUT') preferences.push(route.request().postDataJSON());
          return route.fulfill({ json: { preferences } });
        }
        if (action === '/archive') {
          if (rejectArchive)
            return route.fulfill({ status: 503, json: { messageKey: 'viewer.unavailable' } });
          const nested =
            url.searchParams.get('path') === 'nested.zip' &&
            url.searchParams.get('archives') === '[]';
          const chain = JSON.parse(url.searchParams.get('archives') ?? '[]') as string[];
          const bundled =
            url.searchParams.get('path') === 'bundle.zip.gz' || chain.includes('bundle.zip.gz');
          const names = nested
            ? ['config.json.gz', 'bundle.zip.gz']
            : bundled
              ? [chain.at(-1) === 'bundle.zip' ? 'inside.txt' : 'bundle.zip']
              : ['config.json'];
          return route.fulfill({
            json: {
              directory: '',
              offset: 0,
              limit: 200,
              total: names.length,
              entries: names.map((name) => ({ name, path: name, directory: false, size: 16 })),
            },
          });
        }
        if (action === '/archive/content' || action === '/content')
          return route.fulfill({ body: '{"decoded":true}', contentType: 'application/json' });
        await route.fulfill({ status: 404, json: { messageKey: 'viewer.unavailable' } });
      },
    );
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  async function open(name: string) {
    await page.goto(base);
    await page.getByRole('button', { name: 'root', exact: true }).click();
    await page.locator('.fm-filename').getByText(name, { exact: true }).click();
  }
  const choose = async (name: string) => {
    await page.getByRole('button', { name: /^(Open with|Apri con)$/ }).click();
    const dialog = page.getByRole('dialog');
    if (!(await dialog.getByRole('button', { name, exact: true }).count()))
      await dialog.getByRole('button', { name: /^(Show all|Mostra tutti)$/ }).click();
    await dialog.getByRole('button', { name, exact: true }).click();
  };

  it('opens each single stream as JSON, retains compressed identity, and separates download targets', async () => {
    for (const extension of ['gz', 'bz2', 'xz', 'zst']) {
      const name = `config.json.${extension}`;
      await open(name);
      await browserExpect(page.locator('.ve-json')).toBeVisible();
      await browserExpect(page.locator('.fm-breadcrumb [aria-current="page"]')).toHaveText(name);
      await browserExpect(page.getByRole('button', { name: /^(Save|Salva)$/ })).toHaveCount(0);
      const fileRead = reads.findLast((url) => url.pathname.endsWith('/archive/content'));
      expect(fileRead?.searchParams.get('entry')).toBe('config.json');
      expect(fileRead?.searchParams.get('path')).toBe(name);
    }
    await page.evaluate(() => {
      const downloads: string[] = [];
      Object.assign(window, { compressedDownloads: downloads });
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.href.includes('/files/')) downloads.push(this.href);
        else click.call(this);
      };
    });
    await page.getByRole('button', { name: /^(Download|Scarica)$/ }).click();
    await page.getByRole('menuitem', { name: /^(Download archive|Scarica archivio)$/ }).click();
    await page.getByRole('button', { name: /^(Download|Scarica)$/ }).click();
    await page.getByRole('menuitem', { name: /^(Download file|Scarica file)$/ }).click();
    const urls = await page.evaluate(
      () => (window as unknown as { compressedDownloads: string[] }).compressedDownloads,
    );
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0] ?? '').pathname).toMatch(/\/files\/content$/);
    expect(new URL(urls[1] ?? '').pathname).toMatch(/\/viewer\/archive\/content$/);
    expect(new URL(urls[1] ?? '').searchParams.get('entry')).toBe('config.json');
  });

  it('keeps decoded Scribe read-only with member syntax and restores the chosen viewer on reload', async () => {
    await open('config.json.gz');
    await browserExpect(page.locator('.ve-json')).toBeVisible();
    await choose('Scribe');
    await browserExpect(page.locator('.ve-text .cm-content')).toHaveAttribute(
      'contenteditable',
      'false',
    );
    await browserExpect(page.locator('.fm-breadcrumb [aria-current="page"]')).toHaveText(
      'config.json.gz',
    );
    await page.reload();
    await browserExpect(page.locator('.ve-text .cm-content')).toHaveAttribute(
      'contenteditable',
      'false',
    );
    await choose('Atlas');
    await browserExpect(page.locator('.ve-archive')).toBeVisible();
    await page.reload();
    await browserExpect(page.locator('.ve-archive')).toBeVisible();
  });

  it('leaves tar archives in Atlas and decodes nested single streams without a synthetic breadcrumb', async () => {
    await open('backup.tar.gz');
    await browserExpect(page.locator('.ve-archive')).toBeVisible();
    await browserExpect(page.getByRole('button', { name: /^(Extract|Estrai)$/ })).toBeVisible();
    await open('nested.zip');
    await page.locator('.ve-archive').getByText('config.json.gz', { exact: true }).click();
    await browserExpect(page.locator('.ve-json')).toBeVisible();
    await browserExpect(page.locator('.fm-breadcrumb')).toContainText('nested.zip');
    await browserExpect(page.locator('.fm-breadcrumb [aria-current="page"]')).toHaveText(
      'config.json.gz',
    );
    await browserExpect(
      page.locator('.fm-breadcrumb').getByText('config.json', { exact: true }),
    ).toHaveCount(0);
    const fileRead = reads.findLast((url) => url.pathname.endsWith('/archive/content'));
    expect(fileRead?.searchParams.get('archives')).toBe('["config.json.gz"]');
    expect(fileRead?.searchParams.get('entry')).toBe('config.json');
    expect(errors).toEqual([]);
    await harness.screenshot(page, 'file-viewer-single-compressed-nested');
  });

  it('browses decoded ZIP streams at root and nested depth with logical breadcrumbs and download choices', async () => {
    for (const nested of [false, true]) {
      await open(nested ? 'nested.zip' : 'bundle.zip.gz');
      if (nested)
        await page.locator('.ve-archive').getByText('bundle.zip.gz', { exact: true }).click();
      await browserExpect(
        page.locator('.ve-archive').getByText('inside.txt', { exact: true }),
      ).toBeVisible();
      await browserExpect(page.locator('.fm-breadcrumb [aria-current="page"]')).toHaveText(
        'bundle.zip.gz',
      );
      await browserExpect(
        page.locator('.fm-breadcrumb').getByText('bundle.zip', { exact: true }),
      ).toHaveCount(0);
      const listing = reads.findLast((url) => url.pathname.endsWith('/archive'));
      expect(JSON.parse(listing?.searchParams.get('archives') ?? '[]')).toEqual(
        nested ? ['bundle.zip.gz', 'bundle.zip'] : ['bundle.zip'],
      );
      await page.locator('.ve-archive').getByText('inside.txt', { exact: true }).click();
      await browserExpect(page.locator('.ve-text .cm-content')).toHaveAttribute(
        'contenteditable',
        'false',
      );
      await page
        .locator('.fm-breadcrumb')
        .getByRole('button', { name: 'bundle.zip.gz', exact: true })
        .click();
      await browserExpect(
        page.locator('.ve-archive').getByText('inside.txt', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Download', exact: true }).click();
      await browserExpect(
        page.getByRole('menuitem', { name: 'Download file', exact: true }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
    }
    expect(errors).toEqual([]);
  });

  it('saves explicit Atlas overrides for the compressed extension and respects them on root and nested reopen', async () => {
    await open('config.json.gz');
    await browserExpect(page.locator('.ve-json')).toBeVisible();
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox').selectOption('server');
    await dialog.getByRole('button', { name: 'Show all', exact: true }).click();
    await dialog.getByRole('button', { name: 'Atlas', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(preferences).toEqual([{ scope: 'server', extension: 'gz', viewerId: 'archive' }]);
    await open('config.json');
    await browserExpect(page.locator('.ve-json')).toBeVisible();
    await open('config.json.gz');
    await browserExpect(page.locator('.ve-archive')).toBeVisible();
    await open('nested.zip');
    await page.locator('.ve-archive').getByText('config.json.gz', { exact: true }).click();
    await browserExpect(
      page.locator('.ve-archive').getByText('config.json', { exact: true }),
    ).toBeVisible();
    preferences.splice(0);
  });

  it('allows retrying a failed compressed lookup without leaving the selected file', async () => {
    rejectArchive = true;
    await open('error.json.gz');
    await browserExpect(page.locator('.ve-engine').getByRole('alert')).toBeVisible();
    await harness.screenshot(page, 'file-viewer-single-compressed-error');
    rejectArchive = false;
    await page
      .locator('.ve-engine')
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await browserExpect(page.locator('.ve-json')).toBeVisible();
    await browserExpect(page.locator('.fm-breadcrumb [aria-current="page"]')).toHaveText(
      'error.json.gz',
    );
  });

  it('uses decoded extension preferences and keeps the Italian mobile download menu keyboard accessible', async () => {
    await open('config.json.gz');
    await browserExpect(page.locator('.ve-json')).toBeVisible();
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog.locator('.ve-chooser-filename')).toHaveText('config.json.gz');
    await dialog.getByRole('combobox').selectOption('server');
    await dialog.getByRole('button', { name: 'Scribe', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    expect(preferences).toEqual([{ scope: 'server', extension: 'json', viewerId: 'text' }]);
    await open('config.json.bz2');
    await browserExpect(page.locator('.ve-text .cm-content')).toHaveAttribute(
      'contenteditable',
      'false',
    );
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await browserExpect(page.locator('.ve-text .cm-content')).toHaveAttribute(
      'contenteditable',
      'false',
    );
    const trigger = page.getByRole('button', { name: 'Scarica', exact: true });
    await trigger.click();
    await browserExpect(
      page.getByRole('menuitem', { name: 'Scarica archivio', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await browserExpect(
      page.getByRole('menuitem', { name: 'Scarica file', exact: true }),
    ).toBeFocused();
    await harness.screenshot(page, 'file-viewer-single-compressed-download-mobile-it');
    const menu = await page.getByRole('menu').boundingBox();
    expect(menu && menu.x >= 0 && menu.x + menu.width <= 390).toBe(true);
    await page.keyboard.press('Escape');
    await browserExpect(trigger).toBeFocused();
    expect(errors).toEqual([]);
  });
});
