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
  let preferenceWrites = 0;
  let viewerMetadataFailure: 'capabilities' | 'preferences' | undefined;
  let rejectPreference = false;
  let holdPreference: Promise<void> | undefined;

  beforeAll(async () => {
    harness = await browserHarness({
      browser: process.env.NH_BROWSER === 'firefox' ? 'firefox' : 'chromium',
    });
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
    remote.set('forced.dat', Buffer.from('{"forced":true}'));
    remote.set('readable.txt', Buffer.from('Text editing remains available.'));
    remote.set('viewer.json5', Buffer.from("{ // comment\n name:'Alex', limit:0x10, }"));
    remote.set(
      'viewer.svg',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect width="400" height="200" fill="#315a48"/><circle cx="200" cy="100" r="50" fill="#f0cf88"/><script>window.viewerScriptRan=true;fetch("/viewer-script-must-not-run")</script></svg>',
      ),
    );
    remote.set(
      'frame-large.svg',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="2400" viewBox="0 0 4000 2400"><rect width="4000" height="2400" fill="#315a48"/><path d="M0 1200H4000M2000 0V2400" stroke="#74998a" stroke-width="20"/><circle cx="2000" cy="1200" r="500" fill="#f0cf88"/></svg>',
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
    for (const [name, attributes, width, height] of [
      ['sharp.svg', 'width="32" height="32" viewBox="0 0 32 32"', 32, 32],
      ['sharp-styled.svg', 'width="32" height="32" viewBox="0 0 32 32"', 32, 32],
      ['sharp-no-viewbox.svg', 'width="32" height="32"', 32, 32],
      ['sharp-viewbox-only.svg', 'viewBox="0 0 32 32"', 32, 32],
      ['sharp-large.svg', 'width="1000" height="480" viewBox="0 0 1000 480"', 1000, 480],
    ] as const) {
      remote.set(
        name,
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${name === 'sharp-styled.svg' ? '<style>:root > rect {fill:white}</style><rect width="100%" height="100%" fill="red"/>' : `<rect width="${width}" height="${height}" fill="white"/>`}<path d="M0 0H${width}L0 ${height}Z" fill="black"/><script>window.viewerScriptRan=true;fetch("/viewer-script-must-not-run")</script><image href="/viewer-script-must-not-run" width="1" height="1"/></svg>`,
        ),
      );
    }
    remote.set(
      'hostile.svg',
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" onload="parent.viewerScriptRan=true">
      <style>@import url('/viewer-script-must-not-run'); :root > rect {fill:#fff}</style>
      <script>parent.viewerScriptRan=true;window.viewerScriptRan=true</script>
      <defs><linearGradient id="paint"><stop stop-color="#000"/><stop offset="1" stop-color="#000"/></linearGradient><clipPath id="clip"><rect width="50" height="100"/></clipPath><path id="shape" d="M0 0H100V100H0Z"/></defs>
      <rect width="100%" height="100%" fill="red"/><use href="#shape" fill="url(#paint)" clip-path="url(#clip)"/>
      <foreignObject width="1" height="1"><div xmlns="http://www.w3.org/1999/xhtml"><meta http-equiv="refresh" content="0;url=/viewer-script-must-not-run"/><input autofocus="" onfocus="parent.viewerScriptRan=true"/><iframe src="/viewer-script-must-not-run"/><form action="/viewer-script-must-not-run"><input type="submit"/></form><img src="/viewer-script-must-not-run" onerror="parent.viewerScriptRan=true"/></div></foreignObject>
      <animate attributeName="opacity" from="1" to="1" dur="1s" onbegin="parent.viewerScriptRan=true"/>
    </svg>`),
    );
    const utf16 = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" fill="white"/><path d="M0 0H32L0 32Z" fill="black"/></svg>',
      'utf16le',
    );
    remote.set('sharp-utf16le.svg', Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]));
    remote.set(
      'sharp-utf16be.svg',
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf16).swap16()]),
    );
    for (const [name, transform] of [
      ['translate', 'transform="translate(20 0)"'],
      ['scale', 'transform="scale(2)"'],
      ['css', 'style="transform:translate(20px,0)"'],
    ]) {
      remote.set(
        `root-${name}.svg`,
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" ' +
            transform +
            '><rect width="100" height="100" fill="black"/></svg>',
        ),
      );
    }
    const transparentPng = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas');
      context.fillStyle = '#315a48';
      context.beginPath();
      context.moveTo(70, 40);
      context.lineTo(210, 128);
      context.lineTo(70, 216);
      context.closePath();
      context.fill();
      return canvas.toDataURL('image/png').split(',')[1] ?? '';
    });
    remote.set('transparent.png', Buffer.from(transparentPng, 'base64'));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/viewer-script-must-not-run', async (route) => {
      scriptRequests++;
      await route.fulfill({ status: 200, body: 'blocked fixture must not be reached' });
    });
    await page.route(`**${endpoint}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.searchParams.get('path') ?? '';
      const action = url.pathname.slice(endpoint.length);
      if (request.method() === 'GET' && action === `/${viewerMetadataFailure}`) {
        await route.fulfill({ status: 503, json: { code: 'internal_error' } });
        return;
      }
      if (action === '/preferences') {
        if (request.method() === 'GET') preferenceReads++;
        if (request.method() === 'PUT') {
          preferenceWrites++;
          if (holdPreference) await holdPreference;
          if (rejectPreference) {
            await route.fulfill({ status: 503, json: { code: 'internal_error' } });
            return;
          }
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
    const header = page.locator('.fm-toolbar-editing');
    const actions = header.locator('.fm-editor-toolbar');
    await browserExpect(
      actions.getByRole('button', { name: /^(Open with|Apri con)$/ }),
    ).toBeVisible();
    const labels = await actions
      .getByRole('button')
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent),
      );
    expect(labels.slice(-3)).toEqual(
      labels.includes('Apri con')
        ? ['Apri con', 'Torna ai file', 'Scarica']
        : ['Open with', 'Back to files', 'Download'],
    );
    const breadcrumb = await header.locator('.fm-breadcrumb').boundingBox();
    const bar = await actions.boundingBox();
    if (!breadcrumb || !bar) throw new Error('Missing file header');
    expect(breadcrumb.width).toBeGreaterThan(25);
    expect(Math.abs(breadcrumb.y + breadcrumb.height / 2 - bar.y - bar.height / 2)).toBeLessThan(2);
    await browserExpect(page.locator('.ve-engine > .ve-toolbar')).toHaveCount(0);
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
    await browserExpect(page.locator('.ve-svg-surface')).toBeVisible();
    await browserExpect(page.locator('.ve-svg-surface')).toHaveAttribute(
      'data-natural-width',
      '400',
    );
    expect(await page.evaluate(() => 'viewerScriptRan' in window)).toBe(false);
    expect(scriptRequests).toBe(0);
    await page.getByRole('button', { name: 'Actual size', exact: true }).click();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await browserExpect(
      page.getByRole('button', { name: 'Zoom: 125%', exact: true }),
    ).toBeVisible();
    await harness.screenshot(page, 'file-viewer-image-desktop-en');
    await root();
    await page.locator('.fm-filename').getByText('viewer.ico', { exact: true }).click();
    await browserExpect(page.getByLabel('Icon image')).toBeVisible();
    await browserExpect(page.getByLabel('Icon image').locator('option')).toHaveCount(2);
    await page.getByLabel('Icon image').focus();
    await page.keyboard.press('ArrowDown');
    await browserExpect(page.getByLabel('Icon image')).toHaveValue('1');
    await browserExpect(page.getByLabel('Icon image')).toBeFocused();
    await browserExpect
      .poll(() =>
        page
          .locator('.ve-image-stage img')
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(32);
    const fittedIcon = await frameGeometry();
    expect(fittedIcon.scale).toBeCloseTo(
      Math.min(50, fittedIcon.width / 32, fittedIcon.height / 32),
      5,
    );
    await page.getByRole('button', { name: 'Actual size', exact: true }).click();
    expect((await frameGeometry()).scale).toBeCloseTo(1, 5);
    await page.getByLabel('Icon image').focus();
    await page.keyboard.press('ArrowUp');
    await browserExpect(page.getByLabel('Icon image')).toHaveValue('0');
    await browserExpect(page.getByLabel('Icon image')).toBeFocused();
    await browserExpect.poll(async () => (await frameGeometry()).scale).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Actual size', exact: true }).click();
    expect((await frameGeometry()).scale).toBeCloseTo(1, 5);
    expect(errors).toEqual([]);
  });

  it('fits a small transparent PNG up to the viewport and restores natural pixels', async () => {
    await open('transparent.png');
    await browserExpect(
      page.getByRole('button', { name: 'Actual size', exact: true }),
    ).toBeEnabled();
    const fitted = await frameGeometry();
    expect(fitted.scale).toBeCloseTo(Math.min(50, fitted.width / 256, fitted.height / 256), 5);
    expect(fitted.scale).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Actual size', exact: true }).click();
    expect((await frameGeometry()).scale).toBeCloseTo(1, 5);
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    expect((await frameGeometry()).scale).toBeCloseTo(fitted.scale, 5);
    await harness.screenshot(page, 'file-viewer-frame-transparent-fit-en');
    await page.locator('.ve-zoom-value').click();
    await page.getByRole('textbox', { name: 'Zoom (%)', exact: true }).fill('99999');
    await page.keyboard.press('Enter');
    expect((await frameGeometry()).scale).toBe(50);
    await browserExpect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled();
    expect(errors).toEqual([]);
  });

  it('renders SVG vectors sharply at fifty thousand percent without enabling embedded content', async () => {
    for (const name of [
      'sharp.svg',
      'sharp-no-viewbox.svg',
      'sharp-viewbox-only.svg',
      'sharp-large.svg',
      'sharp-styled.svg',
      'sharp-utf16le.svg',
      'sharp-utf16be.svg',
    ]) {
      await open(name);
      await page.getByRole('button', { name: 'Actual size', exact: true }).click();
      const contentReads = reads.length;
      await page.locator('.ve-zoom-value').click();
      await page.getByRole('textbox', { name: 'Zoom (%)', exact: true }).fill('50000');
      await page.keyboard.press('Enter');
      expect((await frameGeometry()).scale).toBeCloseTo(500, 4);
      await browserExpect(page.locator('.ve-zoom-value')).toHaveText('50·000%');
      const rendering = await page.locator('.ve-svg-surface').evaluate((element) => {
        const frame = element as HTMLIFrameElement;
        const root = frame.contentDocument?.documentElement;
        if (!root || !frame.contentWindow) throw new Error('Missing SVG document');
        return {
          width: root.getBoundingClientRect().width,
          naturalWidth: Number(frame.dataset.naturalWidth),
          frameWidth: frame.clientWidth,
          viewportWidth: frame.parentElement?.parentElement?.clientWidth,
          sandbox: frame.getAttribute('sandbox'),
          scriptRan: 'viewerScriptRan' in frame.contentWindow,
        };
      });
      expect(rendering.width / rendering.naturalWidth).toBeCloseTo(500, 4);
      expect(rendering.frameWidth).toBe(rendering.viewportWidth);
      expect(rendering.sandbox).toBe('allow-same-origin');
      expect(rendering.scriptRan).toBe(false);
      const screenshot = await page.locator('.ve-image-stage').screenshot();
      const pixels = await page.evaluate(async (base64) => {
        const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
        const image = await createImageBitmap(blob);
        // Decode only the viewport screenshot, never a zoom-sized canvas.
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('canvas');
        context.drawImage(image, 0, 0);
        const row = context.getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data;
        let gray = 0,
          black = 0,
          white = 0;
        for (let index = 0; index < row.length; index += 4) {
          const red = row[index] ?? 0;
          if (red <= 8) black++;
          else if (red >= 247) white++;
          else gray++;
        }
        image.close();
        return { gray, black, white, width: canvas.width };
      }, screenshot.toString('base64'));
      // A vector diagonal has only a narrow antialiased edge, not enlarged source pixels.
      expect(pixels.gray, name).toBeLessThanOrEqual(4);
      expect(pixels.black, name).toBeGreaterThan(pixels.width / 4);
      expect(pixels.white, name).toBeGreaterThan(pixels.width / 4);
      expect(await page.evaluate(() => 'viewerScriptRan' in window)).toBe(false);
      expect(scriptRequests).toBe(0);
      expect(reads.length).toBe(contentReads);
      if (name === 'sharp.svg')
        await harness.screenshot(
          page,
          `file-viewer-frame-svg-50000-en${process.env.NH_BROWSER === 'firefox' ? '-firefox' : ''}`,
        );
    }
    expect(errors).toEqual([]);
  });

  it('isolates native SVG scripts, navigation and resources while preserving root styles and local paint references', async () => {
    await open('hostile.svg');
    await page.getByRole('button', { name: 'Actual size', exact: true }).click();
    await frameGeometry();
    const frame = page.locator('.ve-svg-surface');
    const result = await frame.evaluate((element) => {
      const frame = element as HTMLIFrameElement,
        doc = frame.contentDocument;
      if (!doc || !frame.contentWindow) throw new Error('Missing document');
      return {
        root: doc.documentElement.localName,
        script: 'viewerScriptRan' in frame.contentWindow,
        focused: doc.activeElement?.localName,
        fill: frame.contentWindow.getComputedStyle(
          doc.documentElement.querySelector(':scope > rect') as Element,
        ).fill,
      };
    });
    expect(result.root).toBe('svg');
    expect(result.script).toBe(false);
    expect(result.fill).toBe('rgb(255, 255, 255)');
    const screenshot = await frame.screenshot();
    const colors = await page.evaluate(async (base64) => {
      const bitmap = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${base64}`)).blob(),
      );
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas');
      context.drawImage(bitmap, 0, 0);
      const y = Math.floor(canvas.height / 2);
      const left = [...context.getImageData(Math.floor(canvas.width / 2 - 25), y, 1, 1).data];
      const right = [...context.getImageData(Math.floor(canvas.width / 2 + 25), y, 1, 1).data];
      bitmap.close();
      return { left, right };
    }, screenshot.toString('base64'));
    expect(colors.left).toEqual([0, 0, 0, 255]);
    expect(colors.right).toEqual([255, 255, 255, 255]);
    await browserExpect(
      page.getByRole('button', { name: 'Actual size', exact: true }),
    ).toBeFocused();
    expect(await page.evaluate(() => 'viewerScriptRan' in window)).toBe(false);
    expect(scriptRequests).toBe(0);
    await browserExpect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
    await browserExpect(frame).toHaveAttribute('inert', '');
    expect(errors).toEqual([]);
  });

  it('clips SVG root transforms to the natural canvas at actual size and zoom', async () => {
    for (const name of ['translate', 'scale', 'css']) {
      await open(`root-${name}.svg`);
      for (const zoom of [100, 200]) {
        await page.getByRole('button', { name: 'Actual size', exact: true }).click();
        if (zoom === 200) {
          await page.locator('.ve-zoom-value').click();
          await page.getByRole('textbox', { name: 'Zoom (%)', exact: true }).fill('200');
          await page.keyboard.press('Enter');
        }
        await frameGeometry();
        const screenshot = await page.locator('.ve-image-stage').screenshot();
        const black = await page.evaluate(async (base64) => {
          const bitmap = await createImageBitmap(
            await (await fetch(`data:image/png;base64,${base64}`)).blob(),
          );
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('canvas');
          context.drawImage(bitmap, 0, 0);
          const row = context.getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data;
          let black = 0;
          for (let i = 0; i < row.length; i += 4) if ((row[i] ?? 255) <= 8) black++;
          bitmap.close();
          return black;
        }, screenshot.toString('base64'));
        expect(Math.abs(black - (zoom - (name === 'scale' ? 0 : 20)))).toBeLessThanOrEqual(1);
      }
    }
  });

  async function frameGeometry() {
    // Input bursts are painted once per animation frame; inspect the committed frame.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    return page.locator('.ve-image-stage').evaluate((stage) => {
      const image = stage.querySelector('img');
      const frame = stage.querySelector<HTMLIFrameElement>('iframe');
      const svg = frame?.contentDocument?.documentElement;
      const rendered = image ?? svg;
      if (!rendered) throw new Error('Missing frame image');
      const box = stage.getBoundingClientRect();
      const naturalWidth = image ? image.naturalWidth : Number(frame?.dataset.naturalWidth);
      const picture = rendered.getBoundingClientRect();
      const offset = frame?.getBoundingClientRect();
      const x = picture.x + (offset?.x ?? 0),
        y = picture.y + (offset?.y ?? 0);
      const scale = picture.width / naturalWidth;
      return {
        scale,
        width: box.width,
        height: box.height,
        x: x + picture.width / 2 - box.x - box.width / 2,
        y: y + picture.height / 2 - box.y - box.height / 2,
        centerX: (box.x + box.width / 2 - x) / scale,
        centerY: (box.y + box.height / 2 - y) / scale,
      };
    });
  }

  it('keeps Frame fit, actual pixels, edited percentages and center-based keyboard zoom consistent', async () => {
    await open('frame-large.svg');
    await browserExpect(
      page.getByRole('button', { name: 'Actual size', exact: true }),
    ).toBeEnabled();
    const fit = await frameGeometry();
    expect(fit.scale).toBeCloseTo(Math.min(1, fit.width / 4000, fit.height / 2400), 5);
    expect(fit.x).toBeCloseTo(0, 3);
    expect(fit.y).toBeCloseTo(0, 3);
    await page.getByRole('button', { name: 'Actual size', exact: true }).click();
    await browserExpect(
      page.getByRole('button', { name: 'Zoom: 100%', exact: true }),
    ).toBeVisible();
    expect((await frameGeometry()).scale).toBeCloseTo(1, 5);
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    expect((await frameGeometry()).scale).toBeCloseTo(fit.scale, 5);
    await page.locator('.ve-engine').focus();
    await page.keyboard.press('Control+Equal');
    expect((await frameGeometry()).scale).toBeCloseTo(fit.scale * 1.25, 5);
    await page.keyboard.press('Control+Minus');
    await page.keyboard.press('Meta+Equal');
    expect((await frameGeometry()).scale).toBeCloseTo(fit.scale * 1.25, 5);
    const stage = page.locator('.ve-image-stage');
    await stage.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    const before = await frameGeometry();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    const after = await frameGeometry();
    expect(after.scale).toBeCloseTo(before.scale * 1.25, 5);
    expect(Math.abs(after.centerX - before.centerX) * before.scale).toBeLessThan(0.05);
    // Firefox snaps layout to 1/60 CSS pixels; compare within a subpixel display budget.
    expect(Math.abs(after.centerY - before.centerY) * before.scale).toBeLessThan(0.05);
    await page.locator('.ve-zoom-value').click();
    const input = page.getByRole('textbox', { name: 'Zoom (%)', exact: true });
    await browserExpect(input).toBeFocused();
    await input.fill('125,5');
    await page.keyboard.press('Enter');
    await browserExpect(
      page.getByRole('button', { name: 'Zoom: 126%', exact: true }),
    ).toBeFocused();
    expect((await frameGeometry()).scale).toBeCloseTo(1.255, 5);
    expect(Math.abs((await frameGeometry()).centerX - before.centerX) * 1.255).toBeLessThan(0.05);
    await page.locator('.ve-zoom-value').click();
    await browserExpect(input).toHaveValue('126');
    await page.keyboard.press('Enter');
    expect((await frameGeometry()).scale).toBeCloseTo(1.255, 5);
    await page.locator('.ve-zoom-value').click();
    await input.fill('oops');
    await page.keyboard.press('Enter');
    await browserExpect(input).toHaveAttribute('aria-invalid', 'true');
    await browserExpect(page.getByRole('alert')).toContainText('Enter a valid zoom');
    expect((await frameGeometry()).scale).toBeCloseTo(1.255, 5);
    await page.keyboard.press('Escape');
    await browserExpect(page.locator('.ve-zoom-value')).toBeFocused();
    await page.getByRole('button', { name: 'Actual size', exact: true }).click();
    await page.setViewportSize({ width: 900, height: 740 });
    expect((await frameGeometry()).scale).toBeCloseTo(1, 5);
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await page.setViewportSize({ width: 780, height: 700 });
    await browserExpect
      .poll(async () => {
        const view = await frameGeometry();
        return Math.abs(view.scale - Math.min(1, view.width / 4000, view.height / 2400));
      })
      .toBeLessThan(0.00001);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await harness.screenshot(page, 'file-viewer-frame-fit-desktop-en');
    expect(errors).toEqual([]);
  });

  it('keeps Frame within image edges and SVG zoom between one and fifty thousand percent', async () => {
    await open('frame-large.svg');
    const stage = page.locator('.ve-image-stage');
    await page.getByRole('button', { name: 'Actual size', exact: true }).click();
    for (const direction of [-1, 1]) {
      await stage.evaluate((element, sign) => {
        element.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaX: sign * 1e6,
            deltaY: sign * 1e6,
          }),
        );
      }, direction);
      const view = await frameGeometry();
      expect(view.x).toBeCloseTo((-direction * (4000 - view.width)) / 2, 3);
      expect(view.y).toBeCloseTo((-direction * (2400 - view.height)) / 2, 3);
    }
    await stage.focus();
    await page.keyboard.press('ArrowRight');
    const edge = await frameGeometry();
    expect(edge.x).toBeCloseTo(-(4000 - edge.width) / 2, 3);
    const box = await stage.boundingBox();
    if (!box) throw new Error('Missing image viewport');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 - 100);
    await page.mouse.up();
    expect((await frameGeometry()).x).toBeCloseTo(edge.x, 3);
    expect((await frameGeometry()).y).toBeCloseTo(edge.y, 3);
    await page.setViewportSize({ width: 1900, height: 1100 });
    await browserExpect
      .poll(async () => {
        const view = await frameGeometry();
        return Math.abs(view.x + (4000 - view.width) / 2);
      })
      .toBeLessThan(0.001);
    await page.locator('.ve-zoom-value').click();
    await page.getByRole('textbox', { name: 'Zoom (%)', exact: true }).fill('0.01');
    await page.keyboard.press('Enter');
    await browserExpect(page.getByRole('button', { name: 'Zoom out', exact: true })).toBeDisabled();
    await stage.focus();
    await page.keyboard.press('Control+Minus');
    await stage.evaluate((element) => {
      element.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 100 }),
      );
      element.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 10000, deltaY: 10000 }),
      );
    });
    expect(await frameGeometry()).toMatchObject({ scale: 0.01, x: 0, y: 0 });
    await page.locator('.ve-zoom-value').click();
    await page.getByRole('textbox', { name: 'Zoom (%)', exact: true }).fill('99999');
    await page.keyboard.press('Enter');
    await browserExpect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled();
    await stage.focus();
    await page.keyboard.press('Control+Equal');
    expect((await frameGeometry()).scale).toBe(500);
    const corners = await page.locator('.ve-body').evaluate((element) => {
      const style = getComputedStyle(element);
      return [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomLeftRadius,
        style.borderBottomRightRadius,
      ];
    });
    expect(corners.slice(0, 2)).toEqual(['0px', '0px']);
    expect(corners.slice(2).every((radius) => Number.parseFloat(radius) > 0)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(errors).toEqual([]);
  });

  it('pans Frame with trackpad deltas and anchors pinch zoom without browser zoom or duplicate gesture updates', async () => {
    await open('frame-large.svg');
    const stage = page.locator('.ve-image-stage');
    await browserExpect(
      page.getByRole('button', { name: 'Actual size', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Actual size', exact: true }).click();
    const start = await frameGeometry();
    const pageScroll = await page.evaluate(() => window.scrollY);
    const cancelled = await stage.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return !element.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaX: 75,
          deltaY: 40,
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2,
        }),
      );
    });
    expect(cancelled).toBe(true);
    const panned = await frameGeometry();
    expect(panned.x).toBeCloseTo(start.x - 75, 3);
    expect(panned.y).toBeCloseTo(start.y - 40, 3);
    const pinchAnchor = await stage.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -Math.log(2) / 0.01,
        clientX: rect.x + rect.width / 2 + 60,
        clientY: rect.y + rect.height / 2 - 40,
      });
      element.dispatchEvent(event);
      return {
        x: event.clientX - rect.x - rect.width / 2,
        y: event.clientY - rect.y - rect.height / 2,
      };
    });
    const pinched = await frameGeometry();
    expect(pinched.scale).toBeCloseTo(panned.scale * 2, 5);
    expect((pinchAnchor.x - pinched.x) / pinched.scale).toBeCloseTo(
      (pinchAnchor.x - panned.x) / panned.scale,
      2,
    );
    expect((pinchAnchor.y - pinched.y) / pinched.scale).toBeCloseTo(
      (pinchAnchor.y - panned.y) / panned.scale,
      2,
    );
    await stage.evaluate((element) => {
      for (let index = 0; index < 10; index++)
        element.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 5, deltaY: 3 }),
        );
    });
    expect((await frameGeometry()).x).toBeCloseTo(pinched.x - 50, 3);
    expect((await frameGeometry()).y).toBeCloseTo(pinched.y - 30, 3);
    await stage.evaluate((element) => {
      for (const [type, scale] of [
        ['gesturestart', 1],
        ['gesturechange', 1.5],
        ['gestureend', 1.5],
      ] as const) {
        element.dispatchEvent(
          Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale }),
        );
        if (type === 'gesturestart')
          element.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              ctrlKey: true,
              deltaY: -25,
            }),
          );
      }
    });
    expect((await frameGeometry()).scale).toBeCloseTo(pinched.scale * 1.5, 5);
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll);
    const stable = await frameGeometry();
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    const allowed = await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Frame', exact: true })
      .evaluate((element) =>
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: '+',
            ctrlKey: true,
          }),
        ),
      );
    expect(allowed).toBe(true);
    expect((await frameGeometry()).scale).toBeCloseTo(stable.scale, 5);
    await page.keyboard.press('Escape');
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await open('frame-large.svg');
    await browserExpect(page.getByRole('button', { name: 'Adatta', exact: true })).toBeEnabled();
    await page.locator('.ve-zoom-value').click();
    await page.getByRole('textbox', { name: 'Zoom (%)', exact: true }).fill('50');
    await page.keyboard.press('Enter');
    await browserExpect(page.getByRole('button', { name: 'Zoom: 50%', exact: true })).toBeVisible();
    await harness.screenshot(page, 'file-viewer-frame-mobile-it');
    expect(
      (await new AxeBuilder({ page }).include('.ve-image-viewer').analyze()).violations,
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'en' });
    await page.setViewportSize({ width: 1440, height: 1000 });
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
    await browserExpect(dialog.getByRole('radio')).toHaveCount(0);
    await browserExpect(dialog.getByRole('checkbox')).toHaveCount(0);
    await browserExpect(dialog.getByRole('button', { name: /^(Open|Cancel)$/ })).toHaveCount(0);
    await browserExpect(
      dialog.getByRole('button', { name: 'Scribe', exact: true }),
    ).toHaveAccessibleDescription('Text editor');
    await dialog.getByRole('combobox', { name: 'My choice for .json' }).selectOption('server');
    await harness.screenshot(page, 'file-viewer-open-with-desktop-en');
    await dialog.getByRole('button', { name: 'Scribe', exact: true }).click();
    await browserExpect(page.locator('.cm-content')).toContainText('9007199254740993123456789');
    expect(preferences).toContainEqual({ scope: 'server', extension: 'json', viewerId: 'text' });
    await root();
    await page.locator('.fm-filename').getByText('viewer.json', { exact: true }).click();
    await browserExpect(page.locator('.cm-content')).toBeVisible();
    expect(await page.getByRole('dialog').isVisible()).toBe(false);
    expect(errors).toEqual([]);
  });

  it('opens cards immediately, preserves one-time choices and saves each personal scope', async () => {
    preferences.length = 0;
    await open('viewer.json');
    const writesBefore = preferenceWrites;
    const trigger = page.getByRole('button', { name: 'Open with', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await browserExpect(
      dialog.getByRole('button', { name: 'JSON Tree', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await browserExpect(dialog.getByRole('button', { name: 'Scribe', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await browserExpect(page.locator('.cm-content')).toBeFocused();
    expect(preferenceWrites).toBe(writesBefore);
    for (const scope of ['global', 'game', 'server']) {
      await trigger.click();
      await dialog.getByRole('combobox').selectOption(scope);
      await dialog.getByRole('button', { name: 'JSON Tree', exact: true }).focus();
      await page.keyboard.press('Space');
      await browserExpect(dialog).not.toBeVisible();
      expect(preferences).toContainEqual({ scope, extension: 'json', viewerId: 'json' });
    }
    await trigger.click();
    await browserExpect(dialog.getByRole('combobox')).toHaveValue('once');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await browserExpect(trigger).toBeFocused();
    expect(errors).toEqual([]);
  });

  it('retains the chooser on failed preference saves and prevents duplicate activation', async () => {
    await open('viewer.json5');
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox').selectOption('server');
    rejectPreference = true;
    let release!: () => void;
    holdPreference = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writesBefore = preferenceWrites;
    const scribe = dialog.getByRole('button', { name: 'Scribe', exact: true });
    try {
      await scribe.evaluate((element) => {
        (element as HTMLButtonElement).click();
        (element as HTMLButtonElement).click();
      });
      await browserExpect.poll(() => preferenceWrites).toBe(writesBefore + 1);
      await browserExpect(scribe).toBeDisabled();
      await browserExpect(dialog.getByRole('combobox')).toBeDisabled();
      await browserExpect(
        dialog.getByRole('button', { name: 'Close', exact: true }),
      ).toBeDisabled();
      await browserExpect(dialog.getByRole('status')).not.toBeEmpty();
      await page.keyboard.press('Escape');
      await browserExpect(dialog).toBeVisible();
    } finally {
      release();
      holdPreference = undefined;
    }
    await browserExpect(dialog.getByRole('alert')).toBeVisible();
    await browserExpect(scribe).toBeEnabled();
    expect(preferences.some((value) => value.extension === 'json5')).toBe(false);
    await harness.screenshot(page, 'file-viewer-open-with-error-en');
    rejectPreference = false;
    await scribe.click();
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(page.locator('.cm-content')).toBeFocused();
    expect(preferences).toContainEqual({ scope: 'server', extension: 'json5', viewerId: 'text' });
    preferences.length = 0;
    expect(errors).toEqual([]);
  });

  it('offers all viewers and honors a forced default for an unmatched extension', async () => {
    preferences.length = 0;
    await open('forced.dat');
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog.locator('.ve-viewer-card')).toHaveCount(0);
    const before = reads.length;
    await dialog.getByRole('button', { name: 'Show all', exact: true }).click();
    await browserExpect(dialog.locator('.ve-viewer-card')).toHaveCount(7);
    expect(reads.length).toBe(before);
    await dialog.getByRole('combobox').selectOption('server');
    await harness.screenshot(page, 'file-viewer-all-desktop-en');
    await dialog.getByRole('button', { name: 'JSON Tree', exact: true }).click();
    await browserExpect(page.locator('.ve-json')).toContainText('forced: true');
    await root();
    await page
      .locator('.fm-filename')
      .getByText('forced.dat', { exact: true })
      .click({ button: 'right' });
    await browserExpect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeEnabled();
    await page.getByRole('menuitem', { name: 'Open', exact: true }).click();
    await browserExpect(page.locator('.ve-json')).toContainText('forced: true');
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    await browserExpect(dialog.locator('.ve-viewer-card')).toHaveCount(7);
    await dialog.getByRole('button', { name: 'Show suggested', exact: true }).click();
    await browserExpect(dialog.locator('.ve-viewer-card')).toHaveCount(0);
    await page.keyboard.press('Escape');
    preferences.length = 0;
    expect(errors).toEqual([]);
  });

  it('offers all viewers without pretending mismatched content is readable', async () => {
    await open('viewer.json');
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Show all', exact: true }).click();
    const frame = dialog.getByRole('button', { name: 'Frame', exact: true });
    await frame.focus();
    await page.keyboard.press('Enter');
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(
      page.getByText('The image cannot be displayed. Check its format or download it.', {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Open with', exact: true }).click();
    await browserExpect(dialog.locator('.ve-viewer-card')).toHaveCount(7);
    await dialog.getByRole('button', { name: 'JSON Tree', exact: true }).click();
    await browserExpect(page.locator('.ve-json')).toContainText('9007199254740993123456789');
    expect(errors).toEqual([]);
  });

  it('keeps text editing available when optional viewer metadata is unavailable', async () => {
    try {
      for (const endpoint of ['capabilities', 'preferences'] as const) {
        viewerMetadataFailure = endpoint;
        await open('readable.txt');
        await browserExpect(page.locator('.cm-content')).toContainText(
          'Text editing remains available.',
        );
        await browserExpect(page.getByRole('alert')).toContainText(
          'The request failed. Try again or check Activity.',
        );
      }
    } finally {
      viewerMetadataFailure = undefined;
    }
    expect(errors).toEqual([]);
  });

  it('navigates archives as virtual folders, previews entries and returns to the same directory', async () => {
    preferences.length = 0;
    await open('viewer.zip');
    await page.locator('.ve-entry').getByText('config', { exact: true }).click();
    await page.locator('.ve-entry').getByText('settings.json', { exact: true }).click();
    await browserExpect(page.locator('.ve-json')).toContainText('ok: true');
    const openWith = page
      .locator('.fm-toolbar-editing')
      .getByRole('button', { name: 'Open with', exact: true });
    await openWith.click();
    await browserExpect(page.getByRole('dialog').locator('.ve-chooser-filename')).toHaveText(
      'settings.json',
    );
    await page.getByRole('dialog').getByRole('button', { name: 'Show all', exact: true }).click();
    await browserExpect(page.getByRole('dialog').locator('.ve-viewer-card')).toHaveCount(5);
    await browserExpect(
      page.getByRole('dialog').getByRole('button', { name: /^(Atlas|Data Grid)$/ }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await browserExpect(openWith).toBeFocused();
    const downloaded = page.waitForEvent('download');
    await page
      .locator('.fm-toolbar-editing')
      .getByRole('button', { name: 'Download', exact: true })
      .click();
    const downloadedUrl = new URL((await downloaded).url());
    expect(downloadedUrl.searchParams.get('path')).toBe('viewer.zip');
    expect(downloadedUrl.searchParams.get('entry')).toBe('config/settings.json');
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
    await browserExpect(page.getByRole('dialog')).toContainText('JSON Tree');
    await browserExpect(
      page.getByRole('dialog').getByRole('button', { name: 'Scribe', exact: true }),
    ).toHaveAccessibleDescription('Editor di testo');
    await harness.screenshot(page, 'file-viewer-open-with-mobile-it');
    const accessibility = await new AxeBuilder({ page }).include('.ve-chooser').analyze();
    expect(accessibility.violations).toEqual([]);
    await page.setViewportSize({ width: 320, height: 740 });
    await browserExpect(page.getByRole('dialog')).toBeVisible();
    const bounds = await page
      .getByRole('dialog')
      .evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth }));
    expect(bounds.content).toBeLessThanOrEqual(bounds.width);
    await harness.screenshot(page, 'file-viewer-open-with-320-it');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Mostra tutti', exact: true })
      .click();
    await browserExpect(page.getByRole('dialog').locator('.ve-viewer-card')).toHaveCount(7);
    await harness.screenshot(page, 'file-viewer-all-320-it');
    await page.getByRole('dialog').getByRole('button', { name: 'Frame', exact: true }).focus();
    for (let index = 0; index < 6; index++) await page.keyboard.press('Tab');
    const scribe = page.getByRole('dialog').getByRole('button', { name: 'Scribe', exact: true });
    await browserExpect(scribe).toBeFocused();
    const card = await scribe.boundingBox();
    const grid = await page.locator('.ve-viewer-options-all').boundingBox();
    if (!card || !grid) throw new Error('Missing expanded viewer list');
    expect(card.y + card.height).toBeLessThanOrEqual(grid.y + grid.height + 1);
    const allAccessibility = await new AxeBuilder({ page }).include('.ve-chooser').analyze();
    expect(allAccessibility.violations).toEqual([]);
    const expanded = await page
      .getByRole('dialog')
      .evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth }));
    expect(expanded.content).toBeLessThanOrEqual(expanded.width);
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
    await browserExpect(chooser.locator('.ve-viewer-card')).toHaveCount(1);
    await browserExpect(chooser.getByRole('button', { name: 'Scribe', exact: true })).toBeEnabled();
    await browserExpect(chooser.getByRole('combobox')).toHaveCount(0);
    await browserExpect(chooser.getByRole('button', { name: 'Show all', exact: true })).toHaveCount(
      0,
    );
    const card = await chooser.locator('.ve-viewer-card').boundingBox();
    const grid = await chooser.locator('.ve-viewer-options').boundingBox();
    if (!card || !grid) throw new Error('Missing single viewer card');
    expect(Math.abs(card.x + card.width / 2 - grid.x - grid.width / 2)).toBeLessThan(2);
    await page.keyboard.press('Escape');
    await open('viewer.zip');
    await browserExpect(page.locator('.fm-editor-view')).toContainText('binary file');
    await browserExpect(page.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
    expect(preferenceReads).toBe(previousReads);
    expect(errors).toEqual([]);
    viewerAvailable = true;
  });
});
