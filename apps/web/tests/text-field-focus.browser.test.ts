import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';

describe('shared text field focus presentation', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let page: Page;
  beforeAll(async () => {
    harness = await browserHarness();
    page = await harness.page();
  });
  afterAll(async () => {
    await harness?.close();
  });
  it('uses one existing border for pointer/keyboard text entry and retains other keyboard indicators', async () => {
    await page.goto(`${harness.origin}/login`);
    const email = page.getByLabel('Email', { exact: true });
    const password = page.getByLabel('Password', { exact: true });
    await browserExpect(email).toBeVisible();
    const initial = await email.evaluate((element) => getComputedStyle(element).borderTopColor);
    const width = await email.evaluate((element) => getComputedStyle(element).borderTopWidth);
    await email.click();
    await browserExpect(email).toHaveCSS('outline-style', 'none');
    await browserExpect(email).toHaveCSS('box-shadow', 'none');
    await browserExpect(email).toHaveCSS('border-top-width', width);
    expect(await email.evaluate((element) => getComputedStyle(element).borderTopColor)).not.toBe(
      initial,
    );
    await page.keyboard.press('Tab');
    await browserExpect(password).toBeFocused();
    await browserExpect(password).toHaveCSS('outline-style', 'none');
    await browserExpect(password).toHaveCSS('border-top-color', 'rgb(54, 85, 106)');
    const submit = page.getByRole('button', { name: 'Sign in', exact: true });
    await submit.focus();
    await browserExpect(submit).toHaveCSS('outline-style', 'solid');
    await page.emulateMedia({ forcedColors: 'active' });
    await email.focus();
    await browserExpect(email).toHaveCSS('outline-style', 'solid');
    await browserExpect(email).toHaveCSS('outline-width', '1px');
  });
});
