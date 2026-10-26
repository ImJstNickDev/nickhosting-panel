import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { PterodactylError, type Resources } from '@nickhosting/pterodactyl-adapter';
import { expect as browserExpect, type Page, type Route } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connections } from '../src/features/service-contracts.js';
import { confirmConsoleFixtureAddress } from './console-fixture.js';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 Console sidebar resources and responsive controls', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let user: Page;
  let base: string;
  let fixtureState: Resources['current_state'] = 'offline';
  let originalResources: typeof provider.adapter.getResources;
  const errors: string[] = [];
  const running: Resources = {
    current_state: 'running',
    is_suspended: false,
    resources: {
      cpu_absolute: 12.5,
      memory_bytes: 128 * 1024 ** 2,
      disk_bytes: 1024 ** 3,
      network_rx_bytes: 2 * 1024 ** 2,
      network_tx_bytes: 3 * 1024 ** 2,
      uptime: 3661000,
    },
  };

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
    await confirmConsoleFixtureAddress(fixture.database.db, provider.ids.serverId);
    fixture.setManagement(provider.management);
    originalResources = provider.adapter.getResources;
    const originalRelay = provider.adapter.relayConsole;
    provider.adapter.relayConsole = (id, input) =>
      originalRelay(id, {
        ...input,
        onEvent: (event) =>
          input.onEvent(event.type === 'status' ? { ...event, data: fixtureState } : event),
      });
    base = `${fixture.origin}/servers/${provider.ids.serverId}/console`;
  });

  afterAll(async () => {
    if (provider) provider.adapter.getResources = originalResources;
    provider?.dispose();
    await fixture?.close();
  });

  function card(label: string) {
    return user.locator('.console-summary-card').filter({
      has: user.getByText(label, { exact: true }),
    });
  }

  async function terminalConnection() {
    const indicator = user.locator('.console-terminal .console-connection');
    await browserExpect(indicator).toHaveCount(1);
    const terminal = await user.locator('.console-terminal').boundingBox();
    const connection = await indicator.boundingBox();
    if (!terminal || !connection) throw new Error('Console connection control is not visible');
    expect(connection.y).toBeGreaterThanOrEqual(terminal.y);
    expect(connection.y - terminal.y).toBeLessThanOrEqual(16);
    expect(connection.x + connection.width).toBeLessThanOrEqual(terminal.x + terminal.width);
    expect(terminal.x + terminal.width - connection.x - connection.width).toBeLessThanOrEqual(16);
  }

  async function screenshot(name: string) {
    await user.screenshot({
      path: resolve('docs/screenshots/m5', `console-sidebar-${name}.png`),
      fullPage: true,
    });
    const result = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
      })),
    ).toEqual([]);
    expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  }

  it('aligns eight cards with the terminal and shows power controls above them at desktop size', async () => {
    await user.setViewportSize({ width: 1440, height: 1000 });
    await user.goto(base);
    await browserExpect(user.locator('.console-summary-card')).toHaveCount(8);
    await browserExpect(user.locator('.console-summary-card dt')).toHaveText([
      'Runtime',
      'Address',
      'Uptime',
      'CPU Load',
      'Memory',
      'Disk',
      'Network (Inbound)',
      'Network (Outbound)',
    ]);
    const runtimeCard = user.locator('.console-summary-card').first();
    await browserExpect(runtimeCard.locator('dd')).toHaveText('Vanilla 26.1');
    // The semantic term remains available to screen readers, not visible in the card.
    await browserExpect(runtimeCard.locator('dt')).toHaveClass('visually-hidden');
    await browserExpect(runtimeCard.locator('svg')).toHaveCount(0);
    await browserExpect(card('Uptime').locator('dd')).toHaveText('Offline');
    await browserExpect(card('Uptime').locator('.console-summary-icon.is-offline')).toHaveCount(1);
    await browserExpect(user.locator('.console-summary-icon.is-offline')).toHaveCount(1);
    const connections = await journeyRequest<Connections>(
      fixture,
      user,
      `/v1/platform/servers/${provider.ids.serverId}/connections`,
    );
    const primary = connections.ports.find((port) => port.primary);
    expect(primary?.hostname).toBeTruthy();
    await browserExpect(card('Address').locator('dd')).toContainText(
      `${primary?.hostname}:${primary?.port}`,
    );
    await browserExpect(user.locator('.console-actions button')).toHaveText([
      'Start',
      'Restart',
      'Stop',
    ]);
    const terminal = await user.locator('.console-terminal').boundingBox();
    const first = await user.locator('.console-summary-card').first().boundingBox();
    const controls = await user.locator('.console-actions').boundingBox();
    const last = await user.locator('.console-summary-card').last().boundingBox();
    const name = user.getByRole('heading', { name: 'Survival', exact: true });
    await browserExpect(name).toHaveCount(1);
    await browserExpect(
      user.locator('.console-heading').getByRole('heading', { name: 'Survival', exact: true }),
    ).toBeVisible();
    const heading = await name.boundingBox();
    if (!terminal || !first || !last || !controls || !heading)
      throw new Error('Console layout is not visible');
    expect(Math.abs(first.y - terminal.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(last.y + last.height - terminal.y - terminal.height)).toBeLessThanOrEqual(1);
    expect(first.x).toBeGreaterThanOrEqual(terminal.x + terminal.width);
    expect(controls.y + controls.height).toBeLessThanOrEqual(first.y);
    expect(Math.abs(heading.x - terminal.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(heading.y + heading.height / 2 - controls.y - controls.height / 2),
    ).toBeLessThanOrEqual(1);
    await terminalConnection();
    await screenshot('offline-desktop-en');
    // Connection metadata, not a conventional role name or an auxiliary port,
    // determines the displayed game endpoint. The authenticated API remains real.
    if (!primary) throw new Error('Fixture primary endpoint is missing');
    const variant: Connections = {
      ...connections,
      ports: [
        {
          ...primary,
          role: 'game',
          primary: false,
          hostname: 'auxiliary.example.test',
          displayAddress: 'auxiliary.example.test:25576',
          port: 25576,
        },
        {
          ...primary,
          role: 'query',
          primary: true,
          hostname: 'primary.example.test',
          port: 25575,
          displayAddress: 'primary.example.test:25575',
        },
      ],
    };
    const path = `**/v1/platform/servers/${provider.ids.serverId}/connections`;
    await user.route(path, (route) => route.fulfill({ json: variant }));
    try {
      await user.reload();
      await browserExpect(card('Address').locator('dd')).toHaveText('primary.example.test:25575');
      variant.ports[1] = {
        ...primary,
        role: 'query',
        primary: true,
        hostname: null,
        displayAddress: null,
        port: null,
        status: 'unconfigured',
      };
      await user.reload();
      await browserExpect(card('Address').locator('dd')).toHaveText('Address unavailable');
      await browserExpect(card('Address')).not.toContainText('auxiliary.example.test');
    } finally {
      await user.unroute(path);
    }
  });

  it('renders provider milliseconds, CPU and binary bytes using one shared resource request', async () => {
    fixtureState = 'running';
    provider.adapter.getResources = async () => running;
    let requests = 0;
    const count = (request: { url(): string }) => {
      if (request.url().endsWith(`/v1/servers/${provider.ids.serverId}/resources`)) requests += 1;
    };
    user.on('request', count);
    try {
      await user.reload();
      await browserExpect(card('CPU Load').locator('dd')).toHaveText('12.5%');
      await browserExpect(card('Memory').locator('dd')).toHaveText('128 MiB');
      await browserExpect(card('Disk').locator('dd')).toHaveText('1 GiB');
      await browserExpect(card('Network (Inbound)').locator('dd')).toHaveText('2 MiB');
      await browserExpect(card('Network (Outbound)').locator('dd')).toHaveText('3 MiB');
      await browserExpect(card('Uptime').locator('dd')).toHaveText(/^1 hr 1 min [0-9]+ secs?$/);
      await browserExpect(user.locator('.console-summary-icon.is-offline')).toHaveCount(0);
      await browserExpect(user.locator('.resource-charts')).toBeVisible();
      expect(requests).toBe(1);
    } finally {
      user.off('request', count);
    }
    await screenshot('running-desktop-en');
  });

  it('replaces cached measurements with unavailable values when provider refresh fails', async () => {
    provider.adapter.getResources = async () => {
      throw new PterodactylError('unavailable', 'client', 'rejected');
    };
    await browserExpect(card('CPU Load').locator('dd')).toHaveText('Unavailable', {
      timeout: 20000,
    });
    for (const label of ['Uptime', 'Memory', 'Disk', 'Network (Inbound)', 'Network (Outbound)']) {
      await browserExpect(card(label).locator('dd')).toHaveText('Unavailable');
    }
    await browserExpect(user.locator('.console-summary')).not.toContainText('Offline');
    await browserExpect(user.locator('.console-summary-icon.is-offline')).toHaveCount(0);
    try {
      await screenshot('unavailable-desktop-en');
    } finally {
      provider.adapter.getResources = async () => running;
    }
    await user.reload();
    await browserExpect(card('CPU Load').locator('dd')).toHaveText('12.5%');
    await user.clock.install();
    const resourcesPath = `**/v1/servers/${provider.ids.serverId}/resources`;
    let pending: Route | undefined;
    await user.route(resourcesPath, (route) => {
      pending = route;
    });
    try {
      const refresh = user.waitForRequest((request) =>
        request.url().endsWith(`/v1/servers/${provider.ids.serverId}/resources`),
      );
      await user.clock.fastForward(10001);
      await refresh;
      await user.clock.fastForward(21000);
      await browserExpect(card('CPU Load').locator('dd')).toHaveText('Unavailable');
      await browserExpect(card('Uptime').locator('dd')).toHaveText('Unavailable');
      await browserExpect(user.locator('.console-summary-icon.is-offline')).toHaveCount(0);
    } finally {
      await pending?.fulfill({ json: running });
      await user.unroute(resourcesPath);
      await user.clock.resume();
    }
  });

  it('keeps Italian mobile controls before the terminal and viewer cards without power controls', async () => {
    await journeyRequest(fixture, user, '/api/auth/update-user', { locale: 'it' });
    await user.setViewportSize({ width: 390, height: 844 });
    await user.goto(base);
    await browserExpect(user.locator('.console-summary-card')).toHaveCount(8);
    await browserExpect(user.locator('.console-actions button')).toHaveText([
      'Avvia',
      'Riavvia',
      'Arresta',
    ]);
    const terminal = await user.locator('.console-terminal').boundingBox();
    const first = await user.locator('.console-summary-card').first().boundingBox();
    const controls = await user.locator('.console-actions').boundingBox();
    if (!terminal || !first || !controls) throw new Error('Console layout is not visible');
    expect(controls.y + controls.height).toBeLessThanOrEqual(terminal.y);
    expect(first.y).toBeGreaterThanOrEqual(terminal.y + terminal.height);
    await browserExpect(user.getByRole('heading', { name: 'Survival', exact: true })).toHaveCount(
      1,
    );
    await terminalConnection();
    await screenshot('running-mobile-it');
    const project = await journeyRequest<{ id: string }>(fixture, user, '/v1/projects', {
      name: 'Sidebar viewers',
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
    await identities.peer.goto(base);
    await browserExpect(identities.peer.locator('.console-summary-card')).toHaveCount(8);
    for (const name of ['Start', 'Restart', 'Stop']) {
      await browserExpect(identities.peer.getByRole('button', { name, exact: true })).toHaveCount(
        0,
      );
    }
    expect(errors).toEqual([]);
  });
});
