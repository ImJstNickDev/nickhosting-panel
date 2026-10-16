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
  let owner: Page, user: Page;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    fixture = await browserHarness();
    const identities = await prepareJourneyIdentities(fixture);
    owner = identities.owner;
    user = identities.user;
    user.on('pageerror', (error) => pageErrors.push(error.message));
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
    await owner.goto(`${fixture.origin}/settings/security`);
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
    const links = sidebar.locator('a:visible, button:visible');
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

  it('collapses with keyboard focus intact, preserves navigation and remembers the desktop preference', async () => {
    await owner.setViewportSize({ width: 1440, height: 900 });
    await owner.goto(`${fixture.origin}/settings`);
    const sidebar = owner.locator('.sidebar');
    const toggle = sidebar.getByRole('button', { name: /^(Collapse|Expand) navigation$/ });
    await browserExpect(toggle).toHaveAttribute('aria-expanded', 'true');
    await browserExpect.poll(async () => (await sidebar.boundingBox())?.width).toBe(224);
    await toggle.focus();
    await owner.keyboard.press('Enter');
    await browserExpect(toggle).toBeFocused();
    await browserExpect(toggle).toHaveAttribute('aria-expanded', 'false');
    await browserExpect.poll(async () => (await sidebar.boundingBox())?.width).toBe(64);
    expect(await owner.evaluate(() => localStorage.getItem('nh.sidebar.collapsed'))).toBe('true');
    const servers = sidebar.getByRole('link', { name: 'Servers', exact: true });
    await servers.hover();
    await browserExpect(owner.getByRole('tooltip')).toHaveText('Servers');
    await owner.mouse.move(500, 100);
    await browserExpect(owner.getByRole('tooltip')).toHaveCount(0);
    await owner.getByRole('heading', { name: 'Settings', exact: true }).focus();
    await screenshot('sidebar-collapsed-personal-desktop-en');
    await accessible();
    await owner.reload();
    await browserExpect(toggle).toHaveAttribute('aria-expanded', 'false');
    await browserExpect.poll(async () => (await sidebar.boundingBox())?.width).toBe(64);
    await owner.locator('.topbar').getByRole('link', { name: 'Admin', exact: true }).click();
    await browserExpect(owner).toHaveURL(`${fixture.origin}/owner`);
    await browserExpect(
      sidebar.getByRole('link', { name: 'Overview', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await browserExpect(toggle).toHaveAttribute('aria-expanded', 'false');
    await owner.setViewportSize({ width: 1100, height: 420 });
    await sidebar.getByRole('link', { name: 'Home', exact: true }).focus();
    await browserExpect(sidebar.getByRole('link', { name: 'Home', exact: true })).toBeInViewport({
      ratio: 0.99,
    });
    await toggle.focus();
    await browserExpect(toggle).toBeInViewport({ ratio: 0.99 });
    await owner.setViewportSize({ width: 1440, height: 900 });
    await owner.getByRole('heading', { name: 'Platform health', exact: true }).focus();
    await screenshot('sidebar-collapsed-owner-desktop-en');
    await accessible();
    await toggle.click();
    await browserExpect.poll(async () => (await sidebar.boundingBox())?.width).toBe(224);
    await owner.getByRole('heading', { name: 'Platform health', exact: true }).focus();
    await screenshot('sidebar-expanded-owner-desktop-en');
  });

  it('offers the same compact controls to ordinary users and respects reduced motion', async () => {
    await user.goto(`${fixture.origin}/settings`);
    const sidebar = user.locator('.sidebar');
    const toggle = sidebar.getByRole('button', { name: /^(Collapse|Expand) navigation$/ });
    await browserExpect(toggle).toHaveAttribute('aria-expanded', 'true');
    await browserExpect(
      user.locator('.topbar').getByRole('link', { name: 'Admin', exact: true }),
    ).toHaveCount(0);
    await user.emulateMedia({ reducedMotion: 'reduce' });
    await toggle.click();
    await browserExpect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(
      await user.locator('.shell').evaluate((node) => getComputedStyle(node).transitionDuration),
    ).toBe('0s');
    await browserExpect.poll(async () => (await sidebar.boundingBox())?.width).toBe(64);
    await sidebar.getByRole('link', { name: 'Servers', exact: true }).focus();
    await user.keyboard.press('Enter');
    await browserExpect(user).toHaveURL(`${fixture.origin}/servers`);
    await browserExpect(
      sidebar.getByRole('link', { name: 'Servers', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await toggle.click();
    await browserExpect.poll(async () => (await sidebar.boundingBox())?.width).toBe(224);
    await user.emulateMedia({ reducedMotion: 'no-preference' });
    await toggle.click();
    await toggle.click();
    await browserExpect(toggle).toHaveAttribute('aria-expanded', 'true');
    await browserExpect.poll(async () => (await sidebar.boundingBox())?.width).toBe(224);
    expect(pageErrors).toEqual([]);
  });

  it('preserves the Italian mobile disclosure, keyboard activation and navigation', async () => {
    await journeyRequest(fixture, owner, '/api/auth/update-user', {
      name: 'Morgan Owner',
      locale: 'it',
    });
    await owner.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
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
    await browserExpect(
      sidebar.getByRole('button', { name: /Comprimi navigazione|Espandi navigazione/ }),
    ).toHaveCount(0);
    expect(
      await sidebar
        .getByRole('link', { name: 'Server', exact: true })
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
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
    await owner.setViewportSize({ width: 1440, height: 900 });
    await browserExpect(
      sidebar.getByRole('button', { name: 'Espandi navigazione', exact: true }),
    ).toHaveAttribute('aria-expanded', 'false');
    await browserExpect.poll(async () => (await sidebar.boundingBox())?.width).toBe(64);
  });
});
