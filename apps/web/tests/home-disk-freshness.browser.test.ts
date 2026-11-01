import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('Home disk usage has a bounded display lifetime', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page, owner: Page;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
    ({ user, owner } = identities);
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
    for (const page of [user, owner]) {
      page.on('pageerror', (error) => pageErrors.push(error.message));
      // Keep the stored worker measurement deterministic: Home's independent
      // recent-server card must not obtain a newer on-demand provider sample.
      await page.route('**/v1/servers/*/resources', (route) => route.abort());
    }
  });
  afterAll(async () => {
    provider?.dispose();
    await fixture?.close();
  });

  async function sample(bytes: number | null, ageMs = 5000) {
    const db = fixture.database.db;
    await db.deleteFrom('server_metrics').where('server_id', '=', provider.ids.serverId).execute();
    if (bytes !== null)
      await db
        .insertInto('server_metrics')
        .values({
          server_id: provider.ids.serverId,
          observed_at: new Date(Date.now() - ageMs),
          memory_bytes: '0',
          cpu_percent: 0,
          disk_bytes: String(bytes),
          network_rx_bytes: '0',
          network_tx_bytes: '0',
        })
        .execute();
  }
  function disk() {
    return user
      .locator('.home-quota-card')
      .filter({ has: user.getByRole('heading', { name: 'Storage', exact: true }) });
  }

  it('shows five-second-old disk usage across reloads without an extra timestamp or indicator', async () => {
    await sample(4 * 1024 ** 2);
    await user.goto(fixture.origin);
    await browserExpect(disk().locator('dd').first()).toHaveText('4 MiB');
    await user.reload();
    await browserExpect(disk().locator('dd').first()).toHaveText('4 MiB');
    await browserExpect(disk().getByRole('button')).toHaveCount(0);
    await browserExpect(disk()).not.toContainText(/measurement|observed|updated|last/i);
    await user.locator('.home-quota-grid').screenshot({
      path: resolve('.codex/local/m5-browser/screenshots/home-disk-polling-gap-desktop-en.png'),
    });
  });

  it('expires cached usage while refresh is stalled and recovers when a new sample arrives', async () => {
    await sample(4 * 1024 ** 2);
    await user.clock.install({ time: new Date(Date.now() + 30 * 60 * 1000) });
    await user.goto(fixture.origin);
    await browserExpect(disk().locator('dd').first()).toHaveText('4 MiB');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const path = '**/v1/platform/quotas';
    let intercepted = 0;
    await user.route(path, async (route) => {
      intercepted++;
      await gate;
      await route.continue();
    });
    try {
      await user.clock.fastForward(31000);
      await browserExpect.poll(() => intercepted).toBeGreaterThan(0);
      await browserExpect(disk().locator('dd').first()).toHaveText('Unavailable');
      await browserExpect(disk().getByRole('button')).toHaveCount(0);
      await sample(8 * 1024 ** 2, 0);
      await user.clock.setSystemTime(new Date());
      release?.();
      await browserExpect(disk().locator('dd').first()).toHaveText('8 MiB');
    } finally {
      release?.();
      await user.unroute(path);
      await user.clock.setSystemTime(new Date());
      await user.clock.resume();
    }
  });

  it('shows unavailable for missing, expired and invalid future samples on a new load', async () => {
    for (const [bytes, ageMs] of [
      [null, 0],
      [4194304, 31000],
      [4194304, -60000],
    ] as const) {
      await sample(bytes, ageMs);
      await user.goto(fixture.origin);
      await browserExpect(disk().locator('dd').first()).toHaveText('Unavailable');
    }
  });

  it('expires the same cached disk usage in the Owner user quota view', async () => {
    await sample(4 * 1024 ** 2);
    await owner.clock.install({ time: new Date() });
    await owner.goto(`${fixture.origin}/owner/users/${identities.userId}`);
    const quota = owner
      .locator('section')
      .filter({ has: owner.getByRole('heading', { name: 'Allowance', exact: true }) });
    const usage = quota.locator('dd').filter({ hasText: /^(4 MiB|8 MiB|Unavailable) \/ / });
    await browserExpect(usage).toContainText('4 MiB /');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const path = `**/v1/platform/owner/users/${identities.userId}`;
    let intercepted = 0;
    await owner.route(path, async (route) => {
      intercepted++;
      await gate;
      await route.continue();
    });
    try {
      await owner.clock.fastForward(31000);
      await browserExpect.poll(() => intercepted).toBeGreaterThan(0);
      await browserExpect(usage).toContainText('Unavailable /');
      await sample(8 * 1024 ** 2, 0);
      await owner.clock.setSystemTime(new Date());
      release?.();
      await browserExpect(usage).toContainText('8 MiB /');
    } finally {
      release?.();
      await owner.unroute(path);
      await owner.clock.setSystemTime(new Date());
      await owner.clock.resume();
    }
    expect(pageErrors).toEqual([]);
  });
});

import { resolve } from 'node:path';
