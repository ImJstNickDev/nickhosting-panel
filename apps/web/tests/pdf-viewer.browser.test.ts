import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { authorizeServer } from '@nickhosting/server-management';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { closeFileViewers, closeViewerArchives } from '../../api/src/file-viewers.js';
import { ViewerCache } from '../../api/src/viewer-cache.js';
import { FileViewerService } from '../../api/src/viewer-service.js';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { pdfFixture } from './pdf-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

/** Real PDF.js and authenticated content/Range handlers; only the remote file source is a fixture. */
describe('Folio read-only PDF journey', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let root: string;
  let cache: ViewerCache;
  let base: string;
  let remote: Map<string, Buffer>;
  let revision = 1;
  const errors: string[] = [];
  const writes: string[] = [];
  const contentRequests: {
    path: string;
    range: string | undefined;
    revision: string | undefined;
  }[] = [];
  let forbiddenRequests = 0;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nh-folio-browser-'));
    cache = new ViewerCache({ root: join(root, 'cache') });
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
    remote = await provider.files();
    remote.set('folio.pdf', pdfFixture());
    remote.set('large-folio.pdf', pdfFixture({ pages: 24, paddingBytes: 2 * 1024 * 1024 }));
    remote.set('locked-folio.pdf', pdfFixture({ password: 'orchid' }));
    remote.set('broken-folio.pdf', Buffer.from('%PDF-1.7\nnot a document'));
    remote.set('empty-folio.pdf', Buffer.alloc(0));
    remote.set('broken-page.pdf', pdfFixture({ corruptFirstPage: true }));
    const zip = new ZipFile();
    zip.addBuffer(pdfFixture(), 'inside.pdf');
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    remote.set('folio.zip', Buffer.concat(chunks));
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    vi.spyOn(FileViewerService.prototype, 'open').mockImplementation(
      async (context, _management, serverId, path) => {
        await authorizeServer(harness.database.db, context, serverId, 'server:read');
        const bytes = remote.get(path);
        if (!bytes) throw new Error(`Unknown fixture ${path}`);
        const current = revision;
        return {
          source: {
            size: bytes.length,
            mtimeMs: current,
            read: async (offset, length) => bytes.subarray(offset, offset + length),
            stream: (start = 0, end = bytes.length) =>
              new ReadableStream({
                start(controller) {
                  controller.enqueue(bytes.subarray(start, end));
                  controller.close();
                },
              }),
          },
          key: `${serverId}:${path}:${current}`,
          path,
          cache,
          signal: new AbortController().signal,
          close: async () => {},
          restat: async () => ({ size: bytes.length, mtimeMs: revision, mode: 0o644 }),
          siblingExists: async () => false,
        };
      },
    );
    await page.route('**/files/viewer/capabilities', (route) =>
      route.fulfill({ json: { available: true } }),
    );
    await page.route('**/folio-script-must-not-run', (route) => {
      forbiddenRequests++;
      return route.abort();
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      const url = new URL(request.url());
      // Directory prefetch is a read-only POST; all actual file mutation endpoints remain counted.
      if (
        url.pathname.includes('/files/') &&
        !url.pathname.endsWith('/files/directories') &&
        !['GET', 'HEAD'].includes(request.method())
      )
        writes.push(`${request.method()} ${url.pathname}`);
      if (url.pathname.endsWith('/files/viewer/content'))
        contentRequests.push({
          path: url.searchParams.get('path') ?? '',
          range: request.headers().range,
          revision: request.headers()['if-match'],
        });
    });
  });
  afterAll(async () => {
    if (harness) {
      await closeViewerArchives(harness.database.db);
      await closeFileViewers(harness.database.db);
    }
    provider?.dispose();
    await harness?.close();
    await cache?.close();
    if (root) await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  async function open(name = 'folio.pdf', loaded = true) {
    await page.goto(base);
    await page.evaluate(() => sessionStorage.removeItem('nh.folio.positions.v1'));
    await page.locator('.fm-breadcrumb').getByRole('button', { name: 'root', exact: true }).click();
    await page.locator('.fm-filename').getByText(name, { exact: true }).click();
    await browserExpect(page.locator('.folio')).toBeVisible();
    if (loaded) {
      await browserExpect(
        page.locator('.folio .page[data-page-number="1"] .textLayer'),
      ).toContainText('Folio fixture page 1');
      await browserExpect(page.locator('.folio .page[data-page-number="1"] canvas')).toBeVisible();
    }
  }

  async function screenshot(name: string) {
    await page.mouse.move(0, 0);
    await browserExpect(page.getByRole('tooltip')).toHaveCount(0);
    await harness.screenshot(page, name);
  }

  it('isolates PDF styles from the application before, during and after viewing with dark OS preference', async () => {
    const shellStyles = () =>
      page.evaluate(() => {
        const sidebar = document.querySelector('#primary-navigation');
        if (!sidebar) throw new Error('Missing application sidebar');
        const style = getComputedStyle(sidebar);
        const rootStyle = getComputedStyle(document.documentElement);
        return {
          sidebar: {
            background: style.backgroundColor,
            color: style.color,
            border: style.border,
            shadow: style.boxShadow,
            radius: style.borderRadius,
            padding: style.padding,
            width: style.width,
            colorScheme: style.colorScheme,
          },
          root: {
            colorScheme: rootStyle.colorScheme,
            background: rootStyle.backgroundColor,
            color: rootStyle.color,
          },
        };
      });
    await page.emulateMedia({ colorScheme: 'dark' });
    try {
      await page.goto(base);
      await page
        .locator('.fm-breadcrumb')
        .getByRole('button', { name: 'root', exact: true })
        .click();
      const before = await shellStyles();
      // The application currently deliberately uses a light palette, regardless of OS preference.
      expect(before.root.colorScheme).toBe('light');
      expect(before.sidebar.background).toBe('rgb(235, 238, 236)');
      await screenshot('folio-shell-before-dark-preference');
      await page.locator('.fm-filename').getByText('folio.pdf', { exact: true }).click();
      await browserExpect(page.locator('.folio .textLayer').first()).toContainText(
        'Folio fixture page 1',
      );
      await browserExpect(page.locator('.folio canvas').first()).toBeVisible();
      expect(await shellStyles()).toEqual(before);
      const scrollbar = await page.locator('.folio-scroll').evaluate((element) => {
        const style = getComputedStyle(element);
        return { colorScheme: style.colorScheme, color: style.scrollbarColor };
      });
      expect(scrollbar.colorScheme).toBe(before.root.colorScheme);
      expect(scrollbar.color).not.toBe('auto');
      expect(scrollbar.color).not.toMatch(/^(?:black|rgb\(0, 0, 0\)|color\(srgb 0 0 0\))(?:\s|$)/);
      await screenshot('folio-shell-during-dark-preference');
      await page.getByRole('button', { name: 'Back to files', exact: true }).click();
      await browserExpect(page.locator('.folio')).toHaveCount(0);
      await browserExpect(
        page.locator('.fm-filename').getByText('folio.pdf', { exact: true }),
      ).toBeVisible();
      expect(await shellStyles()).toEqual(before);
      await screenshot('folio-shell-after-dark-preference');
      expect(errors).toEqual([]);
    } finally {
      await page.emulateMedia({ colorScheme: 'light' });
    }
  });

  it('renders selectable text, navigates mixed page sizes, zooms and rotates', async () => {
    await open();
    const pageNumber = page.getByRole('textbox', { name: 'Page number', exact: true });
    await browserExpect(pageNumber).toHaveValue('1');
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await browserExpect(pageNumber).toHaveValue('2');
    const second = page.locator('.folio .page[data-page-number="2"] canvas');
    await browserExpect(second).toBeVisible();
    await page.getByRole('button', { name: 'Actual size', exact: true }).click();
    await browserExpect
      .poll(async () => second.evaluate((canvas) => canvas.clientWidth > canvas.clientHeight))
      .toBe(true);
    await page.getByRole('button', { name: 'Rotate clockwise', exact: true }).click();
    await browserExpect
      .poll(async () => second.evaluate((canvas) => canvas.clientWidth < canvas.clientHeight))
      .toBe(true);
    const zoom = page.getByRole('textbox', { name: 'Zoom (%)', exact: true });
    const before = Number(await zoom.inputValue());
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await browserExpect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(before);
    await page.getByRole('button', { name: 'Fit width', exact: true }).click();
    await page.getByRole('button', { name: 'Fit page', exact: true }).click();
    await pageNumber.fill('1');
    await pageNumber.press('Enter');
    await browserExpect(pageNumber).toHaveValue('1');
    await screenshot('folio-desktop-en');
    expect(errors).toEqual([]);
  });

  it('finds text from shell focus and navigates outline and thumbnails', async () => {
    await open();
    await page.getByRole('button', { name: 'Back to files', exact: true }).focus();
    await page.keyboard.press('Control+f');
    const search = page.getByRole('searchbox', { name: 'Find in document', exact: true });
    await browserExpect(search).toBeFocused();
    await search.fill('Orchid');
    await search.press('Enter');
    await browserExpect(page.locator('.folio .highlight')).not.toHaveCount(0);
    await page.getByRole('button', { name: 'Next match', exact: true }).click();
    await search.fill('missing-search-term');
    await search.press('Enter');
    await browserExpect(page.locator('.folio-find [role="status"]')).toContainText(
      /0.*0|No matches/,
    );
    await screenshot('folio-search-empty-en');
    await page.getByRole('button', { name: 'Document outline', exact: true }).click();
    await page.getByRole('button', { name: 'Landscape chapter', exact: true }).click();
    await browserExpect(
      page.getByRole('textbox', { name: 'Page number', exact: true }),
    ).toHaveValue('2');
    await screenshot('folio-outline-en');
    await page.getByRole('button', { name: 'Page thumbnails', exact: true }).click();
    await page.getByRole('button', { name: 'Go to page 3', exact: true }).click();
    await browserExpect(
      page.getByRole('textbox', { name: 'Page number', exact: true }),
    ).toHaveValue('3');
    await screenshot('folio-thumbnails-en');
    expect(errors).toEqual([]);
  });

  it('keeps PDF forms, script and unsafe actions inert while retaining safe links', async () => {
    await open();
    const annotationLayer = page.locator('.folio .page[data-page-number="1"] .annotationLayer');
    const external = annotationLayer.locator('a[href="https://example.test/folio"]');
    await browserExpect(external).toHaveAttribute('target', '_blank');
    await browserExpect(external).toHaveAttribute('rel', /noopener/);
    await page
      .context()
      .route('https://example.test/folio', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<title>Isolated external link</title>' }),
      );
    try {
      const popup = page.waitForEvent('popup');
      await external.click();
      const opened = await popup;
      await opened.waitForLoadState('domcontentloaded');
      expect(opened.url()).toBe('https://example.test/folio');
      expect(await opened.evaluate(() => window.opener)).toBeNull();
      await opened.close();
    } finally {
      await page.context().unroute('https://example.test/folio');
    }
    await browserExpect(
      annotationLayer.locator('a[href^="javascript:"], a[href^="file:"]'),
    ).toHaveCount(0);
    await browserExpect(
      annotationLayer.locator(
        'input:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), select:not([disabled])',
      ),
    ).toHaveCount(0);
    await browserExpect(page.locator('.folio iframe, .folio embed, .folio object')).toHaveCount(0);
    expect(await page.evaluate(() => 'folioScriptRan' in globalThis)).toBe(false);
    expect(forbiddenRequests).toBe(0);
    expect(writes).toEqual([]);
    // PDF.js internal destinations are implemented as hash links.
    await annotationLayer.locator('a[href^="#"]').first().click();
    await browserExpect(
      page.getByRole('textbox', { name: 'Page number', exact: true }),
    ).toHaveValue('2');
  });

  it('loads a large PDF through revision-bound ranges and refreshes changed bytes', async () => {
    await open('large-folio.pdf');
    const requests = contentRequests.filter((request) => request.path === 'large-folio.pdf');
    expect(requests.some((request) => request.range?.startsWith('bytes='))).toBe(true);
    expect(requests.every((request) => !!request.revision)).toBe(true);
    await page.getByRole('textbox', { name: 'Page number', exact: true }).fill('24');
    await page.getByRole('textbox', { name: 'Page number', exact: true }).press('Enter');
    await browserExpect(
      page.locator('.folio .page[data-page-number="24"] .textLayer'),
    ).toContainText('Folio fixture page 24');
    const count = contentRequests.length;
    revision++;
    await page.getByRole('button', { name: 'Refresh PDF', exact: true }).click();
    await browserExpect(
      page.locator('.folio .page[data-page-number="24"] .textLayer'),
    ).toContainText('Folio fixture page 24');
    await browserExpect.poll(() => contentRequests.length).toBeGreaterThan(count);
    expect(contentRequests.at(-1)?.revision).not.toBe(requests[0]?.revision);
    expect(writes).toEqual([]);
  });

  it('shows loading and recoverable network errors without losing the viewer shell', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const route = '**/files/viewer/content?*';
    await page.route(route, async (request) => {
      await gate;
      await request.continue();
    });
    try {
      await open('folio.pdf', false);
      await browserExpect(page.locator('.folio [role="status"]')).toBeVisible();
      await screenshot('folio-loading-en');
    } finally {
      release();
      await page.unroute(route);
    }
    await browserExpect(page.locator('.folio .textLayer').first()).toContainText(
      'Folio fixture page 1',
    );
    await page.route(route, (request) =>
      request.fulfill({
        status: 503,
        json: { error: { code: 'internal_error', messageKey: 'error.internal' } },
      }),
    );
    await page.getByRole('button', { name: 'Refresh PDF', exact: true }).click();
    await browserExpect(page.locator('.folio [role="alert"]')).toBeVisible();
    await screenshot('folio-error-en');
    await page.unroute(route);
    await page.locator('.folio-feedback').getByRole('button').click();
    await browserExpect(page.locator('.folio .textLayer').first()).toContainText(
      'Folio fixture page 1',
    );
  });

  it('handles empty, malformed and encrypted PDFs, including a wrong password retry', async () => {
    for (const name of ['empty-folio.pdf', 'broken-folio.pdf', 'broken-page.pdf']) {
      await open(name, false);
      await browserExpect(page.locator('.folio [role="alert"]')).toBeVisible();
      await screenshot(name === 'empty-folio.pdf' ? 'folio-empty-en' : 'folio-malformed-en');
    }
    await open('locked-folio.pdf', false);
    await browserExpect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await screenshot('folio-password-en');
    await page.getByLabel('Password', { exact: true }).fill('wrong');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await browserExpect(page.locator('.folio')).toContainText(/incorrect|Incorrect/);
    await page.getByLabel('Password', { exact: true }).fill('orchid');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await browserExpect(page.locator('.folio .textLayer').first()).toContainText(
      'Folio fixture page 1',
    );
  });

  it('opens a PDF inside a real ZIP through the read-only archive content route', async () => {
    await page.goto(base);
    await page.locator('.fm-breadcrumb').getByRole('button', { name: 'root', exact: true }).click();
    await page.locator('.fm-filename').getByText('folio.zip', { exact: true }).click();
    await page.locator('.ve-archive .fm-filename').getByText('inside.pdf', { exact: true }).click();
    await browserExpect(page.locator('.folio .textLayer').first()).toContainText(
      'Folio fixture page 1',
    );
    await screenshot('folio-archive-en');
    expect(writes).toEqual([]);
  });

  it('prepares all print pages safely and releases the print frame after completion', async () => {
    await open();
    await page.evaluate(() => {
      const state = window as typeof window & {
        folioPrintPages?: number;
        folioPrintObserver?: MutationObserver;
      };
      state.folioPrintObserver = new MutationObserver(() => {
        const frame = document.querySelector<HTMLIFrameElement>('.folio-print-frame');
        const target = frame?.contentWindow;
        if (!target) return;
        target.print = () => {
          state.folioPrintPages = frame.contentDocument?.querySelectorAll('img').length ?? 0;
          target.dispatchEvent(new Event('afterprint'));
        };
      });
      state.folioPrintObserver.observe(document.body, { childList: true });
    });
    try {
      await page.getByRole('button', { name: 'Print', exact: true }).click();
      await browserExpect
        .poll(() =>
          page.evaluate(
            () => (window as typeof window & { folioPrintPages?: number }).folioPrintPages,
          ),
        )
        .toBe(3);
      await browserExpect(page.locator('.folio-print-frame')).toHaveCount(0);
    } finally {
      await page.evaluate(() =>
        (
          window as typeof window & { folioPrintObserver?: MutationObserver }
        ).folioPrintObserver?.disconnect(),
      );
    }
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('keeps localized controls accessible without horizontal page overflow on mobile', async () => {
    await open();
    await page.getByRole('button', { name: 'Fit width', exact: true }).click();
    const zoom = page.getByRole('textbox', { name: 'Zoom (%)', exact: true });
    const desktopZoom = Number(await zoom.inputValue());
    await page.setViewportSize({ width: 390, height: 844 });
    await browserExpect.poll(async () => Number(await zoom.inputValue())).toBeLessThan(desktopZoom);
    await browserExpect
      .poll(() =>
        page.evaluate(() => {
          const stage = document.querySelector('.folio-scroll');
          const sheet = document.querySelector('.folio .page');
          return !!stage && !!sheet && sheet.clientWidth <= stage.clientWidth;
        }),
      )
      .toBe(true);
    await screenshot('folio-mobile-en');
    await zoom.fill('150');
    await zoom.press('Enter');
    await page.setViewportSize({ width: 320, height: 844 });
    await browserExpect(zoom).toHaveValue('150');
    await page.getByRole('button', { name: 'Fit width', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.reload();
    await browserExpect(page.locator('.folio .textLayer').first()).toContainText(
      'Folio fixture page 1',
    );
    await screenshot('folio-desktop-it');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await browserExpect(
        page.getByRole('button', { name: 'Adatta alla pagina', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Adatta alla pagina', exact: true }).click();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      await screenshot(`folio-mobile-${width}-it`);
    }
    // Authored PDF annotations retain document geometry when scaled: WCAG 2.5.8's
    // inline/essential presentation exception applies. All other annotation checks
    // remain enabled, including link names. Application controls still require target size.
    const axe = await new AxeBuilder({ page })
      .include('.folio')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .disableRules(['target-size'])
      .analyze();
    expect(axe.violations).toEqual([]);
    const targets = await new AxeBuilder({ page })
      .include('.folio-toolbar')
      .withRules(['target-size'])
      .analyze();
    expect(targets.violations).toEqual([]);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
});
