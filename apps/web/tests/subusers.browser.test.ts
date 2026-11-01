import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 Subusers direct granular permissions', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let user: Page;
  let base: string;
  let path: string;
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
    path = `/v1/platform/servers/${provider.ids.serverId}/subusers`;
  });
  afterAll(async () => {
    provider?.dispose();
    await fixture?.close();
  });
  async function editor() {
    await user.getByRole('button', { name: 'Add subuser', exact: true }).click();
    const dialog = user.getByRole('dialog', { name: 'Add subuser', exact: true });
    await dialog
      .getByRole('textbox', { name: 'Registered email address' })
      .fill(identities.peerEmail);
    await dialog.getByRole('button', { name: 'Find user', exact: true }).click();
    return user.getByRole('dialog', { name: 'Permissions for Taylor', exact: true });
  }
  it('grants direct access without a project, applies READ dependencies, and hides unauthorized destinations', async () => {
    await user.goto(`${base}/subusers`);
    await browserExpect(user.getByRole('heading', { name: 'Subusers', exact: true })).toBeVisible();
    const dialog = await editor();
    await dialog.getByRole('checkbox', { name: 'Console: Power', exact: true }).check();
    await browserExpect(
      dialog.getByRole('checkbox', { name: 'Console: Read', exact: true }),
    ).toBeChecked();
    await dialog.getByRole('checkbox', { name: 'Files: Read', exact: true }).check();
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(user.getByRole('status')).toContainText('Permissions saved.');
    const value = await journeyRequest<{
      items: { userId: string; directPermissionKeys: string[]; project: unknown }[];
    }>(fixture, user, path);
    const peer = value.items.find((item) => item.userId === identities.peerId);
    expect(peer?.directPermissionKeys.sort()).toEqual([
      'console.power',
      'console.read',
      'files.read',
    ]);
    expect(peer?.project).toBeNull();
    await identities.peer.goto(`${base}/console`);
    const nav = identities.peer.locator('.sidebar .nav');
    await browserExpect(nav.getByRole('link', { name: 'Console', exact: true })).toBeVisible();
    await browserExpect(nav.getByRole('link', { name: 'Files', exact: true })).toBeVisible();
    for (const name of [
      'Subusers',
      'Backups',
      'Settings',
      'Players',
      'Modpacks',
      'Network',
      'Schedules',
    ])
      await browserExpect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
  });
  it('keeps drafts through transient errors and confirms leaving the editor', async () => {
    await user.goto(`${base}/subusers`);
    await user.getByRole('button', { name: 'Permissions for Taylor', exact: true }).click();
    const dialog = user.getByRole('dialog', { name: 'Permissions for Taylor', exact: true });
    await dialog.getByRole('checkbox', { name: 'Files: Write', exact: true }).check();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    const confirm = user.getByRole('dialog', { name: 'Discard permission changes?', exact: true });
    await browserExpect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await browserExpect(
      dialog.getByRole('checkbox', { name: 'Files: Write', exact: true }),
    ).toBeChecked();
    await user.route(`**${path}`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'upstream_unavailable', messageKey: 'errors.upstream_unavailable' },
        }),
      }),
    );
    await user.waitForTimeout(11000);
    await browserExpect(
      dialog.getByRole('checkbox', { name: 'Files: Write', exact: true }),
    ).toBeChecked();
    await browserExpect(
      dialog.getByRole('button', { name: 'Save changes', exact: true }),
    ).toBeDisabled();
    await user.unroute(`**${path}`);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await confirm.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await browserExpect(dialog).not.toBeVisible();
  });
  it('edits overlapping direct grants while preserving inherited access and removes only direct access', async () => {
    const project = await journeyRequest<{ id: string }>(fixture, user, '/v1/projects', {
      name: 'Shared operations',
    });
    await journeyRequest(
      fixture,
      user,
      `/v1/projects/${project.id}/members`,
      { userId: identities.peerId, role: 'viewer' },
      'PUT',
    );
    await journeyRequest(
      fixture,
      user,
      `/v1/platform/servers/${provider.ids.serverId}`,
      { projectId: project.id },
      'PATCH',
    );
    await user.goto(`${base}/subusers`);
    await user.getByRole('button', { name: 'Permissions for Taylor', exact: true }).click();
    const dialog = user.getByRole('dialog', { name: 'Permissions for Taylor', exact: true });
    const inherited = dialog.getByRole('checkbox', { name: 'Files: Read', exact: true });
    await browserExpect(inherited).toBeChecked();
    await browserExpect(inherited).toBeEnabled();
    await dialog.getByRole('checkbox', { name: 'Console: Read', exact: true }).uncheck();
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(dialog).not.toBeVisible();
    const overlap = await journeyRequest<{
      items: {
        userId: string;
        directPermissionKeys: string[];
        effectivePermissionKeys: string[];
      }[];
    }>(fixture, user, path);
    const overlappingPeer = overlap.items.find((item) => item.userId === identities.peerId);
    expect(overlappingPeer?.directPermissionKeys).toEqual(['files.read']);
    expect(overlappingPeer?.effectivePermissionKeys).toContain('console.read');
    await user.getByRole('button', { name: 'Permissions for Taylor', exact: true }).click();
    await browserExpect(
      dialog.getByRole('checkbox', { name: 'Console: Read', exact: true }),
    ).not.toBeChecked();
    await browserExpect(
      dialog.getByRole('checkbox', { name: 'Console: Read', exact: true }),
    ).toHaveAccessibleDescription('Project');
    await browserExpect(dialog.getByText('Inherited from Shared operations').first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await user.getByRole('button', { name: 'Remove direct access', exact: true }).click();
    const confirm = user.getByRole('dialog', { name: 'Remove direct access', exact: true });
    await browserExpect(confirm).toContainText(
      'Access inherited from Shared operations will remain.',
    );
    await confirm.getByRole('button', { name: 'Remove direct access', exact: true }).click();
    await browserExpect(confirm).not.toBeVisible();
    const value = await journeyRequest<{
      items: {
        userId: string;
        directPermissionKeys: string[];
        inheritedPermissionKeys: string[];
      }[];
    }>(fixture, user, path);
    const peer = value.items.find((item) => item.userId === identities.peerId);
    expect(peer?.directPermissionKeys).toEqual([]);
    expect(peer?.inheritedPermissionKeys).toContain('files.read');
  });
  it('renders the complete matrix accessibly in EN/IT at desktop and mobile sizes', async () => {
    for (const locale of ['en', 'it'] as const) {
      await journeyRequest(fixture, user, '/api/auth/update-user', { locale });
      for (const width of [1440, 390]) {
        await user.setViewportSize({ width, height: 1000 });
        await user.goto(`${base}/subusers`);
        await user
          .getByRole('button', {
            name: locale === 'en' ? 'Permissions for Taylor' : 'Permessi di Taylor',
            exact: true,
          })
          .click();
        const dialog = user.getByRole('dialog', {
          name: locale === 'en' ? 'Permissions for Taylor' : 'Permessi di Taylor',
          exact: true,
        });
        await browserExpect(dialog).toBeVisible();
        const result = await new AxeBuilder({ page: user })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((n) => n.target) })),
        ).toEqual([]);
        expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await user.screenshot({
          path: resolve('docs/screenshots/m5', `subusers-matrix-${width}-${locale}.png`),
          fullPage: true,
        });
        await user.keyboard.press('Escape');
      }
    }
    expect(errors).toEqual([]);
  });
});
