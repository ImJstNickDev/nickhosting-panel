import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { browserMinecraft } from './minecraft-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('Owner integration-defined runtime images through real handlers', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let owner: Page;
  const pageErrors: string[] = [];
  beforeAll(async () => {
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
    owner = identities.owner;
    owner.on('pageerror', (error) => pageErrors.push(error.message));
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    // Only the external provider is simulated. The actual protected mapping
    // handler discovers this egg; no browser interception or fake API response.
    const egg = await provider.adapter.getEgg(1, 1);
    egg.docker_images = {
      ...egg.docker_images,
      IntegrationJava25: 'ghcr.io/pterodactyl/yolks:java_25',
    };
    fixture.setManagement(provider.management);
  });
  afterAll(async () => {
    provider?.dispose();
    await fixture?.close();
  });
  async function openNew() {
    await owner.goto(`${fixture.origin}/owner/infrastructure`);
    await owner.getByRole('button', { name: 'Runtime and egg mappings', exact: true }).click();
    await owner.getByRole('button', { name: 'Add runtime mapping', exact: true }).click();
    const dialog = owner.getByRole('dialog');
    await dialog.getByLabel('Game integration', { exact: true }).selectOption('minecraft-java');
    await dialog.getByLabel('Runtime', { exact: true }).selectOption('vanilla');
    await dialog.getByLabel('Pterodactyl node', { exact: true }).selectOption(provider.ids.nodeId);
    await dialog.getByLabel('Nest', { exact: true }).selectOption('1');
    await dialog.getByLabel('Egg', { exact: true }).selectOption('1');
    return dialog;
  }
  it('defaults new Minecraft mappings to integration policy and preserves explicit fixed selection', async () => {
    const dialog = await openNew();
    await browserExpect(dialog.getByLabel('Image selection', { exact: true })).toHaveValue(
      'integration',
    );
    await browserExpect(dialog.getByLabel('Container image', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Image selection', { exact: true }).selectOption('static');
    await browserExpect(dialog.getByLabel('Container image', { exact: true })).toBeVisible();
    await dialog
      .getByLabel('Container image', { exact: true })
      .selectOption(browserMinecraft.image);
    await dialog.getByLabel('Image selection', { exact: true }).selectOption('integration');
    // Vanilla already has an immutable fixture mapping on this node. A separate
    // declared profile avoids violating the one-mapping-per-runtime/node rule.
    await dialog.getByLabel('Runtime', { exact: true }).selectOption('paper');
    await browserExpect(dialog.getByLabel('Image selection', { exact: true })).toHaveValue(
      'integration',
    );
    await dialog.getByLabel('Primary port', { exact: true }).selectOption('game');
    await fixture.screenshot(owner, 'runtime-images-integration-desktop-en');
    const accessibility = await new AxeBuilder({ page: owner })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    const saved = owner.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && response.url().endsWith('/runtime-mappings'),
    );
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await browserExpect(dialog).toHaveCount(0);
    const rows = await fixture.database.db.selectFrom('runtime_egg_mappings').selectAll().execute();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id !== provider.ids.mappingId)?.image_mode).toBe('integration');
    expect(provider.remoteCount()).toBe(1);
  });
  it('does not silently convert an existing static mapping and renders Italian mobile policy', async () => {
    await owner.goto(`${fixture.origin}/owner/infrastructure`);
    await owner.getByRole('button', { name: 'Runtime and egg mappings', exact: true }).click();
    const table = owner
      .getByRole('table')
      .filter({ has: owner.getByRole('columnheader', { name: 'Runtime', exact: true }) });
    await table.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const dialog = owner.getByRole('dialog');
    // Locate original mapping by persisted ordering rather than assume that an
    // integration mapping is static: reopen the matching image if necessary.
    if ((await dialog.getByLabel('Image selection', { exact: true }).inputValue()) !== 'static') {
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await table.getByRole('button', { name: 'Edit', exact: true }).last().click();
    }
    await browserExpect(dialog.getByLabel('Image selection', { exact: true })).toHaveValue(
      'static',
    );
    await browserExpect(dialog.getByLabel('Container image', { exact: true })).toHaveValue(
      browserMinecraft.image,
    );
    await owner.keyboard.press('Escape');
    await journeyRequest(fixture, owner, '/api/auth/update-user', {
      name: 'Morgan Owner',
      locale: 'it',
    });
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.goto(`${fixture.origin}/owner/infrastructure`);
    await owner
      .getByRole('button', { name: 'Associazioni tra runtime ed egg', exact: true })
      .click();
    await owner.getByRole('button', { name: 'Aggiungi associazione runtime', exact: true }).click();
    await dialog
      .getByLabel('Integrazione del gioco', { exact: true })
      .selectOption('minecraft-java');
    await dialog.getByLabel('Runtime', { exact: true }).selectOption('vanilla');
    await browserExpect(dialog.getByLabel('Scelta dell’immagine', { exact: true })).toHaveValue(
      'integration',
    );
    await browserExpect(dialog.getByLabel('Immagine del container', { exact: true })).toHaveCount(
      0,
    );
    await fixture.screenshot(owner, 'runtime-images-integration-mobile-it');
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const accessibility = await new AxeBuilder({ page: owner })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    expect(pageErrors).toEqual([]);
    const original = await fixture.database.db
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', provider.ids.mappingId)
      .executeTakeFirstOrThrow();
    expect(original.image_mode).toBe('static');
    expect(original.docker_image).toBe(browserMinecraft.image);
  });
});
