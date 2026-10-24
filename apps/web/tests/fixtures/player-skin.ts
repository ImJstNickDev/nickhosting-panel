import type { Page } from '@playwright/test';

/** Original solid-color skin for browser tests; no remote player artwork. */
export async function playerSkinFixture(page: Page): Promise<Buffer> {
  return Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Missing canvas context');
      context.fillStyle = '#ba8f69';
      context.fillRect(0, 0, 64, 64);
      context.fillStyle = '#4e7772';
      context.fillRect(16, 16, 24, 16);
      context.fillStyle = '#303948';
      context.fillRect(0, 16, 16, 16);
      context.fillRect(16, 48, 16, 16);
      context.fillStyle = '#43372e';
      context.fillRect(8, 8, 8, 3);
      context.fillStyle = '#ffffff';
      context.fillRect(9, 12, 2, 1);
      context.fillRect(13, 12, 2, 1);
      // Clear outer layers and slim-arm detection unused regions: classic model.
      context.clearRect(32, 0, 32, 16);
      context.clearRect(0, 32, 64, 16);
      context.clearRect(0, 48, 16, 16);
      context.clearRect(48, 48, 16, 16);
      return canvas.toDataURL('image/png').split(',')[1] ?? '';
    }),
    'base64',
  );
}
