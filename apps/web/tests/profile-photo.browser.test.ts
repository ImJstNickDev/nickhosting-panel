import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';

for (const browser of ['chromium', 'firefox'] as const) {
  describe(`Profile photo through actual handlers (${browser})`, () => {
    let fixture: Awaited<ReturnType<typeof browserHarness>>;
    let page: Page;
    const errors: string[] = [];
    let firstUrl: string;

    beforeAll(async () => {
      fixture = await browserHarness({ browser });
      const identities = await prepareJourneyIdentities(fixture);
      page = identities.user;
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${fixture.origin}/settings`);
      await browserExpect(page.getByRole('button', { name: /^Edit display name:/ })).toBeVisible();
    });
    afterAll(async () => fixture?.close());

    async function source(type = 'image/png') {
      const encoded = await page.evaluate((mime) => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas unavailable');
        context.fillStyle = '#275c71';
        context.fillRect(0, 0, 640, 480);
        context.fillStyle = '#ecd3a2';
        context.beginPath();
        context.arc(320, 240, 110, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = '#a05d48';
        context.fillRect(0, 380, 640, 100);
        return canvas.toDataURL(mime);
      }, type);
      return {
        name: `profile.${type.split('/')[1]}`,
        mimeType: type,
        buffer: Buffer.from(encoded.slice(encoded.indexOf(',') + 1), 'base64'),
      };
    }
    const picker = () => page.locator('input[type="file"]').first();
    const crop = () => page.getByRole('dialog', { name: 'Adjust photo' });
    async function dropPhotos(photos: Array<Awaited<ReturnType<typeof source>>>) {
      const dataTransfer = await page.evaluateHandle(
        (images) => {
          const transfer = new DataTransfer();
          for (const image of images) {
            transfer.items.add(
              new File([Uint8Array.from(image.bytes)], image.name, { type: image.mimeType }),
            );
          }
          return transfer;
        },
        photos.map(({ name, mimeType, buffer }) => ({ name, mimeType, bytes: [...buffer] })),
      );
      try {
        await page.locator('.profile-photo-control').dispatchEvent('drop', { dataTransfer });
      } finally {
        await dataTransfer.dispose();
      }
    }
    async function expectSaved() {
      try {
        await browserExpect(crop()).not.toBeVisible();
      } catch (cause) {
        throw new Error(`Photo save failed: ${await crop().textContent()}`, { cause });
      }
      await browserExpect(page.locator('.account-avatar img')).toBeVisible();
      const url = await page.locator('.account-avatar img').getAttribute('src');
      expect(url).toMatch(/^\/v1\/web\/profile-photo\/[^?]+\?v=[a-f0-9]{64}$/);
      expect(
        await page.locator('.account-avatar img').evaluate((element) => ({
          width: (element as HTMLImageElement).naturalWidth,
          height: (element as HTMLImageElement).naturalHeight,
        })),
      ).toEqual({ width: 256, height: 256 });
      if (!url) throw new Error('Photo URL missing');
      return url;
    }
    async function accessibility() {
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(result.violations.map(({ id }) => id)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
    }

    it('crops a local photo with keyboard controls and persists the shared avatar on reload', async () => {
      const photo = await source();
      const pickerOpened = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Change photo', exact: true }).click();
      await (await pickerOpened).setFiles(photo);
      await browserExpect(crop()).toBeVisible();
      const zoom = crop().getByRole('slider', { name: 'Zoom', exact: true });
      await zoom.focus();
      await page.keyboard.press('ArrowRight');
      const position = crop().getByLabel('Photo position', { exact: true });
      await position.focus();
      await page.keyboard.press('ArrowLeft');
      await accessibility();
      if (browser === 'firefox') await fixture.screenshot(page, 'profile-photo-crop-desktop-en');
      let releaseSave = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      let dispatched = false;
      await page.route('**/v1/web/profile-photo', async (route) => {
        dispatched = true;
        await gate;
        await route.continue();
      });
      await crop().getByRole('button', { name: 'Save changes', exact: true }).click();
      await browserExpect.poll(() => dispatched).toBe(true);
      await browserExpect(
        crop().getByRole('button', { name: 'Cancel', exact: true }),
      ).toBeDisabled();
      await browserExpect(zoom).toBeDisabled();
      await page.keyboard.press('Escape');
      await browserExpect(crop()).toBeVisible();
      const completed = page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' && response.url().endsWith('/v1/web/profile-photo'),
      );
      releaseSave();
      const response = await completed;
      expect(response.status(), await response.text()).toBe(200);
      await page.unroute('**/v1/web/profile-photo');
      firstUrl = await expectSaved();
      await page.reload();
      await browserExpect(page.locator('.account-avatar img')).toHaveAttribute('src', firstUrl);
      await page.getByRole('button', { name: 'Profile: Alex', exact: true }).click();
      await browserExpect(page.locator('.account-profile-avatar img')).toHaveAttribute(
        'src',
        firstUrl,
      );
      if (browser === 'firefox') await fixture.screenshot(page, 'profile-photo-desktop-en');
      await page.keyboard.press('Escape');
      await accessibility();
      const responsePhoto = await page.request.get(`${fixture.origin}${firstUrl}`);
      expect(responsePhoto.status()).toBe(200);
      expect(responsePhoto.headers()['content-type']).toBe('image/png');
      expect(responsePhoto.headers()['cache-control']).toBe('private, no-store');
    });

    it('rejects invalid input, cancels drafts and preserves the saved photo on upload failure', async () => {
      const image = await source();
      await dropPhotos([image, { ...image, name: 'second.png' }]);
      await browserExpect(page.getByText('Choose one photo at a time.')).toBeVisible();
      await browserExpect(crop()).not.toBeVisible();
      await browserExpect(page.locator('.account-avatar img')).toHaveAttribute('src', firstUrl);
      await picker().setInputFiles({
        name: 'bad.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from('<svg/>'),
      });
      await browserExpect(page.getByText('Choose a PNG, JPEG or WebP image.')).toBeVisible();
      await picker().setInputFiles({
        name: 'bad.png',
        mimeType: 'image/png',
        buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]),
      });
      await browserExpect(
        page.getByText('This image could not be opened. Choose another image.'),
      ).toBeVisible();
      await picker().setInputFiles({
        name: 'large.png',
        mimeType: 'image/png',
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
      });
      await browserExpect(page.getByText('Choose an image no larger than 5 MB.')).toBeVisible();
      await picker().setInputFiles(await source('image/jpeg'));
      await browserExpect(crop()).toBeVisible();
      await crop().getByRole('button', { name: 'Cancel', exact: true }).click();
      await browserExpect(crop()).not.toBeVisible();
      await browserExpect(page.locator('.account-avatar img')).toHaveAttribute('src', firstUrl);
      await picker().setInputFiles(await source('image/jpeg'));
      await page.route('**/v1/web/profile-photo', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'internal_error', messageKey: 'web.errors.request' },
          }),
        }),
      );
      await crop().getByRole('button', { name: 'Save changes', exact: true }).click();
      await browserExpect(crop().getByRole('alert')).toBeVisible();
      await browserExpect(page.locator('.account-avatar img')).toHaveAttribute('src', firstUrl);
      await page.unroute('**/v1/web/profile-photo');
      await crop().getByRole('button', { name: 'Save changes', exact: true }).click();
      await expectSaved();
    });

    it('accepts WebP, shows the Italian mobile interface and removes the stored photo', async () => {
      await dropPhotos([await source('image/webp')]);
      await crop().getByRole('button', { name: 'Save changes', exact: true }).click();
      const photoUrl = await expectSaved();
      await journeyRequest(fixture, page, '/api/auth/update-user', { locale: 'it' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await browserExpect(
        page.getByRole('button', { name: 'Cambia foto', exact: true }),
      ).toBeVisible();
      await accessibility();
      if (browser === 'firefox') await fixture.screenshot(page, 'profile-photo-mobile-it');
      await page.getByRole('button', { name: 'Rimuovi foto', exact: true }).click();
      await browserExpect(page.locator('.account-avatar img')).toHaveCount(0);
      await page.reload();
      await browserExpect(
        page.getByRole('button', { name: 'Cambia foto', exact: true }),
      ).toBeVisible();
      await browserExpect(page.locator('.account-avatar img')).toHaveCount(0);
      expect((await page.request.get(`${fixture.origin}${photoUrl}`)).status()).toBe(404);
      expect(errors).toEqual([]);
    });
  });
}
