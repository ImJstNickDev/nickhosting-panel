import { Buffer } from 'node:buffer';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

/** UI/protocol fixtures only. SFTP authorization, archive parsing and Range live in backend tests. */
describe('M5 builtin file viewers', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let base: string;
  let endpoint: string;
  let remote: Map<string, Buffer>;
  const preferences: { scope: string; extension: string; viewerId: string }[] = [];
  const reads: string[] = [];
  const errors: string[] = [];
  let scriptRequests = 0;
  let viewerAvailable = true;
  let preferenceReads = 0;

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
    remote = await provider.files();
    remote.set(
      'viewer.json',
      Buffer.from(
        '{"large":9007199254740993123456789,"players":[{"name":"Alex","active":true}],"same":1,"same":2}',
      ),
    );
    remote.set('viewer.json5', Buffer.from("{ // comment\n name:'Alex', limit:0x10, }"));
    remote.set(
      'viewer.svg',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect width="400" height="200" fill="#315a48"/><circle cx="200" cy="100" r="50" fill="#f0cf88"/><script>window.viewerScriptRan=true;fetch("/viewer-script-must-not-run")</script></svg>',
      ),
    );
    remote.set('viewer.zip', Buffer.from('archive metadata fixture'));
    remote.set('viewer.sqlite', Buffer.from('sqlite API fixture'));
    remote.set('unsupported.avi', Buffer.from('not a playable video'));
    const wav = Buffer.alloc(44 + 8000 * 2);
    wav.write('RIFF');
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    remote.set('viewer.wav', wav);
    const pngs = await page.evaluate(() =>
      [16, 32].map((size) => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('canvas');
        context.fillStyle = '#315a48';
        context.fillRect(0, 0, size, size);
        return canvas.toDataURL('image/png').split(',')[1] ?? '';
      }),
    );
    const frames = pngs.map((value) => Buffer.from(value, 'base64'));
    const ico = Buffer.alloc(6 + frames.length * 16);
    ico.writeUInt16LE(1, 2);
    ico.writeUInt16LE(frames.length, 4);
    let start = ico.length;
    frames.forEach((frame, index) => {
      const pos = 6 + index * 16;
      ico[pos] = index ? 32 : 16;
      ico[pos + 1] = index ? 32 : 16;
      ico.writeUInt16LE(1, pos + 4);
      ico.writeUInt16LE(32, pos + 6);
      ico.writeUInt32LE(frame.length, pos + 8);
      ico.writeUInt32LE(start, pos + 12);
      start += frame.length;
    });
    remote.set('viewer.ico', Buffer.concat([ico, ...frames]));
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/viewer-script-must-not-run') scriptRequests++;
    });
    await page.route(`**${endpoint}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.searchParams.get('path') ?? '';
      const action = url.pathname.slice(endpoint.length);
      if (action === '/preferences') {
        if (request.method() === 'GET') preferenceReads++;
        if (request.method() === 'PUT') {
          const value = request.postDataJSON();
          const found = preferences.findIndex(
            (item) => item.scope === value.scope && item.extension === value.extension,
          );
          if (found >= 0) preferences.splice(found, 1);
          preferences.push(value);
        }
        await route.fulfill({ json: { preferences } });
        return;
      }
      if (action === '/capabilities') {
        await route.fulfill({ json: { available: viewerAvailable } });
        return;
      }
      reads.push(`${action}:${path}:${url.searchParams.get('entry') ?? ''}`);
      if (action === '/archive') {
        const directory = url.searchParams.get('directory') ?? '';
        const entries = directory
          ? [{ name: 'settings.json', path: 'config/settings.json', directory: false, size: 12 }]
          : [
              { name: 'config', path: 'config', directory: true, size: 0 },
              { name: 'README.txt', path: 'README.txt', directory: false, size: 12 },
            ];
        await route.fulfill({
          json: { directory, entries, offset: 0, limit: 200, total: entries.length },
        });
        return;
      }
      if (action === '/sqlite') {
        await route.fulfill({
          json: {
            tables: ['players'],
            consistency: 'unverified',
            ...(url.searchParams.get('table')
              ? {
                  columns: ['id', 'name', 'data'],
                  rows: [
                    [
                      { type: 'integer', value: '9007199254740993123' },
                      { type: 'text', value: 'Alex', truncated: false },
                      { type: 'blob', bytes: 3 },
                    ],
                  ],
                  offset: 0,
                  hasMore: false,
                }
              : {}),
          },
        });
        return;
      }
      const body =
        action === '/archive/content'
          ? Buffer.from(
              url.searchParams.get('entry')?.endsWith('.json')
                ? '{"ok":true}'
                : 'Read-only archive text',
            )
          : remote.get(path);
      if (!body) {
        await route.fulfill({ status: 404, json: { code: 'not_found' } });
        return;
      }
      const contentType = path.endsWith('.svg')
        ? 'image/svg+xml'
        : path.endsWith('.ico')
          ? 'image/x-icon'
          : path.endsWith('.wav')
            ? 'audio/wav'
            : path.endsWith('.avi')
              ? 'video/x-msvideo'
              : 'application/octet-stream';
      await route.fulfill({
        body,
        contentType,
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    });
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  async function open(name: string) {
    await page.goto(base);
    await page
      .locator('.fm-filename')
      .filter({ hasText: name })
      .getByText(name, { exact: true })
      .click();
  }
  async function root() {
    await page.getByRole('button', { name: 'root', exact: true }).click();
  }

  it('opens SVG safely, zooms, switches iconset entries, and does not prefetch file contents', async () => {
    await page.goto(base);
    await browserExpect(
      page.locator('.fm-filename').getByText('viewer.svg', { exact: true }),
    ).toBeVisible();
    expect(reads).toEqual([]);
    await page.locator('.fm-filename').getByText('viewer.svg', { exact: true }).click();
    await browserExpect(page.locator('.ve-image-stage img')).toBeVisible();
    await browserExpect
      .poll(() =>
        page
          .locator('.ve-image-stage img')
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(400);
    expect(await page.evaluate(() => 'viewerScriptRan' in window)).toBe(false);
    expect(scriptRequests).toBe(0);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await browserExpect(page.locator('.ve-controls output')).toHaveText('125%');
    await harness.screenshot(page, 'file-viewer-image-desktop-en');
    await root();
    await page.locator('.fm-filename').getByText('viewer.ico', { exact: true }).click();
    await browserExpect(page.getByLabel('Icon image')).toBeVisible();
    await browserExpect(page.getByLabel('Icon image').locator('option')).toHaveCount(2);
    await page.getByLabel('Icon image').selectOption('1');
    await browserExpect
      .poll(() =>
        page
          .locator('.ve-image-stage img')
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(32);
    expect(errors).toEqual([]);
  });

  it('preserves JSON numbers and switches to the existing editor with a remembered personal default', async () => {
    await open('viewer.json');
    await browserExpect(page.locator('.ve-json')).toContainText('9007199254740993123456789');
    await page.locator('.ve-json summary').filter({ hasText: 'players' }).click();
    await browserExpect(page.locator('.ve-json')).toContainText('0:');
    await harness.screenshot(page, 'file-viewer-json-desktop-en');
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio', { name: 'Text editor', exact: true }).check();
    await dialog.getByRole('checkbox', { name: 'Use by default for this file type' }).check();
    await dialog.getByRole('button', { name: 'Open', exact: true }).click();
    await browserExpect(page.locator('.cm-content')).toContainText('9007199254740993123456789');
    expect(preferences).toContainEqual({ scope: 'server', extension: 'json', viewerId: 'text' });
    await root();
    await page.locator('.fm-filename').getByText('viewer.json', { exact: true }).click();
    await browserExpect(page.locator('.cm-content')).toBeVisible();
    expect(await page.getByRole('dialog').isVisible()).toBe(false);
    expect(errors).toEqual([]);
  });

  it('navigates archives as virtual folders, previews entries and returns to the same directory', async () => {
    preferences.length = 0;
    await open('viewer.zip');
    await page.locator('.ve-entry').getByText('config', { exact: true }).click();
    await page.locator('.ve-entry').getByText('settings.json', { exact: true }).click();
    await browserExpect(page.locator('.ve-json')).toContainText('ok: true');
    await page.getByRole('button', { name: 'Back to archive', exact: true }).click();
    await browserExpect(page.locator('.ve-archive-breadcrumb')).toContainText('config');
    await browserExpect(
      page.locator('.ve-entry').getByText('settings.json', { exact: true }),
    ).toBeVisible();
    await harness.screenshot(page, 'file-viewer-archive-desktop-en');
    await page
      .locator('.ve-archive-breadcrumb')
      .getByRole('button', { name: 'viewer.zip', exact: true })
      .click();
    await page.locator('.ve-entry').getByText('README.txt', { exact: true }).click();
    await browserExpect(page.locator('.cm-content')).toContainText('Read-only archive text');
    await browserExpect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    expect(errors).toEqual([]);
  });

  it('displays typed SQLite values read-only, native audio and truthful unsupported video', async () => {
    await open('viewer.sqlite');
    await page.getByLabel('Tables', { exact: true }).selectOption('players');
    await browserExpect(page.locator('.ve-table-scroll')).toContainText('9007199254740993123');
    await browserExpect(page.locator('.ve-table-scroll')).toContainText('Binary data · 3 B');
    await browserExpect(page.getByText('Read only', { exact: true })).toBeVisible();
    await harness.screenshot(page, 'file-viewer-sqlite-desktop-en');
    await open('viewer.wav');
    await browserExpect
      .poll(() => page.locator('audio').evaluate((audio) => (audio as HTMLAudioElement).duration))
      .toBe(1);
    await open('unsupported.avi');
    await browserExpect(
      page.getByText(
        'The browser cannot play this file, or the file is unavailable. Download it to open it locally.',
      ),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  it('keeps Italian mobile preview, chooser and keyboard access usable', async () => {
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await open('viewer.json5');
    await browserExpect(page.locator('.ve-json')).toContainText('0x10');
    await harness.screenshot(page, 'file-viewer-json-mobile-it');
    await page.getByRole('button', { name: 'Apri con', exact: true }).click();
    await browserExpect(page.getByRole('dialog')).toContainText('Albero JSON');
    await harness.screenshot(page, 'file-viewer-open-with-mobile-it');
    const accessibility = await new AxeBuilder({ page }).include('.ve-chooser').analyze();
    expect(accessibility.violations).toEqual([]);
    await page.keyboard.press('Escape');
    await browserExpect(page.getByRole('dialog')).not.toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
  it('keeps the existing editor and downloads usable without viewer configuration or preference reads', async () => {
    viewerAvailable = false;
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'en' });
    const previousReads = preferenceReads;
    await open('viewer.json');
    await browserExpect(page.locator('.cm-content')).toContainText('9007199254740993123456789');
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    const chooser = page.getByRole('dialog');
    await browserExpect(chooser).toContainText('File previews are not configured.');
    await browserExpect(chooser.getByRole('radio')).toHaveCount(1);
    await browserExpect(chooser.getByRole('checkbox')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await open('viewer.zip');
    await browserExpect(page.locator('.fm-editor-view')).toContainText('binary file');
    await browserExpect(page.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
    expect(preferenceReads).toBe(previousReads);
    expect(errors).toEqual([]);
    viewerAvailable = true;
  });
});
