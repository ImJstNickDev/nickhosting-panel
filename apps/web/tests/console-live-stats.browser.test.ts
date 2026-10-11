import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type {
  ConsoleEvent,
  ConsoleRelayOptions,
  Resources,
} from '@nickhosting/pterodactyl-adapter';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('Console live resource stream', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  const streams = new Set<ConsoleRelayOptions>();
  let resourceRequests = 0;
  const snapshot: Resources = {
    current_state: 'running',
    is_suspended: false,
    resources: {
      memory_bytes: 64 * 1024 ** 2,
      cpu_absolute: 4,
      disk_bytes: 1024 ** 3,
      network_rx_bytes: 1024,
      network_tx_bytes: 2048,
      uptime: 3661000,
    },
  };
  beforeAll(async () => {
    fixture = await browserHarness();
    const identities = await prepareJourneyIdentities(fixture);
    user = identities.user;
    await user.setViewportSize({ width: 1440, height: 1000 });
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
    provider.adapter.getResources = async () => snapshot;
    const original = provider.adapter.relayConsole;
    provider.adapter.relayConsole = async (id, input) => {
      streams.add(input);
      input.signal?.addEventListener('abort', () => streams.delete(input), { once: true });
      return original(id, {
        ...input,
        // Controlled status/stats only: provider fixtures otherwise describe an offline server.
        onEvent: (event) => {
          if (event.type !== 'status' && event.type !== 'stats') input.onEvent(event);
        },
      });
    };
    user.on('request', (request) => {
      if (request.url().endsWith(`/v1/servers/${provider.ids.serverId}/resources`))
        resourceRequests++;
    });
    await user.goto(`${fixture.origin}/servers/${provider.ids.serverId}/console`);
    await browserExpect(user.locator('.console')).toContainText(
      'Browser provider fixture attached',
    );
    await browserExpect(card('Disk')).toHaveText('1 GiB');
  });
  afterAll(async () => {
    provider?.dispose();
    streams.clear();
    await fixture?.close();
  });
  function card(label: string) {
    return user
      .locator('.console-summary-card')
      .filter({ has: user.getByText(label, { exact: true }) })
      .locator('dd');
  }
  function emit(event: ConsoleEvent) {
    for (const stream of streams) stream.onEvent(event);
  }
  function stats(cpu: number, uptime = 3661000) {
    emit({
      type: 'stats',
      data: {
        cpu_absolute: cpu,
        memory_bytes: cpu * 1024 ** 2,
        disk_bytes: 999 * 1024 ** 3,
        uptime,
        network: { rx_bytes: cpu * 2 * 1024 ** 2, tx_bytes: cpu * 3 * 1024 ** 2 },
      },
    });
  }
  it('updates stream metrics without per-second REST and ticks uptime using already-cached streamed disk', async () => {
    emit({ type: 'status', data: 'running' });
    stats(20);
    await browserExpect(card('CPU Load')).toHaveText('20%');
    await browserExpect(card('Memory')).toHaveText('20 MiB');
    await browserExpect(card('Network (Inbound)')).toHaveText('40 MiB');
    await browserExpect(card('Network (Outbound)')).toHaveText('60 MiB');
    await browserExpect(card('Disk')).toHaveText('999 GiB');
    const requests = resourceRequests;
    const uptime = await card('Uptime').innerText();
    expect(uptime).toContain('sec');
    await browserExpect(card('Uptime')).not.toHaveText(uptime, { timeout: 2500 });
    stats(21, 3662000);
    await browserExpect(card('CPU Load')).toHaveText('21%');
    await browserExpect(card('Memory')).toHaveText('21 MiB');
    await browserExpect(card('Network (Inbound)')).toHaveText('42 MiB');
    await browserExpect(card('Disk')).toHaveText('999 GiB');
    expect(resourceRequests).toBe(requests);
    const chart = user.locator('.metric-chart').first();
    await browserExpect(chart.locator('polyline').first()).toBeVisible();
    await browserExpect(chart.locator('text[y="130"]')).toHaveCount(0);
    expect(await chart.locator('polyline').first().getAttribute('points')).not.toContain('NaN');
    const points = () =>
      chart
        .locator('polyline')
        .evaluateAll((lines) => lines.map((line) => line.getAttribute('points')));
    const beforeTick = await points();
    const beforeUptime = await card('Uptime').innerText();
    await browserExpect(card('Uptime')).not.toHaveText(beforeUptime, { timeout: 2500 });
    expect(await points()).toEqual(beforeTick);
    stats(19, 3663000);
    await browserExpect(card('CPU Load')).toHaveText('19%');
    const updatedPoints = await points();
    expect(updatedPoints).not.toEqual(beforeTick);
    expect(Number(updatedPoints.at(-1)?.split(' ').at(-1)?.split(',')[0])).toBe(388);
    await user.screenshot({
      path: resolve('docs/screenshots/m5/console-live-stats-desktop-en.png'),
      fullPage: true,
    });
  });
  it('does not fabricate missing stream fields and resets uptime after a new process', async () => {
    emit({ type: 'stats', data: { cpu_absolute: 22, memory_bytes: 1024, disk_bytes: 0 } });
    await browserExpect(card('CPU Load')).toHaveText('22%');
    await browserExpect(card('Uptime')).toHaveText('Unavailable');
    await browserExpect(card('Network (Inbound)')).toHaveText('Unavailable');
    await browserExpect(card('Network (Outbound)')).toHaveText('Unavailable');
    emit({ type: 'status', data: 'offline' });
    await browserExpect(card('Uptime')).toHaveText('Offline');
    for (const label of ['CPU Load', 'Memory', 'Network (Inbound)', 'Network (Outbound)'])
      await browserExpect(card(label)).toHaveText('Offline');
    await browserExpect(card('Disk')).toHaveText('0 B');
    for (const chart of await user.locator('.metric-chart').all()) {
      await browserExpect(chart.locator('[data-offline="true"]')).toHaveAttribute(
        'points',
        '12,108 388,108',
      );
      await browserExpect(chart.locator('polyline:not([data-offline])')).toHaveCount(0);
    }
    await user.screenshot({
      path: resolve('docs/screenshots/m5/console-live-stats-offline-en.png'),
      fullPage: true,
    });
    expect(
      (
        await new AxeBuilder({ page: user })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await user.setViewportSize({ width: 390, height: 844 });
    await user.screenshot({
      path: resolve('docs/screenshots/m5/console-live-stats-offline-mobile-en.png'),
      fullPage: true,
    });
    expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await user.setViewportSize({ width: 1440, height: 1000 });
    await user.clock.install();
    const refresh = user.waitForResponse((response) => response.url().endsWith('/resources'));
    await user.clock.fastForward(10001);
    await refresh;
    await browserExpect(card('Uptime')).toHaveText('Offline');
    await user.clock.resume();
    emit({ type: 'status', data: 'starting' });
    await browserExpect(card('Uptime')).toHaveText('Starting…');
    emit({ type: 'status', data: 'running' });
    await browserExpect(card('Uptime')).toHaveText('Unavailable');
    stats(1, 1000);
    await browserExpect(card('Uptime')).toHaveText(/^[1-3] secs?$/);
    await browserExpect(card('CPU Load')).toHaveText('1%');
  });
  it('expires silent statistics despite heartbeats and keeps fallback errors visible', async () => {
    const path = '**/v1/servers/*/resources';
    await user.route(path, (route) =>
      route.fulfill({
        status: 403,
        json: { error: { code: 'forbidden', messageKey: 'errors.forbidden' } },
      }),
    );
    try {
      await user.clock.fastForward(31001);
      await browserExpect(card('CPU Load')).toHaveText('Unavailable');
      await browserExpect(card('Uptime')).toHaveText('Unavailable');
      const refresh = user.waitForResponse((response) => response.url().endsWith('/resources'));
      await user.clock.fastForward(10001);
      await refresh;
      await browserExpect(user.getByRole('alert')).toContainText('You do not have permission');
      await browserExpect(card('Uptime')).toHaveText('Unavailable');
    } finally {
      await user.unroute(path);
      await user.clock.resume();
    }
  });
});
