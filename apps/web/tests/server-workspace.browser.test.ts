import { expect as browserExpect, type Route } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('server workspace permission and pending-navigation boundaries', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  const errors: string[] = [];
  beforeAll(async () => {
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
    for (const page of [identities.user, identities.peer])
      page.on('pageerror', (error) => errors.push(error.message));
  });
  afterAll(async () => {
    provider?.dispose();
    await fixture?.close();
  });
  const base = () => `${fixture.origin}/servers/${provider.ids.serverId}`;

  it('renders a console-only direct collaborator without querying or linking inaccessible Network', async () => {
    await journeyRequest(
      fixture,
      identities.user,
      `/v1/platform/servers/${provider.ids.serverId}/subusers/${identities.peerId}`,
      { permissionKeys: ['console.read'] },
      'PUT',
    );
    let connections = 0;
    identities.peer.on('request', (request) => {
      if (request.url().endsWith('/connections')) connections++;
    });
    await identities.peer.goto(`${base()}/console`);
    await browserExpect(identities.peer.locator('.console-terminal')).toBeVisible();
    await browserExpect(identities.peer.locator('.console-summary-card')).toHaveCount(6);
    await browserExpect(identities.peer.locator('a[href$="/network"]')).toHaveCount(0);
    await browserExpect(identities.peer.locator('.console-actions button')).toHaveCount(0);
    await browserExpect(identities.peer.locator('.console-prompt')).toHaveCount(0);
    expect(connections).toBe(0);
  });

  it('keeps settings drafts across cancelled navigation and prevents discarding an in-flight save', async () => {
    const page = identities.user;
    await page.goto(`${base()}/settings`);
    await page.getByLabel('Name', { exact: true }).fill('Unsaved workspace');
    await page.locator('aside a[href$="/files"]').click();
    const discard = page.getByRole('dialog', { name: 'Unsaved changes' });
    await browserExpect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Cancel', exact: true }).click();
    await browserExpect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved workspace');
    let held: Route | undefined;
    const path = `**/v1/platform/servers/${provider.ids.serverId}`;
    await page.route(path, (route) => {
      if (route.request().method() === 'PATCH') held = route;
      else return route.continue();
    });
    const form = page.locator('form').filter({ has: page.getByLabel('Name', { exact: true }) });
    await form.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => !!held).toBe(true);
    await page.locator('aside a[href$="/files"]').click();
    await browserExpect(
      discard.getByRole('button', { name: 'Discard changes', exact: true }),
    ).toBeDisabled();
    await held?.fulfill({
      status: 503,
      json: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
    });
    await browserExpect(
      discard.getByRole('button', { name: 'Discard changes', exact: true }),
    ).toBeEnabled();
    await discard.getByRole('button', { name: 'Cancel', exact: true }).click();
    await browserExpect(form.getByRole('alert')).toBeVisible();
    await browserExpect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved workspace');
    await page.unroute(path);
    await page.locator('aside a[href$="/files"]').click();
    await discard.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await browserExpect(page).toHaveURL(`${base()}/files`);
  });

  it('keeps Network preview open during pending work, and requires explicit discard afterward', async () => {
    const page = identities.user;
    const prefix = `**/v1/servers/${provider.ids.serverId}`;
    await page.route(`${prefix}/connection-options`, (route) =>
      route.fulfill({
        json: {
          configured: true,
          customizable: true,
          mode: 'custom-subdomain',
          domains: [{ id: 'fixture', hostname: 'example.test' }],
          defaultDomainId: 'fixture',
          defaultHostname: null,
          supportsSrv: true,
        },
      }),
    );
    let held: Route | undefined;
    await page.route(`${prefix}/dns/preview`, (route) => {
      held = route;
    });
    await page.goto(`${base()}/network`);
    await page.getByRole('button', { name: 'Change address', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Change address' });
    await editor.getByLabel('Subdomain', { exact: true }).fill('draft');
    await editor.getByRole('button', { name: 'Preview address', exact: true }).click();
    await expect.poll(() => !!held).toBe(true);
    await page.keyboard.press('Escape');
    await browserExpect(editor).toBeVisible();
    await browserExpect(editor.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
    await held?.fulfill({
      json: { domainId: 'fixture', subdomain: 'draft', displayAddress: 'draft.example.test' },
    });
    await browserExpect(editor.getByText('draft.example.test', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    const discard = page.getByRole('dialog', { name: 'Unsaved changes' });
    await browserExpect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Cancel', exact: true }).click();
    await browserExpect(editor).toBeVisible();
    await page.keyboard.press('Escape');
    await discard.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await browserExpect(editor).not.toBeVisible();
    await page.getByRole('button', { name: 'Change address', exact: true }).click();
    await browserExpect(
      editor.getByRole('button', { name: 'Preview address', exact: true }),
    ).toBeVisible();
    await browserExpect(editor.getByText('draft.example.test', { exact: true })).toHaveCount(0);
    await editor.getByLabel('Subdomain', { exact: true }).fill('saved');
    const previousPreview = held;
    await editor.getByRole('button', { name: 'Preview address', exact: true }).click();
    await expect.poll(() => held !== previousPreview).toBe(true);
    await held?.fulfill({
      json: { domainId: 'fixture', subdomain: 'saved', displayAddress: 'saved.example.test' },
    });
    let saved = false;
    let refresh: Route | undefined;
    await page.route(`${prefix}/dns**`, (route) => {
      if (['POST', 'PUT'].includes(route.request().method())) {
        saved = true;
        return route.fulfill({ json: {} });
      }
      return route.fallback();
    });
    await page.route(`**/v1/platform/servers/${provider.ids.serverId}/connections`, (route) => {
      if (saved) refresh = route;
      else return route.continue();
    });
    await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => !!refresh).toBe(true);
    // The completed save still owns the pending state until its refresh finishes.
    // Closing early would allow its finally callback to unlock a newly opened editor.
    await browserExpect(editor).toBeVisible();
    await browserExpect(editor.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await browserExpect(editor).toBeVisible();
    await refresh?.continue();
    await browserExpect(editor).not.toBeVisible();
    await page.getByRole('button', { name: 'Change address', exact: true }).click();
    await browserExpect(editor.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  });
});
