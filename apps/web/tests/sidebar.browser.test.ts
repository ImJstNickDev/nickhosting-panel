import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 sidebar viewport and navigation regression', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let owner: Page;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    fixture = await browserHarness();
    const identities = await prepareJourneyIdentities(fixture);
    owner = identities.owner;
    owner.on('pageerror', (error) => pageErrors.push(error.message));
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
  });

  afterAll(async () => {
    provider?.dispose();
    await fixture?.close();
  });

  async function accessible() {
    const result = await new AxeBuilder({ page: owner })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((n) => n.target) })),
    ).toEqual([]);
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(pageErrors).toEqual([]);
  }

  async function screenshot(name: string) {
    // Viewport captures preserve the scroll position and prove sticky geometry.
    // Only disposable fixture identities appear; populated secrets stay masked.
    await owner.screenshot({
      path: resolve('.codex/local/m5-browser/screenshots', `${name}.png`),
      fullPage: false,
      maskColor: '#c8d2d9',
      mask: [
        owner.locator('input[type="password"]:not(:placeholder-shown):visible'),
        owner.locator('input[autocomplete="off"]:visible'),
      ],
    });
  }

  async function sidebarFitsViewport() {
    const bounds = await owner.locator('.sidebar').boundingBox();
    const viewport = owner.viewportSize();
    if (!bounds || !viewport) throw new Error('Expected visible sidebar in a sized viewport');
    expect(bounds.y).toBeGreaterThanOrEqual(-1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
    return bounds;
  }

  it('keeps desktop navigation in the viewport and exposes Administration in the topbar', async () => {
    await owner.setViewportSize({ width: 1440, height: 900 });
    await owner.goto(`${fixture.origin}/settings`);
    await browserExpect(
      owner.getByRole('heading', { name: 'Sessions', exact: true }),
    ).toBeVisible();
    expect(await owner.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(900);
    const top = await sidebarFitsViewport();
    const administration = owner
      .locator('.topbar')
      .getByRole('link', { name: 'Admin', exact: true });
    await browserExpect(administration).toBeInViewport({ ratio: 1 });
    await owner.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await browserExpect.poll(() => owner.evaluate(() => scrollY)).toBeGreaterThan(100);
    expect((await sidebarFitsViewport()).y).toBeCloseTo(top.y, 0);
    await screenshot('sidebar-scrolled-desktop-en');
    await accessible();
    await owner.evaluate(() => window.scrollTo(0, 0));
    await administration.hover();
    await browserExpect(owner.getByRole('tooltip')).toHaveText('Admin');
    await administration.click();
    await browserExpect(owner).toHaveURL(`${fixture.origin}/owner`);
    await browserExpect(
      owner.getByRole('heading', { name: 'Platform health', exact: true }),
    ).toBeVisible();
  });

  it('scrolls a short desktop sidebar independently and reveals its links during keyboard traversal', async () => {
    await owner.setViewportSize({ width: 1100, height: 420 });
    await owner.goto(`${fixture.origin}/owner/settings`);
    await browserExpect(
      owner.getByRole('heading', { name: 'Platform settings', exact: true }),
    ).toBeVisible();
    const sidebar = owner.locator('.sidebar');
    expect(await sidebar.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    await owner.evaluate(() => window.scrollTo(0, 0));
    await sidebar.hover({ position: { x: 90, y: 180 } });
    await owner.mouse.wheel(0, 1000);
    await browserExpect
      .poll(() => sidebar.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await browserExpect(
      owner.locator('.sidebar-bottom').getByRole('link', { name: 'Home', exact: true }),
    ).toBeInViewport({ ratio: 1 });
    // Further wheel input at the menu boundary must not scroll the page behind it.
    await owner.mouse.wheel(0, 1000);
    expect(await owner.evaluate(() => scrollY)).toBe(0);
    await sidebarFitsViewport();
    await sidebar.evaluate((element) => {
      element.scrollTop = 0;
    });
    const links = sidebar.getByRole('link');
    await links.first().focus();
    for (let index = 1; index < (await links.count()); index += 1) {
      await owner.keyboard.press('Tab');
      await browserExpect(links.nth(index)).toBeFocused();
      // Chromium may leave a fractional pixel outside the scrollport after focus scrolling.
      await browserExpect(links.nth(index)).toBeInViewport({ ratio: 0.99 });
      expect(await owner.evaluate(() => scrollY)).toBe(0);
    }
    await screenshot('sidebar-short-desktop-en');
    await accessible();
    await owner.keyboard.press('Enter');
    await browserExpect(owner).toHaveURL(`${fixture.origin}/`);
  });

  it('preserves the Italian mobile disclosure, keyboard activation and navigation', async () => {
    await journeyRequest(fixture, owner, '/api/auth/update-user', {
      name: 'Morgan Owner',
      locale: 'it',
    });
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.goto(`${fixture.origin}/settings`);
    await browserExpect(
      owner.getByRole('heading', { name: 'Impostazioni', exact: true }),
    ).toBeVisible();
    const menu = owner.getByRole('button', { name: 'Menu', exact: true });
    const sidebar = owner.locator('.sidebar');
    await browserExpect(menu).toHaveAttribute('aria-controls', 'primary-navigation');
    await browserExpect(menu).toHaveAttribute('aria-expanded', 'false');
    await browserExpect(sidebar).not.toBeVisible();
    await menu.focus();
    await owner.keyboard.press('Enter');
    await browserExpect(menu).toHaveAttribute('aria-expanded', 'true');
    await browserExpect(sidebar).toBeVisible();
    expect(await sidebar.evaluate((element) => getComputedStyle(element).position)).toBe('static');
    const administration = owner
      .locator('.topbar')
      .getByRole('link', { name: 'Admin', exact: true });
    await browserExpect(administration).toBeInViewport({ ratio: 1 });
    await screenshot('sidebar-open-mobile-it');
    await accessible();
    await menu.click();
    await browserExpect(sidebar).not.toBeVisible();
    await menu.click();
    await administration.focus();
    await owner.keyboard.press('Enter');
    await browserExpect(owner).toHaveURL(`${fixture.origin}/owner`);
    await browserExpect(menu).toHaveAttribute('aria-expanded', 'false');
    await browserExpect(sidebar).not.toBeVisible();
    await accessible();
  });
});
