import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { minecraftManifest } from '@nickhosting/minecraft';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 server Console entry and informational Status navigation', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let base: string;
  const errors: string[] = [];

  beforeAll(async () => {
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
    user = identities.user;
    user.on('pageerror', (error) => errors.push(error.message));
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
    base = `${fixture.origin}/servers/${provider.ids.serverId}`;
  });

  afterAll(async () => {
    provider?.dispose();
    await fixture?.close();
  });

  async function accessible() {
    const result = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((n) => n.target) })),
    ).toEqual([]);
    expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  }

  it('opens Console from the server list and replaces the root history entry, including trailing slash links', async () => {
    await user.goto(`${fixture.origin}/servers`);
    await user.getByRole('link', { name: 'Survival', exact: true }).click();
    await browserExpect(user).toHaveURL(`${base}/console`);
    await browserExpect(user.getByRole('heading', { name: 'Console', exact: true })).toBeVisible();
    await browserExpect(user.locator('.tabs a[aria-current="page"]')).toHaveText('Console');
    await user.goBack();
    await browserExpect(user).toHaveURL(`${fixture.origin}/servers`);
    await user.goForward();
    await browserExpect(user).toHaveURL(`${base}/console`);
    await user.goto(`${base}/`);
    await browserExpect(user).toHaveURL(`${base}/console`);
  });

  it('keeps Console first and Status last after Content, with keyboard access to the complete tab row', async () => {
    await user.goto(`${base}/console`);
    const tabs = user.locator('.tabs');
    const links = tabs.getByRole('link');
    await browserExpect(links.first()).toHaveText('Console');
    await browserExpect(links.nth(-2)).toHaveText('Content');
    await browserExpect(links.last()).toHaveText('Status');
    await browserExpect(tabs.getByRole('link', { name: 'Overview', exact: true })).toHaveCount(0);
    await links.first().focus();
    for (let index = 1; index < (await links.count()); index += 1) {
      await user.keyboard.press('Tab');
      await browserExpect(links.nth(index)).toBeFocused();
      await browserExpect(links.nth(index)).toBeInViewport({ ratio: 0.99 });
    }
    expect(
      await links.last().evaluate((element) => getComputedStyle(element).outlineStyle),
    ).not.toBe('none');
    await user.keyboard.press('Enter');
    await browserExpect(user).toHaveURL(`${base}/status`);
    await browserExpect(user.getByRole('heading', { name: 'Status', exact: true })).toBeVisible();
    await browserExpect(tabs.locator('[aria-current="page"]')).toHaveText('Status');
    for (const label of ['Process', 'Game readiness', 'Installation']) {
      await browserExpect(user.getByText(label, { exact: true })).toBeVisible();
    }
    for (const name of ['Start', 'Stop', 'Restart']) {
      await browserExpect(user.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    await accessible();
  });

  it('keeps lifecycle admission, job feedback and restart confirmation on Console', async () => {
    await user.goto(`${base}/console`);
    await browserExpect(user.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
    const server = await journeyRequest<{ availableActions: Record<string, boolean> }>(
      fixture,
      user,
      `/v1/platform/servers/${provider.ids.serverId}`,
    );
    for (const action of ['Start', 'Stop', 'Restart']) {
      await browserExpect(user.getByRole('button', { name: action, exact: true })).toBeEnabled({
        enabled: server.availableActions[action.toLowerCase()],
      });
    }
    await provider.setResourcesAvailable(false);
    await user.getByRole('button', { name: 'Start', exact: true }).click();
    await browserExpect(
      user.getByText('There is not enough available capacity to start this server.', {
        exact: true,
      }),
    ).toBeVisible();
    await provider.setResourcesAvailable(true);
    const accepted = user.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/v1/servers/${provider.ids.serverId}/operations`),
    );
    await user.getByRole('button', { name: 'Start', exact: true }).click();
    expect((await accepted).status()).toBe(202);
    await browserExpect(
      user.getByRole('link', { name: 'View operation', exact: true }),
    ).toBeVisible();
    await provider.processPending();
    await user.reload();
    await user.getByRole('button', { name: 'Restart', exact: true }).click();
    const dialog = user.getByRole('dialog');
    await browserExpect(dialog).toBeVisible();
    await browserExpect(dialog).toContainText('Survival');
    await user.keyboard.press('Escape');
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(user.getByRole('button', { name: 'Restart', exact: true })).toBeFocused();
    await user.getByRole('button', { name: 'Restart', exact: true }).click();
    const restarted = user.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/v1/servers/${provider.ids.serverId}/operations`),
    );
    await dialog.getByRole('button', { name: 'Restart', exact: true }).click();
    expect((await restarted).status()).toBe(202);
    await browserExpect(dialog).not.toBeVisible();
    await provider.processPending();
  });

  it('renders Console and Status in English and Italian at desktop and mobile sizes', async () => {
    for (const locale of ['en', 'it'] as const) {
      await journeyRequest(fixture, user, '/api/auth/update-user', { locale });
      for (const [size, width, height] of [
        ['desktop', 1440, 1000],
        ['mobile', 390, 844],
      ] as const) {
        await user.setViewportSize({ width, height });
        for (const tab of ['console', 'status']) {
          await user.goto(`${base}/${tab}`);
          await browserExpect(
            user.getByRole('heading', {
              name: tab === 'console' ? 'Console' : 'Status',
              exact: true,
            }),
          ).toBeVisible();
          await browserExpect(user.locator('.tabs a').last()).toHaveText('Status');
          await browserExpect(user.locator('.tabs a').nth(-2)).toHaveText(
            locale === 'en' ? 'Content' : 'Contenuti',
          );
          if (tab === 'console') await browserExpect(user.locator('.console pre')).toBeVisible();
          await accessible();
          await user.screenshot({
            path: resolve('docs/screenshots/m5', `server-navigation-${tab}-${size}-${locale}.png`),
            fullPage: true,
          });
        }
      }
    }
  });

  it('preserves operator power controls without a console stream and falls back to Status for viewers', async () => {
    await journeyRequest(fixture, user, '/api/auth/update-user', { locale: 'en' });
    const project = await journeyRequest<{ id: string }>(fixture, user, '/v1/projects', {
      name: 'Navigation viewers',
    });
    await journeyRequest(
      fixture,
      user,
      `/v1/platform/servers/${provider.ids.serverId}`,
      { projectId: project.id },
      'PATCH',
    );
    await journeyRequest(
      fixture,
      user,
      `/v1/projects/${project.id}/members`,
      { userId: identities.peerId, role: 'viewer' },
      'PUT',
    );
    const viewer = identities.peer;
    await viewer.goto(base);
    await browserExpect(viewer).toHaveURL(`${base}/console`);
    await browserExpect(
      viewer.getByRole('heading', { name: 'Console', exact: true }),
    ).toBeVisible();
    for (const name of ['Start', 'Stop', 'Restart']) {
      await browserExpect(viewer.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    // Only this disposable schema changes; the production manifest stays untouched.
    await fixture.database.db
      .updateTable('game_integrations')
      .set({
        manifest: {
          ...minecraftManifest,
          capabilities: { ...minecraftManifest.capabilities, console: false },
        },
      })
      .where('id', '=', minecraftManifest.id)
      .execute();
    await user.goto(base);
    await browserExpect(user).toHaveURL(`${base}/console`);
    await browserExpect(user.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
    await browserExpect(user.getByText('Unavailable', { exact: true }).first()).toBeVisible();
    await browserExpect(user.locator('.console')).toHaveCount(0);
    await viewer.goto(base);
    await browserExpect(viewer).toHaveURL(`${base}/status`);
    await browserExpect(viewer.getByRole('heading', { name: 'Status', exact: true })).toBeVisible();
    await browserExpect(
      viewer.locator('.tabs').getByRole('link', { name: 'Console', exact: true }),
    ).toHaveCount(0);
    await browserExpect(viewer.locator('.tabs a').last()).toHaveText('Status');
    expect(errors).toEqual([]);
  });
});
