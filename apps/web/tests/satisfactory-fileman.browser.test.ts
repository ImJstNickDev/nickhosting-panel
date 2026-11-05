import { Buffer } from 'node:buffer';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect } from '@playwright/test';
import { expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

function save(version = 14) {
  const parts: Buffer[] = [];
  const int = (value: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(value);
    parts.push(b);
  };
  const string = (value: string) => {
    const b = Buffer.from(`${value}\0`);
    int(b.length);
    parts.push(b);
  };
  int(version);
  int(51);
  int(500000);
  string('Factory_A');
  string('Persistent_Level');
  string('');
  string('Northern factory');
  int(3661);
  const date = Buffer.alloc(9);
  date.writeBigInt64LE(621355968000000000n + 1700000000000n * 10000n);
  parts.push(date);
  return Buffer.concat([...parts, Buffer.alloc(100_000)]);
}

it('uses actual Fileman navigation and compiled Satisfactory viewer with bounded reads and permission-aware Worlds links', async () => {
  const harness = await browserHarness();
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>> | undefined;
  try {
    const identities = await prepareJourneyIdentities(harness);
    const page = identities.user;
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    const id = provider.ids.serverId;
    const beforeOperations = await harness.database.db
      .selectFrom('server_operations')
      .select('job_id')
      .where('server_id', '=', id)
      .execute();
    const files = await provider.files();
    files.clear();
    files.set('Factory_A.sav', save());
    files.set('Future.sav', save(15));
    const ranges: string[] = [];
    let worlds = true;
    await page.route(`**/v1/platform/servers/${id}`, async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      await route.fulfill({
        json: {
          ...value,
          gameId: 'satisfactory',
          runtimeId: 'satisfactory',
          capabilities: { ...value.capabilities, worlds },
        },
      });
    });
    await page.route(`**/v1/servers/${id}/files/viewer/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/capabilities'))
        return route.fulfill({ json: { available: true } });
      if (url.pathname.endsWith('/preferences'))
        return route.fulfill({ json: { preferences: [] } });
      if (url.pathname.endsWith('/content')) {
        const body = files.get(url.searchParams.get('path') ?? '');
        if (!body) return route.fulfill({ status: 404, json: { code: 'not_found' } });
        const range = route.request().headers().range ?? '';
        ranges.push(range);
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (!match) return route.fulfill({ status: 400 });
        const start = Number(match[1]),
          end = Math.min(Number(match[2]), body.length - 1);
        return route.fulfill({
          status: 206,
          body: body.subarray(start, end + 1),
          contentType: 'application/octet-stream',
          headers: {
            'Content-Range': `bytes ${start}-${end}/${body.length}`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
          },
        });
      }
      return route.fulfill({ status: 404 });
    });
    const base = `${harness.origin}/servers/${id}/files`;
    await page.goto(base);
    await browserExpect(page.getByRole('combobox', { name: 'Game folders' })).toBeVisible();
    await browserExpect(page.getByRole('img', { name: 'Satisfactory save' }).first()).toBeVisible();
    await page.screenshot({
      path: 'test-results/satisfactory-fileman-desktop-en.png',
      fullPage: true,
    });
    await page.locator('.fm-filename').getByText('Factory_A.sav', { exact: true }).click();
    await browserExpect(page.locator('.satisfactory-save-viewer')).toContainText(
      'Northern factory',
    );
    await browserExpect(
      page.getByRole('link', { name: 'Open Worlds', exact: true }),
    ).toHaveAttribute('href', `/servers/${id}/game/worlds`);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every((range) => range === 'bytes=0-65535')).toBe(true);
    expect((await new AxeBuilder({ page }).include('.file-manager').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({
      path: 'test-results/satisfactory-save-desktop-en.png',
      fullPage: true,
    });
    await page.getByRole('link', { name: 'Open Worlds', exact: true }).click();
    await browserExpect(page).toHaveURL(new RegExp(`/servers/${id}/game/worlds$`));
    await page.goto(base);
    const request = page.waitForRequest(
      (r) =>
        new URL(r.url()).pathname === `/v1/servers/${id}/files` &&
        new URL(r.url()).searchParams.get('path') === 'FactoryGame/Mods',
    );
    await page.getByRole('combobox', { name: 'Game folders' }).selectOption('mods');
    await request;
    await page.goto(`${base}?directory=`);
    await page.locator('.fm-filename').getByText('Future.sav', { exact: true }).click();
    await browserExpect(page.getByRole('alert')).toContainText('not supported');
    await page.getByRole('button', { name: 'Back to files', exact: true }).click();
    worlds = false;
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}?directory=`);
    await browserExpect(page.getByRole('combobox', { name: 'Cartelle del gioco' })).toBeVisible();
    await browserExpect(page.getByRole('link', { name: 'Apri Worlds', exact: true })).toHaveCount(
      0,
    );
    await page.locator('.fm-filename').getByText('Factory_A.sav', { exact: true }).click();
    await browserExpect(page.locator('.satisfactory-save-viewer')).toContainText(
      'Northern factory',
    );
    await browserExpect(page.getByRole('link', { name: 'Apri Worlds', exact: true })).toHaveCount(
      0,
    );
    expect((await new AxeBuilder({ page }).include('.file-manager').analyze()).violations).toEqual(
      [],
    );
    await page.screenshot({ path: 'test-results/satisfactory-save-mobile-it.png', fullPage: true });
    expect(
      await harness.database.db
        .selectFrom('server_operations')
        .select('job_id')
        .where('server_id', '=', id)
        .execute(),
    ).toEqual(beforeOperations);
  } finally {
    provider?.dispose();
    await harness.close();
  }
});
