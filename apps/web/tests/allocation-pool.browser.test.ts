import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('Owner allocation range selection', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let owner: Page;
  let claimedId: number;
  let spareId: number;
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
    claimedId = (
      await db
        .selectFrom('server_allocations')
        .select('pterodactyl_allocation_id')
        .where('server_id', '=', provider.ids.serverId)
        .executeTakeFirstOrThrow()
    ).pterodactyl_allocation_id;
    const original = await provider.adapter.listAllocations(1);
    const spare = original.find((row) => !row.assigned && row.id !== claimedId);
    if (!spare) throw Error('Missing test spare');
    spareId = spare.id;
    const rows = Array.from({ length: 2400 }, (_, index) => ({
      id: index < 400 ? 1000 + index : 2000 + index - 400,
      ip: index < 400 ? '10.55.0.2' : '10.66.0.1',
      port: index < 400 ? 25000 + index : 30000 + index - 400,
      assigned: index < 400 && 1000 + index === claimedId,
    }));
    provider.adapter.listAllocations = async () => structuredClone(rows);
    const providerNodes = await provider.adapter.listNodes();
    const firstNode = providerNodes[0];
    if (!firstNode) throw Error('Missing fixture node');
    provider.adapter.listNodes = async () => [
      ...providerNodes,
      { ...firstNode, id: 2, name: 'Other fixture node' },
    ];
    const node = await db
      .selectFrom('managed_nodes')
      .selectAll()
      .where('id', '=', provider.ids.nodeId)
      .executeTakeFirstOrThrow();
    if (!node.backend_allocation_pool) throw Error('Missing test pool');
    await db
      .updateTable('managed_nodes')
      .set({
        backend_allocation_pool: JSON.stringify({
          ...node.backend_allocation_pool,
          allocations: node.backend_allocation_pool.allocations.filter((pin) =>
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
  it('selects 2000 ports while rendering 25 rows, preserving offscreen direct settings through a real save', async () => {
    await owner.goto(`${fixture.origin}/owner/infrastructure`);
    await owner.getByRole('button', { name: 'Managed nodes', exact: true }).click();
    await owner.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = owner.getByRole('dialog');
    const editor = dialog.getByTestId('allocation-pool-editor');
    await browserExpect(editor.locator('tbody tr')).toHaveCount(25);
    await editor
      .getByRole('button', { name: `Direct connection · ${spareId}`, exact: true })
      .click();
    await editor.locator(`[name="directHost-${spareId}"]`).fill('edited.example.test');
    await editor.locator(`[name="directPort-${spareId}"]`).fill('27500');
    await editor.locator(`[name="directOnly-${spareId}"]`).check();
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await editor.getByLabel('Provider address', { exact: true }).selectOption('10.66.0.1');
    await editor.getByLabel('First port', { exact: true }).fill('30000');
    await editor.getByLabel('Last port', { exact: true }).fill('31999');
    await editor
      .getByRole('button', { name: 'Include available allocations', exact: true })
      .click();
    await browserExpect(editor.getByRole('status')).toHaveText('2002 selected · 2400 allocations');
    await browserExpect(editor.locator('tbody tr')).toHaveCount(25);
    expect(await editor.locator('.direct-allocation-fields').count()).toBe(0);
    await editor.getByRole('button', { name: 'Next', exact: true }).click();
    await editor.getByRole('button', { name: 'Direct connection · 2025', exact: true }).click();
    await editor.locator('[name="directHost-2025"]').fill('second.example.test');
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await editor.getByLabel('Search by address, port or ID', { exact: true }).fill('31999');
    await browserExpect(editor.locator('tbody tr')).toHaveCount(1);
    await editor.getByLabel('Search by address, port or ID', { exact: true }).fill('');
    await editor.scrollIntoViewIfNeeded();
    await fixture.screenshot(owner, 'allocation-range-desktop-en');
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
    const node = await fixture.database.db
      .selectFrom('managed_nodes')
      .selectAll()
      .where('id', '=', provider.ids.nodeId)
      .executeTakeFirstOrThrow();
    expect(node.backend_allocation_pool?.allocations).toHaveLength(2002);
    expect(
      node.backend_allocation_pool?.allocations.find((pin) => pin.allocationId === spareId),
    ).toMatchObject({
      delivery: 'direct',
      directEndpoint: { hostname: 'edited.example.test', port: 27500 },
    });
    expect(
      node.backend_allocation_pool?.allocations.find((pin) => pin.allocationId === 2025),
    ).toMatchObject({ directEndpoint: { hostname: 'second.example.test', port: 30025 } });
    expect(provider.remoteCount()).toBe(1);
  });
  it('shows bounded selection in Italian on mobile without overflow', async () => {
    await journeyRequest(fixture, owner, '/api/auth/update-user', {
      name: 'Morgan Owner',
      locale: 'it',
    });
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.goto(`${fixture.origin}/owner/infrastructure`);
    await owner.getByRole('button', { name: 'Nodi gestiti', exact: true }).click();
    await owner.getByRole('button', { name: 'Modifica', exact: true }).click();
    const editor = owner.getByTestId('allocation-pool-editor');
    await editor.getByLabel('Indirizzo del provider', { exact: true }).selectOption('10.66.0.1');
    await editor.getByLabel('Mostra solo selezionate', { exact: true }).check();
    await browserExpect(editor.locator('tbody tr')).toHaveCount(25);
    await editor.scrollIntoViewIfNeeded();
    await fixture.screenshot(owner, 'allocation-range-mobile-it');
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
  });
  it('clears the selection on a provider-node change and does not retain assigned identities from the original node', async () => {
    const dialog = owner.getByRole('dialog');
    await dialog.getByLabel('Nodo Pterodactyl', { exact: true }).selectOption('2');
    const editor = dialog.getByTestId('allocation-pool-editor');
    await browserExpect(editor.getByRole('status')).toHaveText('0 selezionate · 2400 allocazioni');
    await browserExpect(
      editor.getByLabel(`Includi allocazione ${claimedId}`, { exact: true }),
    ).toBeDisabled();
    await browserExpect(editor.locator('.direct-allocation-fields')).toHaveCount(0);
    expect(provider.remoteCount()).toBe(1);
  });
});
