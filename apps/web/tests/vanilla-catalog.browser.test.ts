import { createHash } from 'node:crypto';
import { AxeBuilder } from '@axe-core/playwright';
import { createRuntimeMetadataClient, minecraftManifestUrl } from '@nickhosting/minecraft';
import { refreshMinecraftMetadata } from '@nickhosting/server-management';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

/** Real Owner UI/auth/handlers/database. Only external Mojang/protocol metadata and
 * Pterodactyl egg inventory are synthetic; no real runtime compatibility is claimed. */
describe('Owner automatic Vanilla discovery', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let owner: Page;
  const pageErrors: string[] = [];
  const requests: string[] = [];
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
    fixture.setManagement(provider.management);
    // Disable only this disposable schema's pre-existing signed synthetic choice.
    // It must not mask whether new declarations work without per-instance evidence.
    await fixture.database.db
      .updateTable('minecraft_combinations')
      .set({ enabled: false })
      .execute();
    delete fixture.env.NH_MINECRAFT_EVIDENCE_KEY;
    await fixture.database.db
      .updateTable('runtime_egg_mappings')
      .set({ image_mode: 'integration', docker_image: '' })
      .where('id', '=', provider.ids.mappingId)
      .execute();
    const egg = await provider.adapter.getEgg(1, 1);
    egg.docker_images = {
      Java21: 'ghcr.io/pterodactyl/yolks:java_21',
      Java25: 'ghcr.io/pterodactyl/yolks:java_25',
    };
    const variable = egg.relationships?.variables?.data[0]?.attributes;
    if (!variable || !egg.relationships?.variables) throw new Error('Missing isolated egg fixture');
    egg.relationships.variables.data = [
      { attributes: { ...variable, env_variable: 'VANILLA_VERSION', default_value: 'latest' } },
      {
        attributes: {
          ...variable,
          id: 2,
          env_variable: 'SERVER_JARFILE',
          default_value: 'server.jar',
        },
      },
    ];
    const documents = new Map<string, Buffer>();
    const versionIds = [
      '26.3',
      '26.1',
      '1.21.11',
      ...Array.from({ length: 41 }, (_, i) => `25w${String(i + 1).padStart(2, '0')}a`),
    ];
    const versions = versionIds.map((id) => {
      const url = `https://piston-meta.mojang.com/v1/packages/fixture/${id}.json`;
      const bytes = Buffer.from(
        JSON.stringify({
          id,
          javaVersion: { majorVersion: id.startsWith('26.') ? 25 : 21 },
          downloads:
            id === '26.3'
              ? {}
              : {
                  server: {
                    url: 'https://piston-data.mojang.com/v1/objects/fixture/server.jar',
                    sha1: 'a'.repeat(40),
                    size: 1,
                  },
                },
        }),
      );
      documents.set(url, bytes);
      return {
        id,
        type: id.startsWith('25w') ? 'snapshot' : 'release',
        releaseTime:
          id === '25w01a'
            ? '2025-01-01T00:00:00Z'
            : id.startsWith('25w')
              ? '2026-10-01T00:00:00Z'
              : '2026-01-01T00:00:00Z',
        url,
        sha1: createHash('sha1').update(bytes).digest('hex'),
      };
    });
    documents.set(minecraftManifestUrl, Buffer.from(JSON.stringify({ versions })));
    const protocols = Buffer.from(
      JSON.stringify(
        ['26.1', '1.21.11'].map((minecraftVersion) => ({
          minecraftVersion,
          version: minecraftVersion === '26.1' ? 775 : 774,
          usesNetty: true,
          releaseType: 'release',
        })),
      ),
    );
    const commit = 'c'.repeat(40);
    fixture.env.NH_MINECRAFT_METADATA_USER_AGENT =
      'NickHosting browser fixture (https://github.com/ImJstNickDev/nickhosting-panel)';
    fixture.env.NH_MINECRAFT_PROTOCOL_SOURCE = JSON.stringify({
      commit,
      sha256: createHash('sha256').update(protocols).digest('hex'),
    });
    documents.set(
      `https://raw.githubusercontent.com/PrismarineJS/minecraft-data/${commit}/data/pc/common/protocolVersions.json`,
      protocols,
    );
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      const bytes = documents.get(url);
      if (!bytes) throw new Error('Unexpected external request during isolated catalog discovery');
      return new Response(bytes.toString('utf8'), {
        headers: { 'content-type': 'application/json' },
      });
    });
    await refreshMinecraftMetadata(fixture.database.db, {
      client: createRuntimeMetadataClient({
        userAgent: fixture.env.NH_MINECRAFT_METADATA_USER_AGENT,
      }),
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    provider?.dispose();
    await fixture?.close();
  });
  async function discover(waitForCompletion = true) {
    const response = owner.waitForResponse(
      (item) =>
        item.request().method() === 'POST' &&
        item.url().endsWith('/v1/owner/minecraft/catalog/sync'),
    );
    await owner.getByRole('button', { name: 'Discover Vanilla versions', exact: true }).click();
    const result = await response;
    expect(result.status()).toBe(200);
    if (waitForCompletion)
      await browserExpect(
        owner.getByRole('button', { name: 'Discover Vanilla versions', exact: true }),
      ).toBeEnabled();
    return result.json() as Promise<{
      items: { id?: string; status: string; version: string; reason?: string }[];
    }>;
  }
  it('discovers declared versions without local evidence and exposes honest capabilities', async () => {
    await owner.goto(`${fixture.origin}/owner/integrations/minecraft-java`);
    await browserExpect(
      owner.getByRole('heading', { name: 'Minecraft compatibility', exact: true }),
    ).toBeVisible();
    await browserExpect(
      owner.getByRole('button', { name: 'Register runtime combination', exact: true }),
    ).toHaveCount(0);
    const result = await discover();
    expect(result.items.filter((item) => item.status === 'registered')).toHaveLength(2);
    expect(result.items.find((item) => item.version === '26.3')).toMatchObject({
      status: 'unavailable',
      reason: 'minecraft_server_download_unavailable',
    });
    await browserExpect(
      owner.getByText('No dedicated-server download is available.', { exact: false }),
    ).toBeVisible();
    const rows = await fixture.database.db
      .selectFrom('minecraft_combinations')
      .selectAll()
      .where(
        'id',
        'in',
        result.items.flatMap((item) => (item.id ? [item.id] : [])),
      )
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.enabled === true)).toBe(true);
    expect(
      await fixture.database.db
        .selectFrom('minecraft_verification_evidence')
        .select('id')
        .where(
          'combination_id',
          'in',
          rows.map((row) => row.id),
        )
        .execute(),
    ).toEqual([]);
    const directRow = owner
      .getByRole('row')
      .filter({ has: owner.getByRole('cell', { name: '1.21.11', exact: true }) });
    await browserExpect(
      directRow.getByRole('cell', { name: 'Supported by integration', exact: true }),
    ).toBeVisible();
    await directRow.getByRole('button', { name: 'View details', exact: true }).click();
    await browserExpect(owner.getByText('Trusted integration', { exact: true })).toBeVisible();
    await browserExpect(owner.getByText('Gateway connection', { exact: true })).toBeVisible();
    await browserExpect(owner.getByText('Automatic sleep/wake', { exact: true })).toBeVisible();
    const choices = (await journeyRequest(fixture, identities.user, '/v1/minecraft/choices')) as {
      version: string;
      capabilities: { installation: boolean; gateway: boolean; sleepWake: boolean };
    }[];
    expect(choices).toHaveLength(2);
    expect(choices.find((choice) => choice.version === '1.21.11')).toMatchObject({
      capabilities: { installation: true, gateway: false, sleepWake: false },
    });
    const again = await discover();
    expect(again.items).toEqual(result.items);
    await fixture.database.db
      .updateTable('minecraft_combinations')
      .set({ enabled: false })
      .where(
        'id',
        'in',
        rows.map((row) => row.id),
      )
      .execute();
    await owner
      .getByRole('checkbox', {
        name: 'Also enable previously disabled supported versions',
        exact: true,
      })
      .check();
    await discover();
    expect(await journeyRequest(fixture, identities.user, '/v1/minecraft/choices')).toHaveLength(2);
    expect(provider.remoteCount()).toBe(1);
    await fixture.screenshot(owner, 'vanilla-declarations-owner-desktop-en');
    const accessibility = await new AxeBuilder({ page: owner })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(
      requests.every(
        (url) =>
          url.startsWith('https://piston-meta.mojang.com/') ||
          url.startsWith('https://raw.githubusercontent.com/PrismarineJS/'),
      ),
    ).toBe(true);
  });
  it('offers a direct-only declared version through the ordinary operator and whitelist installer pages', async () => {
    const user = identities.user;
    user.on('pageerror', (error) => pageErrors.push(error.message));
    const catalogCalls: string[] = [];
    const capture = (request: import('@playwright/test').Request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/v1/games' || path === '/v1/minecraft/choices') catalogCalls.push(path);
    };
    user.on('request', capture);
    const preload = user.waitForResponse(
      (response) => new URL(response.url()).pathname === '/v1/games',
    );
    await user.goto(`${fixture.origin}/servers`);
    await preload;
    await user.locator('a[href="/servers/new"]').first().click();
    await user.getByRole('button', { name: 'Minecraft Java', exact: true }).click();
    await user.getByRole('button', { name: 'Next', exact: true }).click();
    await browserExpect(
      user.getByRole('heading', { name: 'Choose a runtime', exact: true }),
    ).toBeVisible();
    await browserExpect(user.getByRole('radio', { name: 'Paper', exact: true })).toHaveCount(0);
    await user.getByRole('radio', { name: 'Vanilla', exact: true }).check();
    await fixture.screenshot(user, 'runtime-step-desktop-en');
    expect(
      (
        await new AxeBuilder({ page: user })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await user.getByRole('button', { name: 'Next', exact: true }).click();
    await user.getByLabel('Server name', { exact: true }).fill('Direct Vanilla');
    await user.getByLabel('Server name', { exact: true }).press('Enter');
    await user.getByRole('radio', { name: '1.21.11', exact: true }).check();
    await browserExpect(user.getByRole('radio', { name: /vanilla/i })).toHaveCount(0);
    await fixture.screenshot(user, 'runtime-versions-desktop-en');
    await user.getByRole('checkbox', { name: 'Show all versions', exact: true }).check();
    await user.getByRole('checkbox', { name: 'Show all versions', exact: true }).uncheck();
    await user.getByRole('button', { name: 'Back', exact: true }).click();
    await user.getByLabel('Server name', { exact: true }).press('Enter');
    await browserExpect(user.getByRole('radio', { name: '1.21.11', exact: true })).toBeChecked();
    expect(catalogCalls.filter((path) => path === '/v1/games')).toHaveLength(1);
    expect(catalogCalls.filter((path) => path === '/v1/minecraft/choices')).toHaveLength(1);
    user.off('request', capture);
    await user.getByRole('button', { name: 'Next', exact: true }).click();
    await browserExpect(
      user.getByRole('heading', { name: 'Who should be an operator?', exact: true }),
    ).toBeVisible();
    await user.getByRole('button', { name: 'Next', exact: true }).click();
    await browserExpect(
      user.getByRole('heading', { name: 'Do you want to turn whitelist on?', exact: true }),
    ).toBeVisible();
    await user.getByRole('button', { name: 'Next', exact: true }).click();
    await browserExpect(user.getByRole('button', { name: '6+', exact: true })).toBeVisible();
    expect(provider.remoteCount()).toBe(1);
    expect(requests.filter((url) => url === minecraftManifestUrl)).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  });
  it('completes later pages beyond a snapshot-only first page and restores explicitly enabled stable choices', async () => {
    await fixture.database.db
      .updateTable('minecraft_combinations')
      .set({ enabled: false })
      .execute();
    await owner
      .getByRole('checkbox', { name: 'Include snapshots and historical versions', exact: true })
      .check();
    let releasePage: () => void = () => {};
    const heldPage = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    await owner.route('**/v1/owner/minecraft/catalog/sync', async (route) => {
      if (route.request().postDataJSON()?.cursor === 40) await heldPage;
      await route.continue();
    });
    const scan = discover(false);
    try {
      await browserExpect(
        owner.getByRole('progressbar', { name: 'Version discovery progress' }),
      ).toHaveAttribute('value', '40');
      await browserExpect(owner.getByText(/Estimated remaining time/)).toBeVisible();
      await fixture.screenshot(owner, 'catalog-scan-progress-desktop-en');
    } finally {
      releasePage();
    }
    const firstPage = await scan;
    await browserExpect(
      owner.getByRole('button', { name: 'Discover Vanilla versions', exact: true }),
    ).toBeEnabled();
    await owner.unroute('**/v1/owner/minecraft/catalog/sync');
    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.items.every((item) => item.version.startsWith('25w'))).toBe(true);
    const choices = (await journeyRequest(fixture, identities.user, '/v1/minecraft/choices')) as {
      version: string;
      releaseType: string;
    }[];
    expect(choices.filter((choice) => choice.releaseType === 'snapshot')).toHaveLength(41);
    expect(
      choices.some((choice) => choice.version === '1.21.11' && choice.releaseType === 'release'),
    ).toBe(true);
    expect(provider.remoteCount()).toBe(1);
  });
  it('keeps a large Owner catalog bounded, filters it and orders releases by official dates', async () => {
    const region = owner.getByRole('region', { name: 'Runtime combinations', exact: true });
    await browserExpect(region.getByRole('row')).toHaveCount(26);
    await browserExpect(region.getByRole('row').nth(1).getByRole('cell').first()).toHaveText(
      '25w41a',
    );
    const height = await region.evaluate((element) => element.getBoundingClientRect().height);
    expect(height).toBeLessThanOrEqual(420);
    expect(await region.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    await region.focus();
    await owner.keyboard.press('End');
    await owner.getByRole('button', { name: 'Next', exact: true }).click();
    expect(await region.evaluate((element) => element.scrollTop)).toBe(0);
    await owner.getByLabel('Version type', { exact: true }).selectOption('release');
    await browserExpect(region.getByRole('row')).toHaveCount(4);
    await owner.getByLabel('Availability', { exact: true }).selectOption('enabled');
    await browserExpect(region.getByRole('row')).toHaveCount(3);
    await owner.getByLabel('Search versions', { exact: true }).fill('1.21');
    await browserExpect(region.getByRole('row')).toHaveCount(2);
    await owner.getByLabel('Search versions', { exact: true }).fill('');
    await owner.getByLabel('Version type', { exact: true }).selectOption('');
    await owner.getByLabel('Sort by', { exact: true }).selectOption('oldest');
    await browserExpect(region.getByRole('row').nth(1).getByRole('cell').first()).toHaveText(
      '25w01a',
    );
    await owner.getByLabel('Sort by', { exact: true }).selectOption('newest');
    await fixture.screenshot(owner, 'catalog-browser-desktop-en');
    expect(
      (
        await new AxeBuilder({ page: owner })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    const log = owner.getByRole('log', { name: 'Checked versions', exact: true });
    expect(await log.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(
      await log.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(290);
    await journeyRequest(fixture, owner, '/api/auth/update-user', {
      name: 'Morgan Owner',
      locale: 'it',
    });
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.goto(`${fixture.origin}/owner/integrations/minecraft-java`);
    await owner.getByLabel('Cerca versioni', { exact: true }).fill('25w');
    await owner
      .getByRole('checkbox', { name: 'Includi snapshot e versioni storiche', exact: true })
      .check();
    await owner.getByRole('button', { name: 'Scopri versioni Vanilla', exact: true }).click();
    await browserExpect(
      owner.getByRole('button', { name: 'Scopri versioni Vanilla', exact: true }),
    ).toBeEnabled();
    await fixture.screenshot(owner, 'catalog-browser-mobile-it');
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
    // Return to EN for subsequent shared fixture cases.
    await journeyRequest(fixture, owner, '/api/auth/update-user', {
      name: 'Morgan Owner',
      locale: 'en',
    });
    await owner.setViewportSize({ width: 1440, height: 1000 });
    await owner.goto(`${fixture.origin}/owner/integrations/minecraft-java`);
  });
  it('renders runtime and release-only labels on Italian mobile with no overflow', async () => {
    const user = identities.user;
    await journeyRequest(fixture, user, '/api/auth/update-user', {
      name: 'Italian reviewer',
      locale: 'it',
    });
    await user.setViewportSize({ width: 390, height: 844 });
    await user.goto(`${fixture.origin}/servers/new`);
    await user.getByRole('button', { name: 'Minecraft Java', exact: true }).click();
    await user.getByRole('button', { name: 'Avanti', exact: true }).click();
    await browserExpect(
      user.getByRole('heading', { name: 'Scegli un runtime', exact: true }),
    ).toBeVisible();
    await user.getByRole('radio', { name: 'Vanilla', exact: true }).check();
    await fixture.screenshot(user, 'runtime-step-mobile-it');
    await user.getByRole('button', { name: 'Avanti', exact: true }).click();
    await user.getByLabel('Nome del server', { exact: true }).fill('Mondo Vanilla');
    await user.getByLabel('Nome del server', { exact: true }).press('Enter');
    await user.getByRole('radio', { name: '1.21.11', exact: true }).check();
    await browserExpect(user.getByRole('radio', { name: '25w01a', exact: true })).toHaveCount(0);
    await user.getByLabel('Mostra tutte le versioni', { exact: true }).check();
    const allNames = await user.locator('.installer-version').allTextContents();
    expect(allNames[0]?.trim()).toBe('25w41a');
    expect(allNames.findIndex((name) => name.trim() === '1.21.11')).toBeLessThan(
      allNames.findIndex((name) => name.trim() === '25w01a'),
    );
    await browserExpect(user.getByRole('radio', { name: '25w01a', exact: true })).toBeVisible();
    await user.getByLabel('Mostra tutte le versioni', { exact: true }).uncheck();
    await fixture.screenshot(user, 'runtime-versions-mobile-it');
    expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (
        await new AxeBuilder({ page: user })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    // Back through Name to Runtime retains the selected runtime and choice.
    await user.getByRole('button', { name: 'Indietro', exact: true }).click();
    await user.getByRole('button', { name: 'Indietro', exact: true }).click();
    await browserExpect(user.getByRole('radio', { name: 'Vanilla', exact: true })).toBeChecked();
    expect(pageErrors).toEqual([]);
  });
  it('shows a recognized-contract error without mutating provider resources or prior registrations', async () => {
    const egg = await provider.adapter.getEgg(1, 1);
    const variable = egg.relationships?.variables?.data[0]?.attributes;
    if (!variable) throw new Error('Missing isolated egg variable');
    variable.env_variable = 'UNRECOGNIZED_VERSION';
    const result = await discover();
    expect(
      result.items.filter((item) => item.reason === 'minecraft_egg_contract_unsupported'),
    ).toHaveLength(2);
    await browserExpect(
      owner.getByText('The egg does not expose a recognized Vanilla version and JAR contract.', {
        exact: false,
      }),
    ).toHaveCount(2);
    expect(await journeyRequest(fixture, identities.user, '/v1/minecraft/choices')).toHaveLength(
      43,
    );
    expect(provider.remoteCount()).toBe(1);
  });
});
