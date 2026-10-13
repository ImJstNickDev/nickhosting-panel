import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 server browser filters, ownership and bounded views', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page, owner: Page;
  const projectId = randomUUID();
  const pageErrors: string[] = [];

  beforeAll(async () => {
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
    ({ user, owner } = identities);
    for (const page of [user, owner])
      page.on('pageerror', (error) => pageErrors.push(error.message));
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
    const db = fixture.database.db;
    const source = await db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    const profile = await db
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', source.id)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('projects')
      .values({ id: projectId, owner_id: identities.userId, name: 'Weekend worlds' })
      .execute();
    // Database-only inventory in the harness's disposable schema. These rows never
    // create provider servers, allocate ports, or write to a real game filesystem.
    for (let index = 0; index < 34; index++) {
      const id = randomUUID();
      await db
        .insertInto('managed_servers')
        .values({
          ...source,
          id,
          name:
            index === 32
              ? 'Owner workshop'
              : index === 33
                ? 'Taylor world'
                : `World ${String(index).padStart(2, '0')}`,
          owner_id:
            index === 32
              ? identities.ownerId
              : index === 33
                ? identities.peerId
                : identities.userId,
          project_id: index < 4 ? projectId : null,
          external_id: `isolated-server-browser-${id}`,
          pterodactyl_id: null,
          pterodactyl_uuid: null,
          pterodactyl_identifier: null,
          provider_user_id: null,
          limits: JSON.stringify({ ...source.limits, memory: 32768, cpu: 1250 }),
          runtime_state: index % 2 === 0 ? 'running' : 'offline',
          active_operation_id: null,
          created_at: new Date(Date.now() + index * 1000),
        })
        .execute();
      await db
        .insertInto('minecraft_server_profiles')
        .values({
          ...profile,
          server_id: id,
          configuration: JSON.stringify(profile.configuration),
          installed_manifest: JSON.stringify(profile.installed_manifest),
          content_state: JSON.stringify(profile.content_state),
          configuration_state: JSON.stringify(profile.configuration_state),
        })
        .execute();
    }
  });
  afterAll(async () => {
    provider?.dispose();
    await fixture?.close();
  });

  function cards(page: Page) {
    return page.locator('main a[href^="/servers/"]').filter({ hasNotText: 'Create server' });
  }
  async function screenshot(page: Page, name: string) {
    // This isolated suite only photographs inventory pages with invented names;
    // the shared harness mask would unnecessarily hide the search field.
    await page.screenshot({
      path: resolve('.codex/local/m5-browser/screenshots', `${name}.png`),
      fullPage: true,
    });
  }
  async function bounded(page: Page) {
    expect(
      await page.locator('.server-card-resource dd').evaluateAll((elements) =>
        elements.every((element) => {
          const node = element as HTMLElement;
          return node.scrollWidth <= node.clientWidth + 1;
        }),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const navigation = page.getByRole('navigation', { name: 'Pages' });
    await browserExpect(navigation).toBeVisible();
    expect(
      await navigation.evaluate(
        (element) => element.getBoundingClientRect().bottom <= innerHeight + 2,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 2),
    ).toBe(true);
    await browserExpect
      .poll(() =>
        page.locator('.server-browser-results').evaluate((region) => {
          const bounds = region.getBoundingClientRect();
          return [
            ...region.querySelectorAll('.server-card, .server-card-resources, .server-card-footer'),
          ].flatMap((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width === 0 ||
              rect.height === 0 ||
              (rect.top >= bounds.top - 2 && rect.bottom <= bounds.bottom + 2)
              ? []
              : [
                  {
                    element: element.className,
                    top: rect.top,
                    bottom: rect.bottom,
                    regionTop: bounds.top,
                    regionBottom: bounds.bottom,
                  },
                ];
          });
        }),
      )
      .toEqual([]);
    expect(
      await page.locator('.server-card-body > p').evaluateAll((elements) =>
        elements.every((element) => {
          const node = element as HTMLElement;
          return node.clientHeight === 0 || node.scrollHeight <= node.clientHeight + 1;
        }),
      ),
    ).toBe(true);
  }
  async function accessible(page: Page) {
    const report = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      report.violations.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  }

  it('updates search, status and advanced filters without submitting and focuses search with Alt+K', async () => {
    await user.goto(`${fixture.origin}/servers`);
    const search = user.getByRole('searchbox', { name: 'Search servers' });
    await browserExpect(search).toBeVisible();
    await browserExpect(user.getByRole('button', { name: 'Filter', exact: true })).toHaveCount(0);
    await browserExpect(user.getByLabel('Project', { exact: true })).toHaveCount(0);
    await user.keyboard.press('Alt+k');
    await browserExpect(search).toBeFocused();
    await search.fill('World 09');
    await browserExpect(cards(user)).toHaveCount(1);
    await browserExpect(cards(user)).toContainText('World 09');
    await user.getByRole('button', { name: 'Online', exact: true }).click();
    await browserExpect(
      user.getByText('No servers match these filters.', { exact: true }),
    ).toBeVisible();
    await user.getByRole('button', { name: 'Offline', exact: true }).click();
    await browserExpect(cards(user)).toHaveCount(1);
    await user.getByRole('button', { name: 'All', exact: true }).click();
    await search.fill('');
    const filters = user.getByRole('button', { name: 'Server filters', exact: true });
    await filters.click();
    await browserExpect(filters).toHaveAttribute('aria-expanded', 'true');
    await user.getByLabel('Project', { exact: true }).selectOption(projectId);
    await browserExpect(cards(user)).toHaveCount(4);
    await browserExpect(user.getByLabel('Runtime', { exact: true })).toBeVisible();
    await browserExpect(user.getByLabel('Version', { exact: true })).toBeVisible();
    await user.getByLabel('Game', { exact: true }).selectOption('minecraft-java');
    await user.getByLabel('Runtime', { exact: true }).selectOption('vanilla');
    const release = await user
      .getByLabel('Version', { exact: true })
      .locator('option')
      .nth(1)
      .getAttribute('value');
    if (!release) throw new Error('Expected an installed release filter');
    const filtered = user.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/v1/platform/servers' && url.searchParams.get('version') === release;
    });
    await user.getByLabel('Version', { exact: true }).selectOption(release);
    expect((await filtered).status()).toBe(200);
    await browserExpect(cards(user)).toHaveCount(4);
    await browserExpect(user.getByLabel('Owner', { exact: true })).toHaveCount(0);
    await screenshot(user, 'server-browser-filters-desktop-en');
    await accessible(user);
    await filters.click();
    await browserExpect(user.getByLabel('Project', { exact: true })).toHaveCount(0);
    await browserExpect(cards(user)).toHaveCount(4);
  });

  it('paginates grid and list inside desktop and mobile viewports', async () => {
    await user.goto(`${fixture.origin}/servers`);
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
      { width: 640, height: 480 },
    ]) {
      await user.setViewportSize(viewport);
      for (const view of ['Grid', 'List']) {
        await user.getByRole('button', { name: view, exact: true }).click();
        const navigation = user.getByRole('navigation', { name: 'Pages' });
        await browserExpect(
          navigation.getByRole('button', { name: 'Next', exact: true }),
        ).toBeEnabled();
        await browserExpect(navigation).toContainText(/Page 1 of \d+/);
        await bounded(user);
        const firstPage = await cards(user).allTextContents();
        await navigation.getByRole('button', { name: 'Next', exact: true }).click();
        await browserExpect(navigation).toContainText(/Page 2 of \d+/);
        await browserExpect
          .poll(async () =>
            (await cards(user).allTextContents()).some((name) => firstPage.includes(name)),
          )
          .toBe(false);
        await bounded(user);
        await screenshot(
          user,
          `server-browser-${view.toLowerCase()}-${viewport.width === 390 ? 'mobile' : viewport.height === 390 ? 'landscape' : viewport.width === 640 ? 'narrow' : 'desktop'}-en`,
        );
        await navigation.getByRole('button', { name: 'Previous', exact: true }).click();
        await browserExpect(navigation).toContainText(/Page 1 of \d+/);
      }
    }
    await accessible(user);
    await user.setViewportSize({ width: 1440, height: 1000 });
  });

  it('switches Owner inventory and exposes an owner filter only for other users’ servers', async () => {
    await owner.goto(`${fixture.origin}/servers`);
    const scope = owner.getByRole('switch', { name: 'Others', exact: true });
    await browserExpect(scope).not.toBeChecked();
    await browserExpect(cards(owner)).toHaveCount(1);
    await browserExpect(cards(owner)).toContainText('Owner workshop');
    await scope.click();
    await browserExpect(scope).toBeChecked();
    await browserExpect(
      owner.getByRole('link', { name: 'Owner workshop', exact: true }),
    ).toHaveCount(0);
    await owner.getByRole('button', { name: 'Server filters', exact: true }).click();
    await owner.getByLabel('Owner', { exact: true }).selectOption(identities.peerId);
    await browserExpect(cards(owner)).toHaveCount(1);
    await browserExpect(cards(owner)).toContainText('Taylor world');
    await screenshot(owner, 'server-browser-owner-scope-desktop-en');
    await accessible(owner);
    await owner.getByRole('button', { name: 'Server filters', exact: true }).click();
    await owner.setViewportSize({ width: 844, height: 390 });
    await bounded(owner);
    await screenshot(owner, 'server-browser-owner-scope-landscape-en');
    await owner.setViewportSize({ width: 1440, height: 1000 });
    await scope.click();
    await browserExpect(cards(owner)).toHaveCount(1);
    await browserExpect(cards(owner)).toContainText('Owner workshop');
    await browserExpect(owner.getByLabel('Owner', { exact: true })).toHaveCount(0);
    await browserExpect(user.getByRole('switch')).toHaveCount(0);
    expect(
      (await user.request.get(`${fixture.origin}/v1/platform/servers?scope=others`)).status(),
    ).toBe(403);
  });

  it('shows unlimited available servers with an infinity symbol on Home', async () => {
    await user.goto(fixture.origin);
    const servers = user
      .locator('.home-quota-card')
      .filter({ has: user.getByRole('heading', { name: 'Servers', exact: true }) });
    await browserExpect(servers.locator('dd').last()).toHaveText('∞');
    await screenshot(user, 'home-server-infinity-desktop-en');
    expect(pageErrors).toEqual([]);
  });

  it('keeps Italian mobile controls and advanced filters accessible', async () => {
    await journeyRequest(fixture, user, '/api/auth/update-user', { locale: 'it' });
    await user.setViewportSize({ width: 390, height: 844 });
    await user.goto(`${fixture.origin}/servers`);
    await browserExpect(user.getByRole('heading', { name: 'Server', exact: true })).toBeVisible();
    await user.getByRole('button', { name: 'Filtri server', exact: true }).click();
    await browserExpect(user.getByLabel('Progetto', { exact: true })).toBeVisible();
    expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await screenshot(user, 'server-browser-filters-mobile-it');
    await accessible(user);
    expect(pageErrors).toEqual([]);
  });
});
