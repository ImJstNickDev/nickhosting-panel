import { createHash } from 'node:crypto';
import { AxeBuilder } from '@axe-core/playwright';
import { minecraftManifestUrl } from '@nickhosting/minecraft';
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
    // It must not mask whether new discovery incorrectly grants public availability.
    await fixture.database.db
      .updateTable('minecraft_combinations')
      .set({ enabled: false })
      .execute();
    const egg = await provider.adapter.getEgg(1, 1);
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
    const versions = ['26.3', '26.2', '26.1'].map((id) => {
      const url = `https://piston-meta.mojang.com/v1/packages/fixture/${id}.json`;
      const bytes = Buffer.from(
        JSON.stringify({
          id,
          javaVersion: { majorVersion: 25 },
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
      return { id, type: 'release', url, sha1: createHash('sha1').update(bytes).digest('hex') };
    });
    documents.set(minecraftManifestUrl, Buffer.from(JSON.stringify({ versions })));
    const protocols = Buffer.from(
      JSON.stringify(
        ['26.1', '26.2'].map((minecraftVersion) => ({
          minecraftVersion,
          version: 775,
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
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    provider?.dispose();
    await fixture?.close();
  });
  async function discover() {
    const response = owner.waitForResponse(
      (item) =>
        item.request().method() === 'POST' &&
        item.url().endsWith('/v1/owner/minecraft/catalog/sync'),
    );
    await owner.getByRole('button', { name: 'Discover Vanilla versions', exact: true }).click();
    const result = await response;
    expect(result.status()).toBe(200);
    return result.json() as Promise<{
      items: { id?: string; status: string; version: string; reason?: string }[];
    }>;
  }
  it('discovers multiple versions without manual fields and keeps unsigned candidates unavailable', async () => {
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
    await browserExpect(
      owner.getByText(
        'Discovery does not certify compatibility. Registered versions still need valid test evidence and availability.',
        { exact: true },
      ),
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
    expect(rows.every((row) => row.enabled === false)).toBe(true);
    await browserExpect(owner.getByRole('cell', { name: 'Unverified', exact: true })).toHaveCount(
      2,
    );
    expect(await journeyRequest(fixture, identities.user, '/v1/minecraft/choices')).toEqual([]);
    const again = await discover();
    expect(again.items).toEqual(result.items);
    expect(provider.remoteCount()).toBe(1);
    await fixture.screenshot(owner, 'vanilla-catalog-owner-desktop-en');
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
  it('shows a recognized-contract error without changing provider resources or public eligibility', async () => {
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
    expect(await journeyRequest(fixture, identities.user, '/v1/minecraft/choices')).toEqual([]);
    expect(provider.remoteCount()).toBe(1);
  });
});
