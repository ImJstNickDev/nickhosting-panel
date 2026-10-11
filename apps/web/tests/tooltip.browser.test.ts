import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('shared tooltips in the real Files and Console screens', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let base: string;
  const errors: string[] = [];
  beforeAll(async () => {
    harness = await browserHarness();
    const identities = await prepareJourneyIdentities(harness);
    user = identities.user;
    user.on('pageerror', (error) => errors.push(error.message));
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    base = `${harness.origin}/servers/${provider.ids.serverId}`;
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });

  it('replaces adjacent toolbar hints immediately and closes on leave without a timer', async () => {
    await user.goto(`${base}/files`);
    const controls = user.locator('.fm-tools button');
    await browserExpect(controls).toHaveCount(5);
    await browserExpect(controls.nth(1)).toBeEnabled();
    for (const index of [1, 2, 3, 4, 2, 1]) {
      const control = controls.nth(index);
      await control.hover();
      const id = await control.getAttribute('aria-describedby');
      expect(id).toBeTruthy();
      // Immediate assertions deliberately catch the former 150ms overlap/delay.
      expect(await user.getByRole('tooltip').count()).toBe(1);
      expect(await user.getByRole('tooltip').getAttribute('id')).toBe(id);
    }
    await user.mouse.move(0, 0);
    expect(await user.getByRole('tooltip').count()).toBe(0);
  });

  it('does not pin a mouse-clicked trigger and dismisses across the popup while preserving keyboard focus and Escape', async () => {
    await user.goto(`${base}/console`);
    const trigger = user.locator('.network-legend button').first();
    await trigger.click();
    await browserExpect(trigger).toBeFocused();
    await user.mouse.move(0, 0);
    expect(await user.getByRole('tooltip').count()).toBe(0);
    await browserExpect(trigger).toBeFocused();

    await user.keyboard.press('Tab');
    await user.keyboard.press('Shift+Tab');
    await browserExpect(trigger).toBeFocused();
    await browserExpect(user.getByRole('tooltip')).toBeVisible();
    await user.keyboard.press('Escape');
    expect(await user.getByRole('tooltip').count()).toBe(0);
    await browserExpect(trigger).toBeFocused();
    await trigger.blur();

    await trigger.hover();
    const tooltip = user.getByRole('tooltip');
    await browserExpect(tooltip).toBeVisible();
    const anchor = await trigger.boundingBox();
    const popup = await tooltip.boundingBox();
    if (!anchor || !popup) throw new Error('Tooltip or trigger is not visible');
    // Crossing towards the visible popup must leave the original target normally.
    const left = Math.max(anchor.x, popup.x);
    const right = Math.min(anchor.x + anchor.width, popup.x + popup.width);
    const x = (left + right) / 2;
    await user.mouse.move(x, anchor.y + anchor.height / 2);
    await user.mouse.move(x, popup.y + popup.height / 2, { steps: 16 });
    expect(await tooltip.count()).toBe(0);
    await user.mouse.move(0, 0);
    expect(await tooltip.count()).toBe(0);
  });

  it('places Files hints at pointer entry and keeps them fixed until leaving the trigger', async () => {
    await user.goto(`${base}/files`);
    const trigger = user.getByRole('button', { name: 'New folder', exact: true });
    await browserExpect(trigger).toBeEnabled();
    const anchor = await trigger.boundingBox();
    if (!anchor) throw new Error('Files tooltip trigger is not visible');
    const firstPoint = { x: anchor.x + 7, y: anchor.y + 7 };
    await user.mouse.move(firstPoint.x, firstPoint.y);
    const tooltip = user.getByRole('tooltip');
    await browserExpect(tooltip).toHaveAttribute('data-placement', 'cursor');
    await browserExpect(tooltip).toHaveCSS('pointer-events', 'none');
    const before = await tooltip.boundingBox();
    if (!before) throw new Error('Files cursor tooltip is not visible');
    expect(before.y).toBeCloseTo(firstPoint.y + 12, 0);
    await user.mouse.move(firstPoint.x + 10, firstPoint.y + 10);
    const after = await tooltip.boundingBox();
    if (!after) throw new Error('Files cursor tooltip disappeared inside its trigger');
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    const viewport = user.viewportSize();
    if (!viewport) throw new Error('Missing browser viewport');
    expect(after.x).toBeGreaterThanOrEqual(8);
    expect(after.x + after.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(after.y + after.height).toBeLessThanOrEqual(viewport.height - 8);
    const originalId = await tooltip.getAttribute('id');
    await user.mouse.move(after.x + after.width / 2, after.y + after.height / 2);
    // Another toolbar icon can sit below this pointer-transparent popup; its own
    // hint may open, but the original hint must disappear immediately.
    expect(await user.locator(`[role="tooltip"][id="${originalId}"]`).count()).toBe(0);
    await user.mouse.move(0, 0);
    expect(await tooltip.count()).toBe(0);
    await user.mouse.move(firstPoint.x + 10, firstPoint.y + 10);
    await browserExpect(tooltip).toBeVisible();
    const reentered = await tooltip.boundingBox();
    expect(reentered?.y).toBeCloseTo(firstPoint.y + 10 + 12, 0);
    await harness.screenshot(user, 'file-manager-tooltip-desktop-en');
    await user.mouse.move(0, 0);

    // A long right-edge unavailable hint must clamp/flip without horizontal overflow.
    await user.setViewportSize({ width: 390, height: 844 });
    await user.getByRole('button', { name: 'Upload folder', exact: true }).hover();
    const edge = await tooltip.boundingBox();
    if (!edge) throw new Error('Edge tooltip is not visible');
    expect(edge.x).toBeGreaterThanOrEqual(8);
    expect(edge.x + edge.width).toBeLessThanOrEqual(382);
    await user.mouse.move(0, 0);
    await user.setViewportSize({ width: 1440, height: 1000 });
  });

  it('keeps Files keyboard hints anchored instead of following incidental pointer movement', async () => {
    const trigger = user.getByRole('button', { name: 'New folder', exact: true });
    await trigger.focus();
    const tooltip = user.getByRole('tooltip');
    await browserExpect(tooltip).toHaveAttribute('data-placement', 'anchor');
    const before = await tooltip.boundingBox();
    const anchor = await trigger.boundingBox();
    if (!before || !anchor) throw new Error('Focused Files tooltip is not visible');
    await user.mouse.move(anchor.x + 8, anchor.y + 8);
    await user.mouse.move(anchor.x + 18, anchor.y + 18);
    const after = await tooltip.boundingBox();
    expect(after?.x).toBe(before.x);
    expect(after?.y).toBe(before.y);
    await user.mouse.move(0, 0);
    await browserExpect(tooltip).toBeVisible();
    await user.keyboard.press('Escape');
    expect(await tooltip.count()).toBe(0);
    await browserExpect(trigger).toBeFocused();
  });

  it('performs no positioning or layout work on pointer movement and preserves entry position on rerender', async () => {
    await user.goto(`${base}/files`);
    const trigger = user.getByRole('button', { name: 'New folder', exact: true });
    await trigger.hover();
    const result = await trigger.evaluate((element) => {
      const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');
      if (!tooltip) throw new Error('Tooltip is not mounted');
      const anchor = element.getBoundingClientRect();
      const originalTriggerMeasure = element.getBoundingClientRect;
      const originalPopupMeasure = tooltip.getBoundingClientRect;
      const originalBox = originalPopupMeasure.call(tooltip);
      const originalTransform = tooltip.style.transform;
      const mutations = new MutationObserver(() => {});
      mutations.observe(tooltip, { attributes: true });
      let measurements = 0;
      element.getBoundingClientRect = () => {
        measurements++;
        return originalTriggerMeasure.call(element);
      };
      tooltip.getBoundingClientRect = () => {
        measurements++;
        return originalPopupMeasure.call(tooltip);
      };
      const point = { x: anchor.x + 8, y: anchor.y + 8 };
      try {
        element.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerType: 'mouse',
            clientX: point.x,
            clientY: point.y,
          }),
        );
        // No await, animation frame or React flush between movement and this read.
        const box = originalPopupMeasure.call(tooltip);
        return {
          top: box.top,
          originalTop: originalBox.top,
          transform: tooltip.style.transform,
          originalTransform,
          measurements,
          mutations: mutations.takeRecords().length,
        };
      } finally {
        mutations.disconnect();
        element.getBoundingClientRect = originalTriggerMeasure;
        tooltip.getBoundingClientRect = originalPopupMeasure;
      }
    });
    expect(result.top).toBe(result.originalTop);
    expect(result.transform).toBe(result.originalTransform);
    expect(result.measurements).toBe(0);
    expect(result.mutations).toBe(0);

    // A separate state update rerenders Files without moving the real pointer.
    // React must not restore a stale position from its previous render.
    const sorting = user.locator('.fm-columns').getByRole('button', { name: 'Size', exact: true });
    await sorting.dispatchEvent('click');
    await browserExpect(sorting).toHaveAttribute('aria-pressed', 'true');
    expect(await user.getByRole('tooltip').evaluate((element) => element.style.transform)).toBe(
      result.transform,
    );
    await user.mouse.move(0, 0);
  });

  it('keeps only one hint when hover moves away from a keyboard-focused trigger', async () => {
    await user.goto(`${base}/console`);
    const controls = user.locator('.network-legend button');
    await controls.first().focus();
    await browserExpect(user.getByRole('tooltip')).toBeVisible();
    await controls.nth(1).hover();
    expect(await user.getByRole('tooltip').count()).toBe(1);
    expect(await user.getByRole('tooltip').getAttribute('id')).toBe(
      await controls.nth(1).getAttribute('aria-describedby'),
    );
    await browserExpect(controls.first()).not.toHaveAttribute('aria-describedby');
    await user.mouse.move(0, 0);
    expect(await user.getByRole('tooltip').count()).toBe(0);
    await browserExpect(controls.first()).toBeFocused();
    await user.goto(`${base}/files`);
    await user.getByRole('button', { name: 'New folder', exact: true }).hover();
    await browserExpect(user.getByRole('tooltip')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  it('toggles touch hints, switches triggers exclusively and dismisses outside', async () => {
    const context = await harness.browser.newContext({
      storageState: await user.context().storageState(),
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    try {
      const touch = await context.newPage();
      await touch.goto(`${base}/console`);
      const controls = touch.locator('.network-legend button');
      await controls.first().tap();
      await browserExpect(touch.getByRole('tooltip')).toBeVisible();
      await controls.nth(1).tap();
      expect(await touch.getByRole('tooltip').count()).toBe(1);
      expect(await touch.getByRole('tooltip').getAttribute('id')).toBe(
        await controls.nth(1).getAttribute('aria-describedby'),
      );
      await controls.nth(1).tap();
      expect(await touch.getByRole('tooltip').count()).toBe(0);
      await controls.first().tap();
      await browserExpect(touch.getByRole('tooltip')).toBeVisible();
      await touch.locator('.network-chart h3').tap();
      expect(await touch.getByRole('tooltip').count()).toBe(0);

      await touch.goto(`${base}/files`);
      const sorting = touch
        .locator('.fm-columns')
        .getByRole('button', { name: 'Name', exact: true });
      await sorting.tap();
      await browserExpect(touch.getByRole('tooltip')).toHaveAttribute('data-placement', 'anchor');
      await sorting.tap();
      expect(await touch.getByRole('tooltip').count()).toBe(0);
      await sorting.tap();
      await browserExpect(touch.getByRole('tooltip')).toBeVisible();
      await touch.getByRole('searchbox', { name: 'Search this folder', exact: true }).tap();
      expect(await touch.getByRole('tooltip').count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
