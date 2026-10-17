import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('Owner direct endpoints through protected handlers', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let owner: Page;
  let claimedId: number;
  let spareId: number;
  let originalHost: string;
  const errors: string[] = [];
  beforeAll(async () => {
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
    owner = identities.owner;
    owner.on('pageerror', (error) => errors.push(error.message));
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    const db = fixture.database.db;
    const claim = await db
      .selectFrom('server_allocations')
      .select('pterodactyl_allocation_id')
      .where('server_id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    claimedId = claim.pterodactyl_allocation_id;
    const all = await provider.adapter.listAllocations(1);
    const spare = all.find((allocation) => !allocation.assigned && allocation.id !== claimedId);
    if (!spare) throw new Error('Isolated fixture needs an unclaimed allocation');
    spareId = spare.id;
    // Keep two existing fixture pins so the rendered dialog remains inspectable.
    // Only the provider is simulated; all browser/API/DB handlers remain real.
    const selected = all.filter((allocation) => [claimedId, spareId].includes(allocation.id));
    provider.adapter.listAllocations = async () => structuredClone(selected);
    const node = await db
      .selectFrom('managed_nodes')
      .selectAll()
      .where('id', '=', provider.ids.nodeId)
      .executeTakeFirstOrThrow();
    if (!node.backend_allocation_pool) throw new Error('Missing fixture pool');
    const pool = node.backend_allocation_pool;
    originalHost =
      pool.allocations.find((pin) => pin.allocationId === claimedId)?.directEndpoint?.hostname ??
      '';
    await db
      .updateTable('managed_nodes')
      .set({
        backend_allocation_pool: JSON.stringify({
          ...pool,
          allocations: pool.allocations.filter((pin) =>
            [claimedId, spareId].includes(pin.allocationId),
          ),
        }),
      })
      .where('id', '=', node.id)
      .execute();
    fixture.setManagement(provider.management);
  });
  afterAll(async () => {
    provider?.dispose();
    await fixture?.close();
  });
  async function open(locale: 'en' | 'it' = 'en') {
    await owner.goto(`${fixture.origin}/owner/infrastructure`);
    await owner
      .getByRole('button', {
        name: locale === 'en' ? 'Managed nodes' : 'Nodi gestiti',
        exact: true,
      })
      .click();
    await owner
      .getByRole('button', { name: locale === 'en' ? 'Edit' : 'Modifica', exact: true })
      .click();
    const dialog = owner.getByRole('dialog');
    await dialog
      .getByRole('button', {
        name: `${locale === 'en' ? 'Direct connection' : 'Connessione diretta'} · ${spareId}`,
        exact: true,
      })
      .click();
    await browserExpect(dialog.locator(`[name="directHost-${spareId}"]`)).toBeVisible();
    return dialog;
  }
  it('saves an explicit unclaimed endpoint and direct-only choice without changing claimed pins', async () => {
    const dialog = await open();
    await dialog.locator(`[name="directHost-${spareId}"]`).fill('play.example.test');
    await dialog.locator(`[name="directPort-${spareId}"]`).fill('27091');
    await dialog.locator(`[name="directOnly-${spareId}"]`).check();
    await dialog.locator(`[name="directHost-${spareId}"]`).scrollIntoViewIfNeeded();
    await fixture.screenshot(owner, 'direct-endpoints-desktop-en');
    expect(
      (
        await new AxeBuilder({ page: owner })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    const saved = owner.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && response.url().endsWith('/owner/nodes'),
    );
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await browserExpect(dialog).toHaveCount(0);
    const node = await fixture.database.db
      .selectFrom('managed_nodes')
      .selectAll()
      .where('id', '=', provider.ids.nodeId)
      .executeTakeFirstOrThrow();
    expect(
      node.backend_allocation_pool?.allocations.find((pin) => pin.allocationId === spareId),
    ).toMatchObject({
      delivery: 'direct',
      directEndpoint: { hostname: 'play.example.test', port: 27091 },
    });
    expect(
      node.backend_allocation_pool?.allocations.find((pin) => pin.allocationId === claimedId)
        ?.directEndpoint?.hostname,
    ).toBe(originalHost);
    expect(provider.remoteCount()).toBe(1);
  });
  it('rejects editing a claimed endpoint and renders the Italian mobile dialog without overflow', async () => {
    await journeyRequest(fixture, owner, '/api/auth/update-user', {
      name: 'Morgan Owner',
      locale: 'it',
    });
    await owner.setViewportSize({ width: 390, height: 844 });
    const dialog = await open('it');
    await dialog
      .getByRole('button', { name: `Connessione diretta · ${claimedId}`, exact: true })
      .click();
    const claimed = dialog.locator(`[name="directHost-${claimedId}"]`);
    await claimed.fill('changed.example.test');
    const refused = owner.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && response.url().endsWith('/owner/nodes'),
    );
    await dialog.getByRole('button', { name: 'Salva modifiche', exact: true }).click();
    expect((await refused).status()).toBe(409);
    await browserExpect(dialog).toBeVisible();
    await claimed.fill(originalHost);
    await dialog
      .getByRole('button', { name: `Connessione diretta · ${spareId}`, exact: true })
      .click();
    await dialog.locator(`[name="directHost-${spareId}"]`).scrollIntoViewIfNeeded();
    await fixture.screenshot(owner, 'direct-endpoints-mobile-it');
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (
        await new AxeBuilder({ page: owner })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(errors).toEqual([]);
    const claim = await fixture.database.db
      .selectFrom('server_allocations')
      .select('direct_endpoint')
      .where('server_id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    expect(claim.direct_endpoint?.hostname).toBe(originalHost);
    expect(provider.remoteCount()).toBe(1);
  });
});
