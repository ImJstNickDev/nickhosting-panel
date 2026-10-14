import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

const guide = `---
title: Server notes
author: Alex
references:
  - id: lovelace1843
    title: Notes
    author:
      - family: Lovelace
        given: Ada
    issued:
      date-parts: [[1843]]
---
# Server notes

A concise guide for **Alex** and Giulia. :wave:

> [!NOTE]
> Back up the world before making changes.

## Configuration

| Setting | Value |
| --- | --- |
| Memory | 2048 MiB |
| Players | 10 |

The area is $A = \\pi r^2$. Water is $\\ce{H2O}$.

- [ ] Check the backup
- [x] Review access

~~~json title="server.json" showLineNumbers {2}
{
  "players": 10
}
~~~

## References

Read [[Reference#Details|the local reference]].

![[Reference#Details]]

A citation [@lovelace1843] and a footnote.[^note]

[^note]: This stays within the document.

<details><summary>Advanced</summary>

Use <kbd>CTRL</kbd> and ==highlighted== values.

</details>
`;

describe('Quill Markdown documents', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let files: Map<string, Buffer>;
  let base: string;
  const requests: string[] = [];
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];

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
    files = await provider.files();
    files.set(
      'Reference.md',
      Buffer.from(
        '# Reference\n\n## Details\n\nShared local information.\n\n## Other\n\nThis section is not embedded.\n',
      ),
    );
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    page.setDefaultTimeout(12000);
    await page.addInitScript(() => {
      const diagnostics: string[] = [];
      Object.assign(window, { quillWorkerDiagnostics: diagnostics });
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.addEventListener('error', (event) => {
            if (diagnostics.length < 32)
              diagnostics.push(`${event.message} ${event.filename}:${event.lineno}`);
          });
          this.addEventListener('message', (event) => {
            if (event.data?.error && diagnostics.length < 32)
              diagnostics.push(String(event.data.error));
          });
        }
      };
    });
    await page.route('**/files/viewer/capabilities', (route) =>
      route.fulfill({ json: { available: true } }),
    );
    await page.route('**/files/viewer/preferences', (route) =>
      route.fulfill({ json: { preferences: [] } }),
    );
    // The browser drives actual Fileman/editing handlers. Only the isolated read broker
    // substitutes bytes, as no SFTP/Wings filesystem belongs to this browser fixture.
    await page.route('**/files/viewer/content?*', (route) => {
      const path =
        new URL(route.request().url()).searchParams.get('path')?.replace(/^\//, '') ?? '';
      const bytes = files.get(path);
      return bytes
        ? route.fulfill({ body: bytes, contentType: 'application/octet-stream' })
        : route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    await page.route('https://markdown-external.example.test/**', (route) => {
      externalRequests.push(route.request().url());
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lxoAAAAASUVORK5CYII=',
          'base64',
        ),
      });
    });
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/files/editor') || path.endsWith('/files/viewer/content'))
        requests.push(`${request.method()} ${request.url()}`);
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
  });
  afterEach(async (context) => {
    if (context.task.result?.state !== 'fail' || !page) return;
    console.warn(
      'Quill failure state',
      await page
        .locator('.ve-quill')
        .innerText()
        .catch(() => 'viewer missing'),
      pageErrors,
      await page.evaluate(
        () => (window as unknown as { quillWorkerDiagnostics: string[] }).quillWorkerDiagnostics,
      ),
    );
    await harness.screenshot(page, 'quill-failure');
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  const quill = () => page.locator('.ve-quill:visible');
  const scribe = () => page.locator('.cm-content:visible');
  async function open(name: string, text: string) {
    files.set(name, Buffer.from(text));
    if (page.url().startsWith(harness.origin)) await page.evaluate(() => sessionStorage.clear());
    await page.goto(base);
    await page.locator('.fm-filename').getByText(name, { exact: true }).click();
    await browserExpect(quill()).toBeVisible();
    await browserExpect(quill()).toHaveAttribute('aria-busy', 'false', { timeout: 15000 });
  }
  async function switchTo(name: 'Quill' | 'Scribe') {
    await page.getByRole('button', { name, exact: true }).click();
    await browserExpect(name === 'Quill' ? quill() : scribe()).toBeVisible();
  }

  it('prints the complete long document across pages without the application shell', async () => {
    const sections = Array.from(
      { length: 64 },
      (_, i) =>
        `## Print-section-${i + 1}\n\n${'A paragraph of document content for pagination. '.repeat(12)}\n`,
    );
    await open('Print.md', `# Print document\n\n${sections.join('\n')}\nPRINT-END-MARKER`);
    const article = page.locator('.quill-document');
    const screenHeight = await article.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.clientHeight;
    });
    await page.evaluate(() => {
      window.print = () => {};
    });
    await quill().getByRole('button', { name: 'Print', exact: true }).click();
    await page.emulateMedia({ media: 'print' });
    try {
      expect(await article.evaluate((el) => el.clientHeight)).toBeGreaterThan(screenHeight * 10);
      expect(
        await article.evaluate((el) => {
          for (let parent = el.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            if (style.overflowY !== 'visible' || style.display !== 'block') return false;
          }
          return true;
        }),
      ).toBe(true);
      if (process.env.NH_BROWSER !== 'firefox') {
        const pdf = await page.pdf({ format: 'A4' });
        const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const loading = getDocument({ data: new Uint8Array(pdf), useSystemFonts: true });
        const document = await loading.promise;
        try {
          expect(document.numPages).toBeGreaterThan(2);
          const pages = [];
          for (let n = 1; n <= document.numPages; n++) {
            const content = await (await document.getPage(n)).getTextContent();
            pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
          }
          const text = pages.join(' ');
          for (let n = 1; n <= 64; n++) expect(text).toContain(`Print-section-${n}`);
          expect(pages.at(-1)).toContain('PRINT-END-MARKER');
          expect(text).not.toContain('Create server');
        } finally {
          await loading.destroy();
        }
      }
    } finally {
      await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      await page.emulateMedia({ media: 'screen' });
    }
    await browserExpect(article).not.toHaveClass(/quill-print-target/);
    expect(await article.evaluate((el) => el.clientHeight)).toBe(screenHeight);
    await browserExpect(quill().getByRole('button', { name: 'Print', exact: true })).toBeVisible();
  });

  it('survives a cold worker load after Fileman refresh without requiring Retry', async () => {
    files.set('cold-start.md', Buffer.from('# Cold start\n\nThe document is ready.'));
    await page.goto(base);
    await page.reload();
    await browserExpect(
      page.locator('.fm-filename').getByText('cold-start.md', { exact: true }),
    ).toBeVisible();
    const pattern = '**/markdown/worker.ts?*';
    let delayedWorkers = 0;
    await page.route(pattern, async (route) => {
      delayedWorkers++;
      await new Promise((resolve) => setTimeout(resolve, 13_000));
      // StrictMode may dispose its first worker while the request is delayed.
      await route.continue().catch(() => {});
    });
    try {
      await page.locator('.fm-filename').getByText('cold-start.md', { exact: true }).click();
      await browserExpect(quill().getByRole('heading', { name: 'Cold start' })).toBeVisible({
        timeout: 25_000,
      });
      await browserExpect(quill().locator('.quill-error')).toHaveCount(0);
      await browserExpect(quill()).toHaveAttribute('aria-busy', 'false');
      expect(delayedWorkers).toBeGreaterThan(0);
    } finally {
      await page.unroute(pattern);
    }
  });

  it('renders GFM, mathematics, chemistry, frontmatter, local inclusions and bibliography', async () => {
    await open('guide.md', guide);
    await browserExpect(
      quill().getByRole('heading', { name: 'Server notes', exact: true }),
    ).toBeVisible();
    await browserExpect(quill().getByRole('table')).toContainText('2048 MiB');
    await browserExpect(quill().locator('.katex').first()).toBeVisible();
    await browserExpect(quill()).toContainText('Back up the world before making changes.');
    await browserExpect(quill().locator('.quill-embed')).toContainText('Shared local information.');
    await browserExpect(quill().locator('.quill-embed')).not.toContainText(
      'This section is not embedded.',
    );
    await browserExpect(quill().locator('.quill-bibliography')).toContainText('Lovelace');
    await browserExpect(quill().locator('.quill-code')).toContainText('server.json');
    await harness.screenshot(page, 'quill-desktop-en');
    expect(
      (
        await new AxeBuilder({ page })
          .include('.ve-quill')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });

  it('loads a local BibTeX bibliography through the same authorized resource broker', async () => {
    files.set(
      'references.bib',
      Buffer.from(
        '@book{hopper1952, author={Grace Hopper}, title={The Education of a Computer}, year={1952}}',
      ),
    );
    await open(
      'bibliography.md',
      '---\nbibliography: references.bib\ncitation-style: numeric\n---\n# Sources\n\nA local reference [@hopper1952].\n',
    );
    await browserExpect(quill().locator('.quill-bibliography')).toContainText('Hopper', {
      timeout: 10000,
    });
    await browserExpect(quill().locator('.quill-citation')).toContainText('1');
    await browserExpect(quill().locator('.quill-bibliography')).toContainText(
      'The Education of a Computer',
    );
  });

  it('shares task edits, undo and explicit save with Scribe without repeated content reads', async () => {
    const source = '# Tasks\n\n- [ ] Confirm the backup\n\nKeep this exact text.\n';
    await open('tasks.md', source);
    const task = quill().getByRole('checkbox').first();
    await browserExpect(task).toBeEnabled();
    const before = [...requests];
    await task.check();
    await browserExpect(page.locator('.fm-editor-state')).toHaveText('Unsaved changes');
    await switchTo('Scribe');
    await browserExpect(scribe()).toContainText('- [x] Confirm the backup');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await browserExpect(scribe()).toContainText('- [ ] Confirm the backup');
    await switchTo('Quill');
    await browserExpect(quill().getByRole('checkbox').first()).not.toBeChecked();
    expect(requests).toEqual(before);
    await quill().getByRole('checkbox').first().check();
    await page.keyboard.press('Control+s');
    await browserExpect
      .poll(() => files.get('tasks.md')?.toString())
      .toContain('- [x] Confirm the backup');
    await browserExpect(page.locator('.fm-editor-state')).toHaveText('No unsaved changes');
  });

  it('preserves unsaved source and cursor while switching between preview and Scribe', async () => {
    const source = '# First\n\nFirst paragraph.\n\n## Selected\n\nTarget paragraph.\n';
    await open('positions.md', source);
    await browserExpect(
      quill().getByRole('heading', { name: 'Selected', exact: true }),
    ).toBeVisible();
    const before = [...requests];
    await switchTo('Scribe');
    await scribe().press('Control+End');
    await scribe().press('ArrowLeft');
    await scribe().press('End');
    await scribe().press('!');
    await switchTo('Quill');
    await browserExpect(quill()).toContainText('Target paragraph.!');
    await switchTo('Scribe');
    await browserExpect(scribe()).toBeFocused();
    await browserExpect(page.locator('.fm-editor-state')).toHaveText('Unsaved changes');
    expect(requests).toEqual(before);
    expect(files.get('positions.md')?.toString()).toBe(source);
  });

  it('opens wiki links through Fileman and retains the target document content', async () => {
    await open('links.md', '# Links\n\n[[Reference#Details|Local details]]\n');
    await quill().getByRole('link', { name: 'Local details', exact: true }).click();
    await browserExpect(
      quill().getByRole('heading', { name: 'Reference', exact: true }),
    ).toBeVisible();
    await browserExpect(quill()).toContainText('Shared local information.');
  });

  it('does not execute raw HTML or load external images before an explicit click', async () => {
    await open(
      'untrusted.md',
      '# Safety\n\n<script>window.quillExecuted = true</script>\n\n<iframe src="https://markdown-external.example.test/frame"></iframe>\n\n[bad](javascript:alert(1))\n\n![External diagram](https://markdown-external.example.test/image.png)\n',
    );
    await browserExpect(quill().getByRole('heading', { name: 'Safety' })).toBeVisible();
    await browserExpect(
      quill().getByRole('button', { name: /markdown-external.example.test/ }),
    ).toBeVisible();
    expect(externalRequests).toEqual([]);
    expect(await quill().locator('script,iframe,object,embed,[onerror],[onclick]').count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { quillExecuted?: boolean }).quillExecuted),
    ).toBeUndefined();
    await quill()
      .getByRole('button', { name: /markdown-external.example.test/ })
      .click();
    await browserExpect.poll(() => externalRequests.length).toBe(1);
    await browserExpect(quill().getByRole('img', { name: 'External diagram' })).toBeVisible();
  });

  it('renders diagrams lazily without introducing executable document elements', async () => {
    await open(
      'diagram.md',
      '# Process\n\n```mermaid\nflowchart LR\n A[Start] --> B[Ready]\n```\n',
    );
    await browserExpect(quill()).toContainText('Start');
    const diagram = quill().locator('.quill-diagram img');
    await browserExpect(diagram).toBeVisible({ timeout: 20000 });
    await browserExpect
      .poll(() => diagram.evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    expect(
      await diagram.evaluate(
        async (image) => await (await fetch((image as HTMLImageElement).src)).text(),
      ),
    ).toContain('Ready');
    expect(await quill().locator('script,[onclick]').count()).toBe(0);
    const beforeExternal = [...externalRequests];
    await open(
      'unsafe-diagram.md',
      '# Restricted diagram\n\n```mermaid\nflowchart LR\n A@{ img: "https://markdown-external.example.test/pixel", label: "x" }\n```\n',
    );
    await browserExpect(quill().locator('.quill-diagram').getByRole('status')).toBeVisible();
    expect(externalRequests).toEqual(beforeExternal);
  });

  it('renders archive Markdown with shared read-only Scribe and no save effects', async () => {
    const source = '# Archived notes\n\n- [ ] Read-only task\n';
    let reads = 0;
    await page.route('**/files/viewer/archive?*', (route) =>
      route.fulfill({
        json: {
          directory: '',
          offset: 0,
          limit: 200,
          total: 1,
          entries: [{ name: 'notes.md', path: 'notes.md', directory: false, size: source.length }],
        },
      }),
    );
    await page.route('**/files/viewer/archive/content?*', (route) => {
      reads++;
      return route.fulfill({ body: source, contentType: 'text/plain' });
    });
    try {
      files.set('notes.zip', Buffer.from('Isolated archive transport fixture'));
      if (page.url().startsWith(harness.origin)) await page.evaluate(() => sessionStorage.clear());
      await page.goto(base);
      await page.locator('.fm-filename').getByText('notes.zip', { exact: true }).click();
      await page.locator('.ve-archive .fm-filename').getByText('notes.md', { exact: true }).click();
      await browserExpect(
        quill().getByRole('heading', { name: 'Archived notes', exact: true }),
      ).toBeVisible();
      await browserExpect(quill().getByRole('checkbox').first()).toBeDisabled();
      const before = reads;
      await switchTo('Scribe');
      await browserExpect(scribe()).toHaveAttribute('contenteditable', 'false');
      await switchTo('Quill');
      await page.keyboard.press('Control+s');
      expect(reads).toBe(before);
    } finally {
      await page.unroute('**/files/viewer/archive?*');
      await page.unroute('**/files/viewer/archive/content?*');
    }
  });

  it('keeps search and Italian mobile layout accessible without horizontal page overflow', async () => {
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await open(
        'mobile.md',
        '# Note del server\n\n## Configurazione\n\nControlla il backup prima di aggiornare.\n\n| Impostazione | Valore |\n| --- | --- |\n| Memoria | 2048 MiB |\n',
      );
      await browserExpect(
        quill().getByRole('heading', { name: 'Note del server', exact: true }),
      ).toBeVisible();
      await page.keyboard.press('Control+f');
      const search = quill().getByRole('searchbox');
      await browserExpect(search).toBeFocused();
      await search.fill('backup');
      await browserExpect(quill()).toContainText('backup');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await harness.screenshot(page, 'quill-mobile-it-search');
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ve-quill')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
    } finally {
      await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'en' });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    expect(pageErrors).toEqual([]);
  });
});
