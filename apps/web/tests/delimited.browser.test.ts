import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('Datagrid shared delimited document', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let base: string;
  let files: Map<string, Buffer>;
  const reads: string[] = [];
  const writes: string[] = [];
  const source = 'name,count\r\nAlice,001\r\nBob,002\r\n';
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
    page.setDefaultTimeout(8000);
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    await page.route('**/files/viewer/capabilities', (route) =>
      route.fulfill({ json: { available: true } }),
    );
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/files/editor'))
        (request.method() === 'GET' ? reads : writes).push(request.url());
    });
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  async function open(name: string, content: string) {
    files.set(name, Buffer.from(content));
    if (page.url().startsWith(harness.origin)) await page.evaluate(() => sessionStorage.clear());
    await page.goto(base);
    await page.locator('.fm-filename').getByText(name, { exact: true }).click();
    await browserExpect(page.locator('.dg-delimited:visible')).toBeVisible();
  }
  const grid = () => page.locator('.dg-delimited:visible');
  const cell = (value: string) => grid().getByRole('gridcell', { name: value, exact: true });
  const edit = () => grid().getByRole('textbox', { name: 'Edit cell', exact: true });
  const clean = () =>
    browserExpect(page.locator('.fm-editor-state')).toHaveText('No unsaved changes');
  const menuItem = (name: string) => page.getByRole('menuitem', { name, exact: true });
  async function insertAt(menu: string, position: string) {
    await menuItem(menu).click();
    await menuItem(position).click();
  }
  it('shares draft and undo with Scribe without rereads or writes when switching', async () => {
    await open('shared.csv', source);
    await browserExpect(cell('Alice')).toBeVisible();
    await clean();
    const header = grid().getByRole('button', { name: 'First row as header', exact: true });
    await browserExpect(header).toHaveAttribute('aria-pressed', 'true');
    await header.click();
    await browserExpect(header).toHaveAttribute('aria-pressed', 'false');
    await header.click();
    await browserExpect(header).toHaveAttribute('aria-pressed', 'true');
    await clean();
    const searchBounds = await grid().getByRole('searchbox').boundingBox();
    const delimiterBounds = await grid()
      .getByRole('button', { name: 'Delimiter', exact: true })
      .boundingBox();
    expect(
      searchBounds && delimiterBounds && Math.abs(searchBounds.y - delimiterBounds.y) < 4,
    ).toBe(true);
    await page.getByRole('button', { name: 'Back to files', exact: true }).focus();
    await page.keyboard.press('Control+f');
    await browserExpect(grid().getByRole('searchbox')).toBeFocused();
    await page.getByRole('button', { name: 'Back to files', exact: true }).focus();
    await page.keyboard.press('Meta+f');
    await browserExpect(grid().getByRole('searchbox')).toBeFocused();
    const hint = grid().locator('.dg-search-field kbd');
    await browserExpect(hint).toHaveText('CTRL + F');
    await grid().getByRole('searchbox').fill('x');
    await browserExpect(hint).toHaveCount(0);
    await grid().getByRole('searchbox').fill('');
    await browserExpect(hint).toHaveText('CTRL + F');
    const beforeReads = reads.length,
      beforeWrites = writes.length;
    await cell('001').dblclick();
    await edit().fill('009');
    // Switch with the cell still editing: host must flush before exposing Scribe.
    await page.getByRole('button', { name: 'Scribe', exact: true }).click();
    await browserExpect(page.locator('.cm-content:visible')).toContainText('009');
    await page.keyboard.press('Control+f');
    await browserExpect(page.locator('.fm-search-panel')).toBeVisible();
    await page
      .locator('.fm-search-panel')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await page.getByRole('button', { name: 'Datagrid', exact: true }).click();
    await browserExpect(cell('009')).toBeVisible();
    expect(reads.length).toBe(beforeReads);
    expect(writes.length).toBe(beforeWrites);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await browserExpect(cell('001')).toBeVisible();
    await clean();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await browserExpect(cell('009')).toBeVisible();
    await cell('009').click();
    await page.keyboard.press('Control+s');
    await clean();
    expect(files.get('shared.csv')?.toString()).toBe(source.replace('001', '009'));
    await harness.screenshot(page, 'datagrid-csv-desktop-en');
    expect(
      (
        await new AxeBuilder({ page })
          .include('.fm-editor-view')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });
  it('edits source rows after sorting, handles structure and preserves quoted strings', async () => {
    await open('sorted.tsv', 'name\tcount\nAlice\t001\nBob\t002\n');
    await browserExpect(cell('Alice')).toBeVisible();
    const sort = grid().getByRole('button', { name: 'Sort by name', exact: true });
    await sort.focus();
    await sort.press('ArrowDown');
    await browserExpect(cell('Alice')).toBeFocused();
    await sort.click();
    await sort.click();
    await cell('002').dblclick();
    await edit().fill('0007');
    await edit().press('Enter');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await clean();
    expect(files.get('sorted.tsv')?.toString()).toBe('name\tcount\nAlice\t001\nBob\t0007\n');
    await grid().getByRole('button', { name: 'Add row', exact: true }).click();
    await browserExpect(grid().locator('tbody tr')).toHaveCount(3);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await browserExpect(grid().locator('tbody tr')).toHaveCount(2);
    await clean();
    await grid().getByRole('button', { name: 'Add column', exact: true }).click();
    await browserExpect(grid().locator('thead th')).toHaveCount(4);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await browserExpect(grid().locator('thead th')).toHaveCount(3);
  });
  it('uses the right-clicked source row after sorting and shares insertion undo with Scribe', async () => {
    await open('context.csv', source);
    const sort = grid().getByRole('button', { name: 'Sort by name', exact: true });
    await sort.click();
    await sort.click();
    await browserExpect(grid().locator('tbody tr').first()).toContainText('Bob');
    await cell('Bob').click();
    await cell('Alice').click({ button: 'right' });
    await browserExpect(cell('Alice')).toHaveAttribute('aria-selected', 'true');
    await browserExpect(menuItem('Edit cell')).toBeVisible();
    await browserExpect(menuItem('Copy cell')).toBeVisible();
    await menuItem('Insert row').click();
    await browserExpect(menuItem('Before this row')).toBeVisible();
    await browserExpect(menuItem('After this row')).toBeVisible();
    await browserExpect(menuItem('Above')).toHaveCount(0);
    await harness.screenshot(page, 'datagrid-csv-context-menu-desktop-en');
    await menuItem('After this row').click();
    await browserExpect(grid().locator('tbody tr')).toHaveCount(3);
    await browserExpect(cell('Bob').locator('..').locator('th')).toHaveText('4');
    await page.getByRole('button', { name: 'Scribe', exact: true }).click();
    await browserExpect(page.locator('.cm-content:visible')).toContainText('"",""');
    await page.getByRole('button', { name: 'Datagrid', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await browserExpect(grid().locator('tbody tr')).toHaveCount(2);
    await clean();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await browserExpect(grid().locator('tbody tr')).toHaveCount(3);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await clean();
    expect(files.get('context.csv')?.toString()).toBe(
      'name,count\r\nAlice,001\r\n"",""\r\nBob,002\r\n',
    );
  });
  it('opens nested insertion menus from the keyboard and inserts columns at either boundary', async () => {
    await open('keyboard-context.csv', source);
    await cell('Alice').focus();
    await page.keyboard.press('Shift+F10');
    await browserExpect(menuItem('Edit cell')).toBeFocused();
    await menuItem('Insert row').focus();
    await page.keyboard.press('ArrowRight');
    await browserExpect(menuItem('Above')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await browserExpect(menuItem('Below')).toBeFocused();
    await page.keyboard.press('Enter');
    await browserExpect(grid().locator('tbody tr')).toHaveCount(3);
    await browserExpect(grid().locator('tbody tr').nth(1).getByRole('gridcell').first()).toHaveText(
      '',
    );
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await browserExpect(grid().locator('tbody tr')).toHaveCount(2);
    await clean();
    for (const position of ['First column', 'Last column']) {
      const header = grid().getByRole('button', { name: 'Sort by count', exact: true });
      await browserExpect(header).toBeEnabled();
      await header.focus();
      await page.keyboard.press('Shift+F10');
      await browserExpect(menuItem('Rename column')).toBeVisible();
      await menuItem('Insert column').focus();
      await page.keyboard.press('ArrowRight');
      await browserExpect(menuItem('Left')).toBeFocused();
      await menuItem(position).click();
      await browserExpect(grid().locator('thead th')).toHaveCount(4);
      const values = await grid()
        .locator('tbody tr')
        .first()
        .getByRole('gridcell')
        .allTextContents();
      expect(values).toEqual(
        position === 'First column' ? ['', 'Alice', '001'] : ['Alice', '001', ''],
      );
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await browserExpect(grid().locator('thead th')).toHaveCount(3);
      await clean();
    }
    await cell('Alice').focus();
    await page.keyboard.press('Shift+F10');
    await page.keyboard.press('Escape');
    await browserExpect(cell('Alice')).toBeFocused();
    await browserExpect(page.getByRole('menu')).toHaveCount(0);
    for (const position of ['First row', 'Last row']) {
      await cell('Alice').click();
      await grid().getByRole('button', { name: 'Table actions', exact: true }).click();
      await insertAt('Insert row', position);
      await browserExpect(grid().locator('tbody tr')).toHaveCount(3);
      const row = position === 'First row' ? 0 : 2;
      await browserExpect(
        grid().locator('tbody tr').nth(row).getByRole('gridcell').first(),
      ).toHaveText('');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await browserExpect(grid().locator('tbody tr')).toHaveCount(2);
      await clean();
    }
  });
  it('flushes an edited sort key before binding row-number context to the source row', async () => {
    await open('editing-context.csv', source);
    await grid().getByRole('button', { name: 'Sort by name', exact: true }).click();
    await cell('Alice').dblclick();
    await edit().fill('Zoe');
    await cell('Bob').locator('..').locator('.dg-row-target').click({ button: 'right' });
    await browserExpect(cell('Zoe')).toBeVisible();
    await browserExpect(menuItem('Delete row')).toBeVisible();
    await browserExpect(menuItem('Insert column')).toHaveCount(0);
    await browserExpect(menuItem('Delete column')).toHaveCount(0);
    await insertAt('Insert row', 'After this row');
    await browserExpect(grid().locator('tbody tr')).toHaveCount(3);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await clean();
    expect(files.get('editing-context.csv')?.toString()).toBe(
      'name,count\r\nZoe,001\r\nBob,002\r\n"",""',
    );
  });
  it('preserves embedded mixed newlines through grid edits, undo and saving', async () => {
    const original = 'name,count\r\n"Alice\nSecond",001\r\nBob,002\r\n';
    await open('multiline.csv', original);
    await cell('001').dblclick();
    await edit().fill('009');
    await edit().press('Enter');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await clean();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await browserExpect(cell('009')).toBeVisible();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await clean();
    expect(files.get('multiline.csv')?.toString()).toBe(original.replace('001', '009'));
  });
  it('reconciles removed columns and a schema reduced in Scribe', async () => {
    await open('columns.csv', source);
    await browserExpect(cell('Alice')).toBeVisible();
    await grid().getByRole('button', { name: 'Filter column', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'count', exact: true }).click();
    await grid().getByRole('button', { name: 'Sort by count', exact: true }).click();
    await cell('001').click();
    await grid().getByRole('button', { name: 'Delete column', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await browserExpect(grid().locator('thead th')).toHaveCount(2);
    await grid().getByRole('searchbox').fill('Alice');
    await browserExpect(cell('Alice')).toBeVisible();
    await browserExpect(cell('Bob')).toHaveCount(0);
    await grid().getByRole('searchbox').fill('');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await browserExpect(cell('001')).toBeVisible();
    await grid().getByRole('button', { name: 'Filter column', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'count', exact: true }).click();
    await page.getByRole('button', { name: 'Scribe', exact: true }).click();
    await page.locator('.cm-content:visible').fill('name\nAlice\nBob\n');
    await page.getByRole('button', { name: 'Datagrid', exact: true }).click();
    await browserExpect(cell('Alice')).toBeVisible();
    await grid().getByRole('searchbox').fill('Bob');
    await browserExpect(cell('Bob')).toBeVisible();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await clean();
  });
  it('keeps malformed text repairable and restores a changed Scribe draft in the grid', async () => {
    await open('broken.csv', 'name,value\n"unfinished');
    await browserExpect(grid().getByRole('alert')).toContainText('quoted value');
    await harness.screenshot(page, 'datagrid-csv-error-en');
    await page.getByRole('button', { name: 'Scribe', exact: true }).click();
    await page.locator('.cm-content:visible').fill('name,value\nAlice,004\n');
    await page.getByRole('button', { name: 'Datagrid', exact: true }).click();
    await browserExpect(cell('004')).toBeVisible();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await clean();
    expect(files.get('broken.csv')?.toString()).toBe('name,value\nAlice,004\n');
  });
  it('retains the draft on a real revision conflict instead of overwriting changed files', async () => {
    await open('conflict.csv', source);
    await cell('Alice').dblclick();
    await edit().fill('Draft');
    await edit().press('Enter');
    files.set('conflict.csv', Buffer.from('Changed elsewhere\n'));
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(page.locator('.fm-editor-view')).toContainText('changed');
    await browserExpect(cell('Draft')).toBeVisible();
    await harness.screenshot(page, 'datagrid-csv-conflict-en');
    expect(files.get('conflict.csv')?.toString()).toBe('Changed elsewhere\n');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Back to files', exact: true }).click();
  });
  it('keeps archive CSV read-only and switches without rereading its bytes', async () => {
    files.set('readonly.zip', Buffer.from('Isolated archive transport fixture'));
    let archiveReads = 0;
    await page.route('**/files/viewer/archive?*', (route) =>
      route.fulfill({
        json: {
          directory: '',
          entries: [
            { name: 'table.csv', path: 'table.csv', directory: false, size: source.length },
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
    if (page.url().startsWith(harness.origin)) await page.evaluate(() => sessionStorage.clear());
    await page.goto(base);
    await page.locator('.fm-filename').getByText('readonly.zip', { exact: true }).click();
    await page.locator('.ve-archive .fm-filename').getByText('table.csv', { exact: true }).click();
    await browserExpect(cell('Alice')).toBeVisible();
    const beforeWrites = writes.length;
    const beforeSwitch = archiveReads;
    await browserExpect(grid().getByRole('button', { name: 'Add row', exact: true })).toHaveCount(
      0,
    );
    await cell('Alice').click({ button: 'right' });
    await browserExpect(menuItem('Inspect cell')).toBeVisible();
    await browserExpect(menuItem('Copy cell')).toBeVisible();
    for (const label of ['Edit cell', 'Insert row', 'Insert column', 'Delete row', 'Delete column'])
      await browserExpect(menuItem(label)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Scribe', exact: true }).click();
    await browserExpect(page.locator('.cm-content:visible')).toHaveAttribute(
      'contenteditable',
      'false',
    );
    await page.getByRole('button', { name: 'Datagrid', exact: true }).click();
    await browserExpect(cell('Alice')).toBeVisible();
    await page.keyboard.press('Control+s');
    expect(archiveReads).toBe(beforeSwitch);
    expect(writes.length).toBe(beforeWrites);
    await page.unroute('**/files/viewer/archive?*');
    await page.unroute('**/files/viewer/archive/content?*');
  });
  it('presents Italian mobile controls without overflow', async () => {
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await open(
      'mobile.csv',
      source + Array.from({ length: 120 }, (_, index) => `Player${index},004\r\n`).join(''),
    );
    await browserExpect(cell('Alice')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await browserExpect(
      grid().getByRole('button', { name: 'Pagina successiva', exact: true }),
    ).toBeInViewport();
    await harness.screenshot(page, 'datagrid-csv-mobile-it');
    await cell('Alice').click();
    await grid().getByRole('button', { name: 'Azioni tabella', exact: true }).click();
    await menuItem('Inserisci riga').click();
    await browserExpect(menuItem('Sopra')).toBeVisible();
    await browserExpect(menuItem('In fondo')).toBeInViewport();
    await menuItem('Indietro').click();
    await browserExpect(menuItem('Inserisci riga')).toBeFocused();
    await browserExpect(menuItem('Sopra')).toHaveCount(0);
    await menuItem('Inserisci riga').click();
    await browserExpect(menuItem('Indietro')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await harness.screenshot(page, 'datagrid-csv-context-menu-mobile-it');
    expect(
      (
        await new AxeBuilder({ page })
          .include('.dg-context-root')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    expect(
      (
        await new AxeBuilder({ page })
          .include('.fm-editor-view')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.setViewportSize({ width: 320, height: 844 });
    const delimiter = grid().getByRole('button', { name: 'Separatore', exact: true });
    await delimiter.click();
    await page.getByRole('menuitemradio', { name: 'Punto e virgola (;)', exact: true }).click();
    const bounds = await grid().boundingBox();
    const controls = await delimiter.boundingBox();
    expect(
      bounds &&
        controls &&
        controls.x >= bounds.x &&
        controls.x + controls.width <= bounds.x + bounds.width,
    ).toBe(true);
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'en' });
  });
});
