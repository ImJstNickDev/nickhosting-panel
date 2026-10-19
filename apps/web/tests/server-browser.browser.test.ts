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
    await user.getByLabel('Game', { exact: true }).selectOption('minecraft');
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

  it('aligns resource columns across short and long disk values at zoom-equivalent widths', async () => {
    const rows = await fixture.database.db
      .selectFrom('managed_servers')
      .select(['id', 'name'])
      .where('owner_id', '=', identities.userId)
      .where('name', 'in', ['World 30', 'World 31'])
      .execute();
    const small = rows.find((row) => row.name === 'World 31');
    if (!small) throw new Error('Missing small-storage fixture');
    const pattern = '**/v1/servers/*/resources';
    await user.route(pattern, async (route) => {
      await route.fulfill({
        json: {
          current_state: 'offline',
          resources: {
            disk_bytes: route.request().url().includes(small.id) ? 164 : 12.34 * 1024 ** 3,
            cpu_absolute: 0,
            memory_bytes: 0,
            network_rx_bytes: 0,
            network_tx_bytes: 0,
            uptime: 0,
          },
        },
      });
    });
    try {
      await user.goto(`${fixture.origin}/servers`);
      await user.getByRole('searchbox', { name: 'Search servers' }).fill('World 3');
      await user.getByRole('button', { name: 'List', exact: true }).click();
      await browserExpect(cards(user)).toHaveCount(2);
      await browserExpect(user.locator('.server-card-resources')).toContainText(['164', '12.3']);
      // Equivalent CSS viewport sizes for a 1440x1000 display at 100/125/150/200%.
      for (const [zoom, width, height] of [
        [100, 1440, 1000],
        [125, 1152, 800],
        [150, 960, 667],
        [200, 720, 500],
        [100, 390, 844],
      ] as const) {
        await user.setViewportSize({ width, height });
        await user.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
        await browserExpect(user.locator('.server-browser-results')).toHaveAttribute(
          'aria-busy',
          'false',
        );
        await bounded(user);
        const positions = await user
          .locator('.server-card-resources')
          .evaluateAll((lists) =>
            lists.map((list) =>
              [...list.querySelectorAll('.server-card-resource')].map(
                (resource) => resource.getBoundingClientRect().left,
              ),
            ),
          );
        // At high zoom the bounded browser may paginate one row at a time.
        if (positions.length === 1) {
          const next = user.getByRole('navigation', { name: 'Pages' }).getByRole('button').last();
          await next.click();
          await browserExpect(cards(user)).toContainText('World 30');
          positions.push(
            await user
              .locator('.server-card-resources')
              .evaluate((list) =>
                [...list.querySelectorAll('.server-card-resource')].map(
                  (resource) => resource.getBoundingClientRect().left,
                ),
              ),
          );
          await user.getByRole('navigation', { name: 'Pages' }).getByRole('button').first().click();
          await browserExpect(cards(user)).toContainText('World 31');
        }
        expect(positions).toHaveLength(2);
        for (let column = 0; column < 3; column++)
          expect(
            Math.abs((positions[0]?.[column] ?? 0) - (positions[1]?.[column] ?? 0)),
          ).toBeLessThan(1);
        await user.mouse.move(0, 0);
        await browserExpect(user.getByRole('tooltip')).toHaveCount(0);
        await screenshot(
          user,
          `server-resource-columns-${width === 390 ? 'mobile' : `zoom-${zoom}`}-en`,
        );
      }
      await accessible(user);
    } finally {
      await user.unroute(pattern);
      await user.setViewportSize({ width: 1440, height: 1000 });
    }
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
    await owner.getByRole('checkbox', { name: 'Taylor', exact: true }).check();
    await browserExpect(cards(owner)).toHaveCount(1);
    await browserExpect(cards(owner)).toContainText('Taylor world');
    const ownerSearch = owner.getByRole('searchbox', { name: 'Search owners', exact: true });
    await ownerSearch.fill('Alex');
    const unionResponse = owner.waitForResponse((response) => {
      const url = new URL(response.url());
      const owners = url.searchParams.getAll('ownerIds');
      return (
        url.pathname === '/v1/platform/servers' &&
        owners.includes(identities.userId) &&
        owners.includes(identities.peerId)
      );
    });
    const alex = owner.getByRole('checkbox', { name: 'Alex', exact: true });
    await alex.focus();
    await alex.press('Space');
    await browserExpect(alex).toBeChecked();
    const union = await unionResponse;
    expect(union.status()).toBe(200);
    expect((await union.json()).total).toBe(34);
    await browserExpect(
      owner.getByRole('link', { name: 'Taylor world', exact: true }),
    ).toBeVisible();
    await browserExpect(owner.getByRole('link', { name: 'World 31', exact: true })).toBeVisible();
    await ownerSearch.fill('');
    await screenshot(owner, 'server-browser-owner-scope-desktop-en');
    await accessible(owner);
    await owner.setViewportSize({ width: 390, height: 844 });
    const panel = owner.getByRole('region', { name: 'Server filters', exact: true });
    await browserExpect(panel).toBeVisible();
    expect(
      await panel.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
      }),
    ).toBe(true);
    await screenshot(owner, 'server-browser-owner-multiselect-mobile-en');
    await accessible(owner);
    await owner.setViewportSize({ width: 1440, height: 1000 });
    await ownerSearch.fill('No matching person');
    await browserExpect(owner.getByRole('checkbox')).toHaveCount(0);
    await browserExpect(
      owner.getByRole('button', { name: 'Remove Alex', exact: true }),
    ).toBeVisible();
    await browserExpect(
      owner.getByRole('button', { name: 'Remove Taylor', exact: true }),
    ).toBeVisible();
    await owner.getByRole('button', { name: 'Remove Alex', exact: true }).click();
    await browserExpect(cards(owner)).toHaveCount(1);
    await browserExpect(cards(owner)).toContainText('Taylor world');
    await owner.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await browserExpect(owner.getByRole('button', { name: /^Remove (Alex|Taylor)$/ })).toHaveCount(
      0,
    );
    await browserExpect.poll(() => cards(owner).count()).toBeGreaterThan(1);
    await ownerSearch.fill('Taylor');
    await owner.getByRole('checkbox', { name: 'Taylor', exact: true }).check();
    await browserExpect(cards(owner)).toHaveCount(1);
    await owner.getByRole('button', { name: 'Server filters', exact: true }).click();
    await owner.setViewportSize({ width: 844, height: 390 });
    await bounded(owner);
    await screenshot(owner, 'server-browser-owner-scope-landscape-en');
    await owner.setViewportSize({ width: 1440, height: 1000 });
    await scope.click();
    await browserExpect(cards(owner)).toHaveCount(1);
    await browserExpect(cards(owner)).toContainText('Owner workshop');
    await browserExpect(
      owner.getByRole('searchbox', { name: 'Search owners', exact: true }),
    ).toHaveCount(0);
    await scope.click();
    await owner.getByRole('button', { name: 'Server filters', exact: true }).click();
    await browserExpect(
      owner.getByRole('checkbox', { name: 'Alex', exact: true }),
    ).not.toBeChecked();
    await browserExpect(
      owner.getByRole('checkbox', { name: 'Taylor', exact: true }),
    ).not.toBeChecked();
    await browserExpect(owner.getByRole('button', { name: /^Remove (Alex|Taylor)$/ })).toHaveCount(
      0,
    );
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

  it('uses inset status strips only in list view with accessible status and hover feedback', async () => {
    const db = fixture.database.db;
    const originals = await db
      .selectFrom('managed_servers')
      .selectAll()
      .where('owner_id', '=', identities.userId)
      .where('name', 'in', ['World 00', 'World 01', 'World 02', 'World 03', 'World 04', 'World 05'])
      .orderBy('name')
      .execute();
    const oldEnv = {
      NH_GATEWAY_ENABLED: fixture.env.NH_GATEWAY_ENABLED,
      NH_GATEWAY_ID: fixture.env.NH_GATEWAY_ID,
      NH_GATEWAY_PHYSICAL_HOST_ID: fixture.env.NH_GATEWAY_PHYSICAL_HOST_ID,
    };
    Object.assign(fixture.env, {
      NH_GATEWAY_ENABLED: 'true',
      NH_GATEWAY_ID: randomUUID(),
      NH_GATEWAY_PHYSICAL_HOST_ID: provider.ids.hostId,
    });
    const statuses = ['offline', 'offline', 'starting', 'stopping', 'running', 'unknown'] as const;
    try {
      for (const [index, server] of originals.entries()) {
        await db
          .updateTable('managed_servers')
          .set({
            name: `Signal ${index}`,
            runtime_state: statuses[index],
            intent: index === 1 ? 'sleeping' : 'manually_stopped',
            connection_mode: 'gateway',
          })
          .where('id', '=', server.id)
          .execute();
      }
      const wakeServer = originals[1];
      if (!wakeServer) throw new Error('Missing isolated wake-enabled server');
      await db
        .insertInto('gateway_server_states')
        .values({
          server_id: wakeServer.id,
          generation: randomUUID(),
          enabled: true,
          protocol_id: 'minecraft-java',
          game_version: '26.1',
          state: 'sleeping',
          idle_timeout_seconds: null,
          readiness_timeout_seconds: 60,
          readiness_max_age_seconds: 30,
          estimate_max_age_seconds: 3600,
          wake_retry_seconds: 10,
          wake_job_id: null,
          sleep_job_id: null,
          process_started_at: null,
          readiness_observed_at: null,
          startup_deadline_at: null,
          idle_since: null,
          last_observed_at: null,
          last_activity_at: null,
          blocked_until: null,
          error_code: null,
        })
        .execute();
      await user.setViewportSize({ width: 1440, height: 1000 });
      await user.goto(`${fixture.origin}/servers`);
      await user.getByRole('searchbox', { name: 'Search servers' }).fill('Signal');
      await user.getByRole('button', { name: 'List', exact: true }).click();
      await browserExpect(cards(user)).toHaveCount(6);
      await browserExpect(user.locator('.server-list .badge:visible')).toHaveCount(0);
      const colors: string[] = [];
      for (const [index, status] of statuses.entries()) {
        const link = user.getByRole('link', { name: `Signal ${index}`, exact: true });
        const expectedStatus =
          index === 0
            ? 'Offline · gateway wake disabled'
            : index === 1
              ? 'Offline · gateway wake enabled'
              : status === 'running'
                ? 'Online'
                : status.charAt(0).toUpperCase() + status.slice(1);
        await browserExpect(link).toHaveAccessibleDescription(new RegExp(expectedStatus));
        const strip = link.locator('..').locator('.server-list-state');
        await browserExpect(strip).toBeVisible();
        const geometry = await strip.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const parent = element.closest('.server-card')?.getBoundingClientRect();
          if (!parent) throw new Error('Missing status strip card');
          const style = getComputedStyle(element);
          return {
            width: rect.width,
            top: rect.top - parent.top,
            right: parent.right - rect.right,
            bottom: parent.bottom - rect.bottom,
            radius: Number.parseFloat(style.borderRadius),
            color: style.backgroundColor,
          };
        });
        expect(geometry.width).toBe(6);
        expect(geometry.top).toBeGreaterThanOrEqual(7);
        expect(geometry.bottom).toBeGreaterThanOrEqual(7);
        expect(geometry.right).toBeGreaterThanOrEqual(7);
        expect(geometry.radius).toBeGreaterThan(0);
        colors.push(geometry.color);
        await link.focus();
        await browserExpect(user.getByRole('tooltip')).toContainText(expectedStatus);
        await user.keyboard.press('Escape');
      }
      expect(colors[0]).not.toBe(colors[1]);
      expect(colors[2]).toBe(colors[3]);
      expect(new Set([colors[0], colors[2], colors[4], colors[5]]).size).toBe(4);
      await user.getByRole('searchbox', { name: 'Search servers' }).focus();
      const active = user.getByRole('link', { name: 'Signal 4', exact: true });
      const stripe = active.locator('..').locator('.server-list-state');
      await active.hover();
      await browserExpect
        .poll(() => stripe.evaluate((element) => getComputedStyle(element).boxShadow))
        .not.toBe('none');
      await browserExpect(user.getByRole('tooltip')).toContainText('Online');
      await browserExpect(stripe).toHaveCSS('transition-duration', '0s');
      await user.mouse.move(0, 0);
      await screenshot(user, 'server-browser-status-list-desktop-en');
      await accessible(user);
      await user.getByRole('button', { name: 'Grid', exact: true }).click();
      await browserExpect(user.locator('.server-grid .badge:visible')).toHaveCount(6);
      await browserExpect(user.locator('.server-list-state:visible')).toHaveCount(0);
      await user.getByRole('button', { name: 'List', exact: true }).click();
      await user.setViewportSize({ width: 390, height: 844 });
      await browserExpect.poll(() => cards(user).count()).toBeLessThan(6);
      await bounded(user);
      await screenshot(user, 'server-browser-status-list-mobile-en');
    } finally {
      await db
        .deleteFrom('gateway_server_states')
        .where(
          'server_id',
          'in',
          originals.map((server) => server.id),
        )
        .execute();
      for (const server of originals)
        await db
          .updateTable('managed_servers')
          .set({
            name: server.name,
            runtime_state: server.runtime_state,
            intent: server.intent,
            connection_mode: server.connection_mode,
          })
          .where('id', '=', server.id)
          .execute();
      Object.assign(fixture.env, oldEnv);
      await user.setViewportSize({ width: 1440, height: 1000 });
    }
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
