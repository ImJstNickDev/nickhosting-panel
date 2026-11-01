import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('shared document source positions', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let files: Map<string, Buffer>;
  let base: string;
  const requests: string[] = [];

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
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    page.setDefaultTimeout(8000);
    await page.route('**/files/viewer/capabilities', (route) =>
      route.fulfill({ json: { available: true } }),
    );
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/files/editor') || path.endsWith('/files/viewer/content'))
        requests.push(`${request.method()} ${request.url()}`);
    });
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });

  async function open(name: string, source: string) {
    files.set(name, Buffer.from(source));
    if (page.url().startsWith(harness.origin)) await page.evaluate(() => sessionStorage.clear());
    await page.goto(base);
    await page.locator('.fm-filename').getByText(name, { exact: true }).click();
  }
  const editor = () => page.locator('.cm-content:visible');
  const grid = () => page.locator('.dg-delimited:visible');
  const cell = (value: string) => grid().getByRole('gridcell', { name: value, exact: true });
  const selectedNode = () => page.locator('.jt-row[aria-selected="true"]:visible');
  const switchTo = async (name: string) => {
    await page.getByRole('button', { name, exact: true }).click();
    if (name === 'Scribe') await browserExpect(editor()).toBeFocused();
  };
  const caret = () =>
    editor().evaluate(() => {
      const selection = document.getSelection();
      const anchor = selection?.anchorNode;
      const line = anchor?.parentElement?.closest('.cm-line');
      if (!selection || !anchor || !line) return undefined;
      const range = document.createRange();
      range.setStart(line, 0);
      range.setEnd(anchor, selection.anchorOffset);
      return { line: line.textContent, column: range.toString().length };
    });
  async function moveCaret(line: number, column: number) {
    await editor().press('Control+Home');
    for (let index = 1; index < line; index++) await editor().press('ArrowDown');
    for (let index = 0; index < column; index++) await editor().press('ArrowRight');
  }

  it('maps CSV source row 32 including its header to Scribe and back', async () => {
    const source = `name,count\r\n${Array.from(
      { length: 45 },
      (_, index) => `record-${index + 1},${String(index + 1).padStart(3, '0')}`,
    ).join('\r\n')}\r\n`;
    await open('position.csv', source);
    await browserExpect(cell('record-31')).toBeVisible();
    await browserExpect(cell('record-31').locator('..').locator('th')).toHaveText('32');
    const before = [...requests];
    await cell('record-31').click();
    await switchTo('Scribe');
    await browserExpect.poll(caret).toEqual({ line: 'record-31,031', column: 0 });
    await harness.screenshot(page, 'document-position-csv-row32-scribe-en');
    await moveCaret(12, 10);
    await switchTo('Datagrid');
    await browserExpect(cell('011')).toHaveAttribute('aria-selected', 'true');
    await browserExpect(cell('011')).toBeFocused();
    await harness.screenshot(page, 'document-position-csv-selected-cell-en');
    expect(requests).toEqual(before);
    expect(files.get('position.csv')?.toString()).toBe(source);
  });

  it.each(['csv', 'tsv'] as const)(
    'reveals the source cell through %s multiline CRLF, descending sorting and filtering',
    async (extension) => {
      const delimiter = extension === 'csv' ? ',' : '\t';
      const source = `name${delimiter}note\r\nZulu${delimiter}"first\r\nsecond"\r\nAlpha${delimiter}target\r\n`;
      await open(`multiline-position.${extension}`, source);
      await browserExpect(cell('Zulu')).toBeVisible();
      const header = grid().getByRole('button', { name: 'First row as header', exact: true });
      if ((await header.getAttribute('aria-pressed')) !== 'true') await header.click();
      const sort = grid().getByRole('button', { name: 'Sort by name', exact: true });
      await sort.click();
      await sort.click();
      await grid().getByRole('searchbox').fill('Zulu');
      await browserExpect(cell('Alpha')).toHaveCount(0);
      await cell('first second').click();
      const before = [...requests];
      await switchTo('Scribe');
      await browserExpect.poll(caret).toEqual({ line: `Zulu${delimiter}"first`, column: 5 });
      await moveCaret(3, 3);
      await switchTo('Datagrid');
      await browserExpect(cell('first second')).toHaveAttribute('aria-selected', 'true');
      await switchTo('Scribe');
      await moveCaret(4, 7);
      await switchTo('Datagrid');
      await browserExpect(cell('target')).toHaveAttribute('aria-selected', 'true');
      await browserExpect(cell('target')).toBeFocused();
      await browserExpect(grid().getByRole('searchbox')).toHaveValue('');
      await browserExpect(grid().locator('tbody tr').first()).toContainText('Zulu');
      expect(requests).toEqual(before);
      expect(files.get(`multiline-position.${extension}`)?.toString()).toBe(source);
    },
  );

  it('maps nested duplicate JSON keys by source occurrence in both directions', async () => {
    const source =
      '{\r\n  "emoji": "à😀",\r\n  "nested": {\r\n    "same": 11,\r\n    "same": 22\r\n  }\r\n}';
    await open('duplicate-position.json', source);
    const tree = page.getByRole('tree', { name: 'JSON tree', exact: true });
    await browserExpect(tree).toBeVisible();
    await page.getByRole('treeitem').filter({ hasText: 'nested' }).click();
    await page.keyboard.press('ArrowRight');
    const duplicates = page.getByRole('treeitem').filter({ hasText: 'same' });
    await browserExpect(duplicates).toHaveCount(2);
    await duplicates.nth(1).click();
    const secondId = await selectedNode().getAttribute('id');
    const before = [...requests];
    await switchTo('Scribe');
    await browserExpect.poll(caret).toEqual({ line: '    "same": 22', column: 12 });
    await moveCaret(4, 13);
    await switchTo('JSON Tree');
    await browserExpect(selectedNode()).toContainText('11');
    await browserExpect(selectedNode()).not.toHaveAttribute('id', secondId ?? '');
    await browserExpect(tree).toBeFocused();
    await harness.screenshot(page, 'document-position-json-duplicate-en');
    await page.setViewportSize({ width: 390, height: 844 });
    await browserExpect(selectedNode()).toContainText('11');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await harness.screenshot(page, 'document-position-json-duplicate-mobile-en');
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(requests).toEqual(before);
    expect(files.get('duplicate-position.json')?.toString()).toBe(source);
  });

  it('keeps an invalid unsaved JSON draft repairable in Scribe without provider requests', async () => {
    const source = '{"value":1}';
    await open('repair-position.json', source);
    await browserExpect(page.getByRole('tree')).toBeVisible();
    const before = [...requests];
    await switchTo('Scribe');
    await editor().fill('{"value":');
    await switchTo('JSON Tree');
    await browserExpect(page.locator('.ve-json:visible').getByRole('alert')).toBeVisible();
    await switchTo('Scribe');
    await browserExpect(editor()).toHaveText('{"value":');
    await editor().fill('{"value":2}');
    await switchTo('JSON Tree');
    await browserExpect(page.getByRole('tree')).toContainText('2');
    await browserExpect(page.locator('.fm-editor-state')).toHaveText('Unsaved changes');
    expect(requests).toEqual(before);
    expect(files.get('repair-position.json')?.toString()).toBe(source);
  });

  it('keeps the latest cursor when switching rapidly while JSON reparses', async () => {
    const source = '{"original":true}';
    const draft = '{\n  "draft": "latest"\n}';
    await open('rapid-position.json', source);
    await browserExpect(page.getByRole('tree')).toBeVisible();
    const before = [...requests];
    await switchTo('Scribe');
    await editor().fill(draft);
    await moveCaret(2, 13);
    await switchTo('JSON Tree');
    // Do not wait for the worker: exercise superseded handoffs during its parse debounce.
    await switchTo('Scribe');
    // The tree may finish during a browser action; either handoff must retain this value.
    await browserExpect.poll(caret).toMatchObject({ line: '  "draft": "latest"' });
    await switchTo('JSON Tree');
    await browserExpect(selectedNode()).toContainText('latest');
    await browserExpect(page.getByRole('tree')).toBeFocused();
    expect(requests).toEqual(before);
    expect(files.get('rapid-position.json')?.toString()).toBe(source);
  });

  it('shares archive JSON positions while keeping Scribe read-only', async () => {
    const source = '{\n  "value": 12\n}';
    let archiveReads = 0;
    await page.route('**/files/viewer/archive?*', (route) =>
      route.fulfill({
        json: {
          directory: '',
          entries: [
            { name: 'data.json', path: 'data.json', directory: false, size: source.length },
          ],
          offset: 0,
          limit: 200,
          total: 1,
        },
      }),
    );
    await page.route('**/files/viewer/archive/content?*', (route) => {
      archiveReads++;
      return route.fulfill({ body: source, contentType: 'text/plain' });
    });
    try {
      await open('readonly-json.zip', 'Isolated archive transport fixture');
      await page
        .locator('.ve-archive .fm-filename')
        .getByText('data.json', { exact: true })
        .click();
      await browserExpect(page.getByRole('tree')).toBeVisible();
      const before = [...requests];
      const reads = archiveReads;
      await page.getByRole('treeitem').filter({ hasText: 'value' }).click();
      await switchTo('Scribe');
      await browserExpect(editor()).toHaveAttribute('contenteditable', 'false');
      await browserExpect.poll(caret).toEqual({ line: '  "value": 12', column: 11 });
      await page.getByRole('button', { name: 'Open with', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'JSON Tree', exact: true })
        .click();
      await browserExpect(selectedNode()).toContainText('12');
      await page.keyboard.press('Control+s');
      expect(archiveReads).toBe(reads);
      expect(requests).toEqual(before);
    } finally {
      await page.unroute('**/files/viewer/archive?*');
      await page.unroute('**/files/viewer/archive/content?*');
    }
  });

  it.each(['json', 'jsonc', 'json5'] as const)(
    'reindexes unsaved %s drafts and retains cursor focus without rereading or saving',
    async (extension) => {
      const source = '{\n  "nested": {"value": 1}\n}';
      const draft = '{\n  "nested": {"value": 2},\n  "draft": "unsaved"\n}';
      const name = `draft-position.${extension}`;
      await open(name, source);
      await browserExpect(page.getByRole('tree')).toBeVisible();
      const before = [...requests];
      await switchTo('Scribe');
      await editor().fill(draft);
      await moveCaret(3, 14);
      await switchTo('JSON Tree');
      await browserExpect(selectedNode()).toContainText('unsaved');
      await browserExpect(page.locator('.fm-editor-state')).toHaveText('Unsaved changes');
      await switchTo('Scribe');
      await browserExpect(editor()).toContainText('unsaved');
      await browserExpect.poll(caret).toEqual({ line: '  "draft": "unsaved"', column: 11 });
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await browserExpect(editor()).not.toContainText('unsaved');
      await browserExpect(page.locator('.fm-editor-state')).toHaveText('No unsaved changes');
      expect(requests).toEqual(before);
      expect(files.get(name)?.toString()).toBe(source);
    },
  );
});
