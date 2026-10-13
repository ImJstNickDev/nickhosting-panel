import { Buffer } from 'node:buffer';
import { expect as browserExpect } from '@playwright/test';
import { expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

it('applies compiled Fileman toolbar patches to actual nested viewer transitions and removes their scope on exit', async () => {
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
    const files = await provider.files();
    files.set('nested.zip', Buffer.from('isolated metadata fixture'));
    files.set('editable.txt', Buffer.from('editable fixture'));
    const prefix = `/v1/servers/${provider.ids.serverId}/files/viewer`;
    // Test-only compiled module substitution. No product registry, API or setting loads code.
    await page.route('**/src/features/fileman/extensions.ts', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `export const gameFilemanExtensions = [{
        descriptor: {id:'minecraft-java:fixture-context', gameId:'minecraft-java', priority:0},
        patches: [{slot:'toolbar', mode:'append', render: context =>
          'fixture-context:' + context.surface + ':' + (context.viewerId || 'none') + ':' + context.readOnly + ':' + context.path}]
      }];`,
      }),
    );
    await page.route(
      (url) => url.pathname.startsWith(`${prefix}/`),
      async (route) => {
        const url = new URL(route.request().url());
        const action = url.pathname.slice(prefix.length);
        if (action === '/capabilities') return route.fulfill({ json: { available: true } });
        if (action === '/preferences') return route.fulfill({ json: { preferences: [] } });
        if (action === '/archive')
          return route.fulfill({
            json: {
              directory: '',
              offset: 0,
              limit: 200,
              total: 1,
              entries: [{ name: 'config.json', path: 'config.json', size: 12, directory: false }],
            },
          });
        if (action === '/archive/content')
          return route.fulfill({ body: '{"ready":true}', contentType: 'application/json' });
        return route.fulfill({ status: 404, json: { messageKey: 'viewer.unavailable' } });
      },
    );
    await page.goto(`${harness.origin}/servers/${provider.ids.serverId}/files`);
    await browserExpect(page.locator('.file-manager')).toContainText(
      'fixture-context:directory:none:false:',
    );
    await page.locator('.fm-filename').getByText('nested.zip', { exact: true }).click();
    await browserExpect(page.locator('.file-manager')).toContainText(
      'fixture-context:viewer:archive:true:nested.zip',
    );
    await page.locator('.fm-filename').getByText('config.json', { exact: true }).click();
    await browserExpect(page.locator('.ve-json')).toBeVisible();
    await browserExpect(page.locator('.file-manager')).toContainText(
      'fixture-context:viewer:json:true:nested.zip',
    );
    await page.getByRole('button', { name: 'Back to files', exact: true }).click();
    await browserExpect(page.locator('.file-manager')).toContainText(
      'fixture-context:directory:none:false:',
    );
    expect(await page.locator('.file-manager').textContent()).not.toContain(
      'fixture-context:viewer:',
    );
    await page.locator('.fm-filename').getByText('editable.txt', { exact: true }).click();
    await browserExpect(page.locator('.cm-editor')).toBeVisible();
    await browserExpect(page.locator('.file-manager')).toContainText(
      'fixture-context:viewer:text:false:editable.txt',
    );
  } finally {
    provider?.dispose();
    await harness.close();
  }
});
