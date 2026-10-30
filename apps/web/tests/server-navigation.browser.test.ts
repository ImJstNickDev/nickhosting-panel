import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { minecraftManifest } from '@nickhosting/minecraft';
import { expect as browserExpect, type Page, type Route } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 contextual server sidebar and informational Status navigation', () => {
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
    await browserExpect(user.getByRole('heading', { name: 'Survival', exact: true })).toBeVisible();
    await browserExpect(user.locator('.sidebar a[aria-current="page"]')).toHaveText('Console');
    await user.goBack();
    await browserExpect(user).toHaveURL(`${fixture.origin}/servers`);
    await user.goForward();
    await browserExpect(user).toHaveURL(`${base}/console`);
    await user.goto(`${base}/`);
    await browserExpect(user).toHaveURL(`${base}/console`);
  });

  it('groups native and integration destinations in a contextual, keyboard accessible sidebar', async () => {
    await user.goto(`${base}/console`);
    const navigation = user.locator('.sidebar .nav');
    await browserExpect(user.locator('.sidebar-server')).toContainText('Survival');
    await browserExpect(navigation.locator('.sidebar-group')).toHaveText([
      'Your server',
      'Tools',
      'Config',
    ]);
    const links = navigation.getByRole('link');
    await browserExpect(links.first()).toHaveText('Console');
    for (const name of [
      'Files',
      'Activity',
      'Players',
      'Worlds',
      'Datapacks',
      'Modpacks',
      'Backups',
      'Schedules',
      'Network',
      'Settings',
      'Subusers',
    ]) {
      await browserExpect(navigation.getByRole('link', { name, exact: true })).toBeVisible();
    }
    for (const name of ['SFTP', 'Status', 'Minecraft', 'Home']) {
      await browserExpect(navigation.getByRole('link', { name, exact: true })).toHaveCount(0);
    }
    await browserExpect(user.locator('.game-section-tabs')).toHaveCount(0);
    await links.first().focus();
    for (let index = 1; index < (await links.count()); index += 1) {
      await user.keyboard.press('Tab');
      await browserExpect(links.nth(index)).toBeFocused();
      await browserExpect(links.nth(index)).toBeInViewport({ ratio: 0.99 });
    }
    await user.goto(`${base}/status`);
    await browserExpect(user.getByRole('heading', { name: 'Status', exact: true })).toBeVisible();
    await browserExpect(user.locator('.sidebar a[data-section-active]')).toHaveText('Console');
    for (const label of ['Process', 'Game readiness', 'Installation']) {
      await browserExpect(user.getByText(label, { exact: true })).toBeVisible();
    }
    await accessible();
  });

  it('preserves grouped links in the compact rail and mobile drawer, restoring focus on navigation', async () => {
    await user.setViewportSize({ width: 1440, height: 800 });
    await user.goto(`${base}/console`);
    await user.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
    await browserExpect(user.locator('.shell')).toHaveAttribute('data-sidebar-collapsed', 'true');
    await browserExpect(
      user.locator('.sidebar').getByRole('link', { name: 'Files', exact: true }),
    ).toBeVisible();
    await user.locator('.sidebar').getByRole('link', { name: 'Files', exact: true }).click();
    await browserExpect(user).toHaveURL(`${base}/files`);
    await browserExpect(user.locator('#content')).toBeFocused();
    await user.setViewportSize({ width: 390, height: 844 });
    await user.getByRole('button', { name: 'Menu', exact: true }).click();
    const drawer = user.getByRole('dialog', { name: 'Navigation', exact: true });
    await browserExpect(drawer.locator('.sidebar-group')).toHaveText([
      'Your server',
      'Tools',
      'Config',
    ]);
    await drawer.getByRole('link', { name: 'Console', exact: true }).click();
    await browserExpect(drawer).not.toBeVisible();
    await browserExpect(user.getByRole('heading', { name: 'Survival', exact: true })).toBeFocused();
    await user.setViewportSize({ width: 1440, height: 1000 });
    await user.getByRole('button', { name: 'Expand navigation', exact: true }).click();
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
    ).toHaveCount(0);
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
    // A slow descriptor refresh must not keep an accepted action/dialog busy.
    const descriptorPath = `**/v1/platform/servers/${provider.ids.serverId}`;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pendingRoutes: Promise<void>[] = [];
    await user.route(descriptorPath, (route) => {
      const pending = held.then(() => route.continue());
      pendingRoutes.push(pending);
      return pending;
    });
    try {
      await dialog.getByRole('button', { name: 'Restart', exact: true }).click();
      expect((await restarted).status()).toBe(202);
      await browserExpect(dialog).not.toBeVisible();
      for (const action of ['Start', 'Restart', 'Stop'])
        await browserExpect(
          user.locator('.console-actions').getByRole('button', { name: action, exact: true }),
        ).toBeDisabled();
    } finally {
      release();
      await Promise.all(pendingRoutes);
      await user.unroute(descriptorPath);
    }
    await provider.processPending();
  });

  it('loads the server switcher on demand, keeps the exit available on failure and restores keyboard focus', async () => {
    const path = '**/v1/platform/servers?*';
    let held: Route | undefined;
    let requests = 0;
    await user.route(path, (route) => {
      requests++;
      held = route;
    });
    try {
      await user.goto(`${base}/console`);
      const trigger = user.locator('.server-switcher-trigger');
      await browserExpect(trigger).toHaveAccessibleName('Currently managing: Survival');
      await browserExpect(trigger).toContainText('Currently managing');
      await browserExpect(user.locator('.sidebar-server-identity')).toHaveCount(0);
      expect(requests).toBe(0);
      await trigger.focus();
      await trigger.press('Enter');
      const popup = user.getByRole('dialog', { name: 'Switch server', exact: true });
      await browserExpect(popup).toBeVisible();
      await expect.poll(() => held !== undefined).toBe(true);
      await browserExpect(
        popup.getByRole('link', { name: 'All servers', exact: true }),
      ).toBeVisible();
      await held?.fulfill({
        status: 503,
        json: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
      });
      await browserExpect(popup.getByRole('alert')).toBeVisible();
      await user.unroute(path);
      await popup.getByRole('button', { name: 'Try again', exact: true }).click();
      await browserExpect(popup.getByRole('link', { name: 'Survival', exact: true })).toBeVisible();
      await accessible();
      await user.screenshot({
        path: resolve('docs/screenshots/m5/server-switcher-open-desktop-en.png'),
        fullPage: true,
      });
      await user.keyboard.press('Escape');
      await browserExpect(popup).not.toBeVisible();
      await browserExpect(trigger).toBeFocused();
      await trigger.click();
      await browserExpect(popup).toBeVisible();
      await user.locator('.topbar-context').click();
      await browserExpect(popup).not.toBeVisible();
    } finally {
      await user.unroute(path);
    }
  });

  it('switches real isolated servers with draft protection and keeps the chooser usable in compact and mobile navigation', async () => {
    const created = await journeyRequest<{ serverId: string }>(fixture, user, '/v1/servers', {
      idempotencyKey: randomUUID(),
      mappingId: provider.ids.mappingId,
      name: 'Creative',
      limits: { memory: 128, cpu: 10, disk: 64, swap: 0, io: 500 },
      autoStart: false,
      minecraft: { choiceId: provider.ids.choiceId, configuration: { eula: true } },
    });
    await provider.processPending();
    await user.goto(`${base}/settings`);
    await user.getByLabel('Name', { exact: true }).fill('Unsaved server name');
    const trigger = user.locator('.server-switcher-trigger');
    const popup = user.getByRole('dialog', { name: 'Switch server', exact: true });
    await trigger.click();
    await popup.getByRole('link', { name: 'Creative', exact: true }).click();
    const discard = user.getByRole('dialog', { name: 'Unsaved changes', exact: true });
    await browserExpect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Cancel', exact: true }).click();
    await browserExpect(user.getByLabel('Name', { exact: true })).toHaveValue(
      'Unsaved server name',
    );
    await browserExpect(trigger).toHaveAccessibleName('Currently managing: Survival');
    await trigger.click();
    await popup.getByRole('link', { name: 'Creative', exact: true }).click();
    await discard.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await browserExpect(user).toHaveURL(`${fixture.origin}/servers/${created.serverId}/console`);
    await browserExpect(trigger).toHaveAccessibleName('Currently managing: Creative');
    await user.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
    await trigger.click();
    await browserExpect(popup).toBeInViewport({ ratio: 1 });
    await accessible();
    await user.screenshot({
      path: resolve('docs/screenshots/m5/server-switcher-compact-en.png'),
      fullPage: true,
    });
    await popup.getByRole('link', { name: 'Survival', exact: true }).click();
    await browserExpect(user).toHaveURL(`${base}/console`);
    await user.getByRole('button', { name: 'Expand navigation', exact: true }).click();
    await journeyRequest(fixture, user, '/api/auth/update-user', { locale: 'it' });
    await user.setViewportSize({ width: 390, height: 844 });
    await user.reload();
    await user.getByRole('button', { name: 'Menu', exact: true }).click();
    const drawer = user.getByRole('dialog', { name: 'Navigazione', exact: true });
    await browserExpect(trigger).toHaveAccessibleName('Gestione attuale: Survival');
    await user.screenshot({
      path: resolve('docs/screenshots/m5/server-switcher-mobile-it.png'),
      fullPage: false,
    });
    await trigger.click();
    const mobilePopup = user.getByRole('dialog', { name: 'Cambia server', exact: true });
    await browserExpect(mobilePopup).toBeInViewport({ ratio: 1 });
    await accessible();
    await user.screenshot({
      path: resolve('docs/screenshots/m5/server-switcher-open-mobile-it.png'),
      fullPage: false,
    });
    await user.keyboard.press('Escape');
    await browserExpect(mobilePopup).not.toBeVisible();
    await browserExpect(drawer).toBeVisible();
    await browserExpect(trigger).toBeFocused();
    await trigger.click();
    await mobilePopup.getByRole('link', { name: 'Tutti i server', exact: true }).click();
    await browserExpect(user).toHaveURL(`${fixture.origin}/servers`);
    await browserExpect(drawer).not.toBeVisible();
    await journeyRequest(fixture, user, '/api/auth/update-user', { locale: 'en' });
    await user.setViewportSize({ width: 1440, height: 1000 });
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
              name: tab === 'console' ? 'Survival' : 'Status',
              exact: true,
            }),
          ).toBeVisible();
          if (size === 'desktop')
            await browserExpect(user.locator('.sidebar a[data-section-active]')).toHaveText(
              'Console',
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
      viewer.getByRole('heading', { name: 'Survival', exact: true }),
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
      viewer.locator('.sidebar').getByRole('link', { name: 'Console', exact: true }),
    ).toHaveAttribute('href', `/servers/${provider.ids.serverId}/status`);
    expect(errors).toEqual([]);
  });
});
