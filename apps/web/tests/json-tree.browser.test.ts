import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

/** Actual browser parser/worker and app shell. Remote viewer bytes are isolated fixtures. */
describe('JSON Tree browsing', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let base: string;
  let remote: Map<string, Buffer>;
  const reads: string[] = [];
  const errors: string[] = [];
  let hold: Promise<void> | undefined;
  let reject = false;
  const source =
    '{\n  "server": "Vanilla",\n  "players": [{"name":"Alex","active":true},{"name":"Giulia","active":false}],\n  "limits": {"memory":2048,"max":9007199254740993123456789},\n  "same":1,"same":2,\n  "a/b~c":"à😀",\n  "empty":{},\n  "notes":' +
    JSON.stringify('A long note à😀 '.repeat(5000)) +
    '\n}';
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
    remote = await provider.files();
    for (const [name, text] of Object.entries({
      'tree.json': source,
      'wide.json': JSON.stringify(
        Array.from({ length: 20000 }, (_, i) => ({ id: i, name: `Entry ${i}` })),
      ),
      'comments.jsonc': '{/* keep comment */"value":12,}',
      'special.json5': "{ bare:'hello', hex:0xabcdef, inf:-Infinity, n:NaN, }",
      'deep.json': `${'{"level":'.repeat(35)}{"deepLeaf":"readable"}${'}'.repeat(35)}`,
      'empty.json': '{}',
      'primitive.json': 'null',
      'broken.json': '{\n "valid": true,\n "missing":\n}',
    }))
      remote.set(name, Buffer.from(text));
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            Object.assign(window, { jsonClipboard: value });
          },
        },
      });
    });
    await page.route('**/files/viewer/capabilities', (route) =>
      route.fulfill({ json: { available: true } }),
    );
    await page.route('**/files/viewer/preferences', (route) =>
      route.fulfill({ json: { preferences: [] } }),
    );
    await page.route('**/files/viewer/content?*', async (route) => {
      const path = new URL(route.request().url()).searchParams.get('path') ?? '';
      reads.push(path);
      if (hold) await hold;
      if (reject)
        return route.fulfill({
          status: 503,
          json: { error: { code: 'internal_error', messageKey: 'error.internal' } },
        });
      const bytes = remote.get(path);
      if (!bytes) return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
      await route.fulfill({
        body: bytes,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
        },
      });
    });
    page.on('pageerror', (error) => errors.push(error.message));
  });
  afterEach(() => {
    reject = false;
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  async function open(name = 'tree.json') {
    if (!page.url().startsWith(base)) {
      await page.goto(base);
      await browserExpect(page.locator('.fm-filename').first()).toBeVisible();
    }
    const home = page
      .locator('.fm-toolbar-editing')
      .getByRole('button', { name: 'Back to files', exact: true });
    if (await home.isVisible()) await home.click();
    await page.locator('.fm-breadcrumb').getByRole('button', { name: 'root', exact: true }).click();
    await page.locator('.fm-filename').getByText(name, { exact: true }).click();
    await browserExpect(page.locator('.ve-json')).toBeVisible();
  }
  const tree = () => page.getByRole('tree', { name: 'JSON tree', exact: true });
  const row = (text: string) => page.getByRole('treeitem').filter({ hasText: text }).first();
  const selected = () => page.locator('.jt-row[aria-selected="true"]');
  const clipboard = () =>
    page.evaluate(() => (window as unknown as { jsonClipboard?: string }).jsonClipboard);
  it('preserves source precision, duplicates and copy paths without extra provider reads', async () => {
    await open();
    await browserExpect(tree()).toBeVisible();
    const initialReads = reads.length;
    await row('limits').click();
    await page.keyboard.press('ArrowRight');
    await browserExpect(tree()).toContainText('9007199254740993123456789');
    await row('max').click();
    await page.keyboard.press('Control+c');
    await browserExpect.poll(clipboard).toBe('9007199254740993123456789');
    await row('a/b~c').click();
    await page.getByRole('button', { name: 'Copy JSON Pointer', exact: true }).click();
    await browserExpect.poll(clipboard).toBe('/a~1b~0c');
    await tree().focus();
    await page.keyboard.press('Home');
    await page.getByRole('button', { name: 'Copy raw subtree', exact: true }).click();
    await browserExpect.poll(clipboard).toBe(source);
    expect(await page.getByRole('treeitem').filter({ hasText: /same/ }).count()).toBe(2);
    expect(reads.length).toBe(initialReads);
    await harness.screenshot(page, 'json-tree-desktop-en');
    expect(
      (
        await new AxeBuilder({ page })
          .include('.ve-json')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  });
  it('searches hidden descendants, moves between matches and keeps the latest query', async () => {
    await open();
    const input = page.getByRole('searchbox', { name: 'Search keys and values', exact: true });
    await input.fill('Giulia');
    await browserExpect(selected()).toContainText('Giulia');
    await input.fill('same');
    await browserExpect(selected()).toContainText('same');
    const first = await selected().getAttribute('id');
    await page.getByRole('button', { name: 'Next match', exact: true }).click();
    await browserExpect(selected()).not.toHaveAttribute('id', first ?? '');
    await page.getByRole('button', { name: 'Previous match', exact: true }).click();
    await browserExpect(selected()).toHaveAttribute('id', first ?? '');
    await input.fill('impossible');
    await input.fill('Vanilla');
    await browserExpect(selected()).toContainText('Vanilla');
    await input.fill('');
    await tree().focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await browserExpect(selected()).toContainText('server');
    await page.keyboard.press('ArrowLeft');
    await browserExpect(selected()).toHaveAttribute('aria-level', '1');
  });
  it('virtualizes a 60,001-node document and navigates to the last item without refetching', async () => {
    await open('wide.json');
    await browserExpect(tree()).toBeVisible();
    const count = reads.length;
    expect(await page.getByRole('treeitem').count()).toBeLessThanOrEqual(201);
    await tree().focus();
    await page.keyboard.press('End');
    await browserExpect(selected()).toContainText('19999');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await browserExpect(selected()).toContainText('19999');
    await page.keyboard.press('ArrowDown');
    await browserExpect(selected()).toContainText('Entry 19999');
    await tree().evaluate((element) => {
      element.scrollTop = 0;
    });
    await browserExpect(page.getByRole('treeitem').first()).toHaveAttribute('aria-level', '1');
    expect(await page.getByRole('treeitem').count()).toBeLessThanOrEqual(201);
    expect(reads.length).toBe(count);
    expect(
      await tree().evaluate((element) => {
        const active = element.getAttribute('aria-activedescendant');
        return !active || !!document.getElementById(active);
      }),
    ).toBe(true);
  });
  it('reads long values in bounded details and closes details before the viewer', async () => {
    await open();
    await row('notes').click();
    await page.keyboard.press('Enter');
    const detail = page.getByRole('region', { name: 'Node details', exact: true });
    await browserExpect(detail).toBeVisible();
    await browserExpect(detail).toContainText('A long note');
    await page.getByRole('button', { name: 'Next text chunk', exact: true }).click();
    await browserExpect(
      page.getByRole('button', { name: 'Next text chunk', exact: true }),
    ).toBeFocused();
    await browserExpect(
      page.getByRole('button', { name: 'Previous text chunk', exact: true }),
    ).toBeEnabled();
    await harness.screenshot(page, 'json-tree-details-en');
    await page.keyboard.press('Escape');
    await browserExpect(detail).toHaveCount(0);
    await browserExpect(tree()).toBeFocused();
    await row('server').click();
    await page.keyboard.press('Enter');
    await browserExpect(detail).toBeVisible();
    await tree().focus();
    await page.keyboard.press('ArrowDown');
    await browserExpect(selected()).toContainText('players');
    await browserExpect(tree()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await browserExpect(selected()).toContainText('limits');
    await browserExpect(tree()).toBeFocused();
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    await page.keyboard.press('Escape');
    await browserExpect(
      page.locator('.fm-filename').getByText('tree.json', { exact: true }),
    ).toBeVisible();
  });
  it('handles JSONC, JSON5, primitive and empty roots', async () => {
    for (const [name, content] of [
      ['comments.jsonc', '12'],
      ['special.json5', '0xabcdef'],
      ['primitive.json', 'null'],
      ['empty.json', '{}'],
    ] as const) {
      await open(name);
      await browserExpect(tree()).toContainText(content);
    }
    await harness.screenshot(page, 'json-tree-empty-en');
  });
  it('shows localized syntax location, retries failed reads and discards canceled work', async () => {
    await open('broken.json');
    await browserExpect(page.locator('.ve-json').getByRole('alert')).toBeVisible();
    await browserExpect(page.locator('.ve-json')).toContainText(/line|Line/);
    await harness.screenshot(page, 'json-tree-error-en');
    reject = true;
    await open('tree.json');
    await browserExpect(page.locator('.ve-json').getByRole('alert')).toBeVisible();
    reject = false;
    await page.locator('.ve-json').getByRole('button', { name: 'Retry', exact: true }).click();
    await browserExpect(tree()).toBeVisible();
    await page
      .locator('.fm-toolbar-editing')
      .getByRole('button', { name: 'Back to files', exact: true })
      .click();
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await page.locator('.fm-filename').getByText('tree.json', { exact: true }).click();
      await browserExpect(page.locator('.ve-json [role="status"]')).toBeVisible();
      await harness.screenshot(page, 'json-tree-loading-en');
      await page
        .locator('.fm-toolbar-editing')
        .getByRole('button', { name: 'Back to files', exact: true })
        .click();
    } finally {
      hold = undefined;
      release();
    }
    await page.locator('.fm-filename').getByText('special.json5', { exact: true }).click();
    await browserExpect(tree()).toContainText('0xabcdef');
    await browserExpect(tree()).not.toContainText('Vanilla');
  });
  it('recreates a terminated worker on Retry', async () => {
    await open();
    await browserExpect(tree()).toBeVisible();
    await page.evaluate(() => {
      const original = Worker.prototype.postMessage;
      let fail = true;
      Worker.prototype.postMessage = function (message, options?: unknown) {
        if (fail && message?.type === 'action' && message.action?.type === 'select') {
          fail = false;
          this.dispatchEvent(
            new ErrorEvent('error', { message: 'isolated worker failure', cancelable: true }),
          );
          return;
        }
        return original.call(this, message, options as StructuredSerializeOptions);
      };
    });
    await row('server').click();
    await browserExpect(page.locator('.ve-json').getByRole('alert')).toBeVisible();
    await page.locator('.ve-json').getByRole('button', { name: 'Retry', exact: true }).click();
    await browserExpect(tree()).toBeVisible();
    await row('players').click();
    await page.keyboard.press('ArrowRight');
    await browserExpect(tree()).toContainText('0:');
  });
  it('keeps Italian mobile layout and detail focus accessible', async () => {
    await open();
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    const home = page
      .locator('.fm-toolbar-editing')
      .getByRole('button', { name: 'Torna ai file', exact: true });
    await browserExpect(page.locator('.ve-json')).toBeVisible();
    await home.click();
    await page.locator('.fm-filename').getByText('tree.json', { exact: true }).click();
    await browserExpect(page.getByRole('tree')).toBeVisible();
    await harness.screenshot(page, 'json-tree-mobile-it');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .include('.ve-json')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await row('notes').click();
    await page.keyboard.press('Enter');
    const detail = page.getByRole('dialog', { name: 'Dettagli del nodo', exact: true });
    await browserExpect(detail).toBeVisible();
    await detail.getByRole('button', { name: 'Chiudi dettagli', exact: true }).hover();
    await browserExpect(detail.getByRole('tooltip')).toBeVisible();
    const tooltip = await detail.getByRole('tooltip').boundingBox();
    expect(
      tooltip && tooltip.x >= 0 && tooltip.y >= 0 && tooltip.x + tooltip.width <= 390,
    ).toBeTruthy();
    await page.mouse.move(1, 1);
    await harness.screenshot(page, 'json-tree-details-mobile-it');
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.jt-tree'))).toBe(false);
    await page.keyboard.press('Escape');
    await browserExpect(detail).toHaveCount(0);
    await browserExpect(page.getByRole('tree')).toBeFocused();
    await home.click();
    await page.locator('.fm-filename').getByText('deep.json', { exact: true }).click();
    await page
      .getByRole('searchbox', { name: 'Cerca chiavi e valori', exact: true })
      .fill('deepLeaf');
    await browserExpect(selected()).toContainText('deepLeaf');
    expect(
      await selected()
        .locator('.jt-key')
        .evaluate((element) => element.getBoundingClientRect().width),
    ).toBeGreaterThan(45);
    await harness.screenshot(page, 'json-tree-deep-mobile-it');
    expect(errors).toEqual([]);
  });
});
