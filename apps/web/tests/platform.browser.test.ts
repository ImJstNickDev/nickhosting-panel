import { AxeBuilder } from '@axe-core/playwright';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 real browser platform and Owner journeys', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page, owner: Page, peer: Page;
  let projectId: string, createdServerId: string, createdJobId: string;
  const pageErrors: string[] = [];
  beforeAll(async () => {
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
    ({ user, owner, peer } = identities);
    for (const page of [user, owner, peer])
      page.on('pageerror', (error) => pageErrors.push(error.message));
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    provider?.dispose();
    await fixture?.close();
  });
  async function accessible(page: Page) {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.map((item) => ({
        id: item.id,
        nodes: item.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  }
  async function quota(memoryMiB: number) {
    await journeyRequest(
      fixture,
      owner,
      '/v1/owner/user-limits',
      {
        userId: identities.userId,
        memoryMiB,
        cpuPercent: 200,
        storageMiB: 32768,
        reason: 'Isolated browser admission verification',
      },
      'PUT',
    );
  }
  async function overview() {
    await user.goto(`${fixture.origin}/servers/${provider.ids.serverId}`);
    await browserExpect(user.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  }

  it('shows scoped server artwork, resource units, useful empty filters and accessible Home', async () => {
    await user.goto(fixture.origin);
    await browserExpect(user.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
    await browserExpect(
      user.getByRole('link', { name: 'Survival', exact: true }).first(),
    ).toBeVisible();
    await browserExpect(user.locator('.server-artwork')).toBeVisible();
    expect(
      await user
        .locator('.server-artwork')
        .evaluate(
          (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
        ),
    ).toBe(true);
    await fixture.screenshot(user, 'home-desktop-en');
    await accessible(user);
    await user.goto(`${fixture.origin}/servers`);
    await user.getByLabel('Search servers').fill('does not exist');
    await user.getByRole('button', { name: 'Filter', exact: true }).click();
    await browserExpect(
      user.getByText('No servers match these filters.', { exact: true }),
    ).toBeVisible();
    await fixture.screenshot(user, 'servers-empty-desktop-en');
    await user.getByLabel('Search servers').fill('');
    await user.getByRole('button', { name: 'Filter', exact: true }).click();
    await browserExpect(user.getByRole('link', { name: 'Survival', exact: true })).toBeVisible();
    await fixture.screenshot(user, 'servers-desktop-en');
    await peer.goto(`${fixture.origin}/servers`);
    await browserExpect(peer.getByRole('link', { name: 'Survival', exact: true })).toHaveCount(0);
  });

  it('creates a verified-choice Vanilla server through the installer pages and reports admission-denied first start', async () => {
    let finishLookup: (() => void) | undefined;
    const lookupGate = new Promise<void>((resolve) => {
      finishLookup = resolve;
    });
    const player = { name: 'WizardAlex', id: '12345678123442348234123456789abc' };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === 'api.mojang.com' || url.hostname === 'sessionserver.mojang.com') {
        await lookupGate;
        return Response.json(player);
      }
      throw new Error('Unexpected external installer request');
    });
    await user.route('https://api.mcheads.org/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path fill="#806040" d="M0 0h40v40H0z"/></svg>',
      }),
    );
    await user.goto(`${fixture.origin}/servers`);
    await user.getByRole('link', { name: 'Create server', exact: true }).click();
    await browserExpect(user).toHaveURL(`${fixture.origin}/servers/new`);
    await browserExpect.poll(() => pageErrors).toEqual([]);
    await fixture.screenshot(user, 'installer-diagnostic');
    await browserExpect(
      user.getByRole('heading', { name: 'Choose a game', exact: true }),
    ).toBeVisible();
    await user.getByRole('button', { name: 'Minecraft Java', exact: true }).click();
    await fixture.screenshot(user, 'wizard-game-desktop-en');
    await user.getByRole('button', { name: 'Next', exact: true }).click();
    await user
      .locator('.installer-choice-card')
      .filter({ has: user.getByRole('radio', { name: 'Vanilla', exact: true }) })
      .click();
    await user.getByRole('button', { name: 'Next', exact: true }).click();
    await user.getByLabel('Server name', { exact: true }).fill('Creative');
    await fixture.screenshot(user, 'installer-name-desktop-en');
    await user.getByLabel('Server name', { exact: true }).press('Enter');
    await user
      .locator('.installer-version')
      .filter({ has: user.getByRole('radio', { name: '26.1', exact: true }) })
      .click();
    expect(await user.locator('main').innerText()).not.toMatch(
      /protocol ID|experimental|Paper|Forge|Folia|Fabric/i,
    );
    await fixture.screenshot(user, 'installer-version-desktop-en');
    await accessible(user);
    await user.getByRole('button', { name: 'Next', exact: true }).click();
    await browserExpect(
      user.getByRole('heading', { name: 'Who should be an operator?' }),
    ).toBeVisible();
    await user.getByLabel('Player name', { exact: true }).fill(player.name);
    await user.getByLabel('Player name', { exact: true }).press('Enter');
    await browserExpect(user.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    await browserExpect(user.getByRole('button', { name: 'Back', exact: true })).toBeDisabled();
    finishLookup?.();
    await browserExpect(
      user.getByRole('button', { name: `Remove ${player.name}`, exact: true }),
    ).toBeAttached();
    await fixture.screenshot(user, 'installer-operators-desktop-en');
    await accessible(user);
    await user.getByRole('button', { name: 'Next', exact: true }).click();
    await browserExpect(
      user.getByRole('heading', { name: 'Do you want to turn whitelist on?' }),
    ).toBeVisible();
    await user.getByRole('button', { name: 'Yes', exact: true }).click();
    await browserExpect(user.getByLabel('Player name', { exact: true })).toBeVisible();
    await browserExpect(user.getByText(player.name, { exact: true })).toBeVisible();
    await user.getByRole('button', { name: `Remove ${player.name}`, exact: true }).focus();
    await user.getByRole('button', { name: `Remove ${player.name}`, exact: true }).press('Enter');
    await user.getByRole('button', { name: 'No', exact: true }).click();
    await browserExpect(user.getByLabel('Player name', { exact: true })).not.toBeVisible();
    await user.getByRole('button', { name: 'Yes', exact: true }).click();
    await browserExpect(user.getByText(player.name, { exact: true })).toHaveCount(0);
    await fixture.screenshot(user, 'installer-whitelist-desktop-en');
    await user.getByRole('button', { name: 'Next', exact: true }).click();
    await user.getByRole('button', { name: 'Custom', exact: true }).click();
    await user.getByLabel('Memory (MiB)', { exact: true }).fill('128');
    await user.getByLabel('CPU limit (%)', { exact: true }).fill('10');
    await browserExpect(user.getByLabel('Disk (MiB)', { exact: true })).toHaveCount(0);
    await fixture.screenshot(user, 'installer-resources-desktop-en');
    await user.getByRole('button', { name: 'Next', exact: true }).click();
    await browserExpect(
      user.getByRole('link', { name: 'Minecraft EULA', exact: true }),
    ).toHaveAttribute('target', '_blank');
    await fixture.screenshot(user, 'wizard-review-desktop-en');
    const accepted = user.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/v1/minecraft/servers'),
    );
    await user.getByRole('button', { name: 'Create server', exact: true }).click();
    const response = await accepted;
    expect(response.status(), await response.text()).toBe(202);
    const operation = await response.json();
    createdServerId = operation.serverId;
    createdJobId = operation.jobId;
    await browserExpect(
      user.getByRole('link', { name: 'View operation', exact: true }),
    ).toBeVisible();
    await quota(64);
    await provider.processPending();
    await quota(4096);
    const job = await journeyRequest<{ state: string }>(
      fixture,
      user,
      `/v1/platform/jobs/${createdJobId}`,
    );
    expect(job.state).toBe('succeeded');
    await user.goto(`${fixture.origin}/servers/${createdServerId}`);
    await browserExpect(
      user.getByText(
        'Created, but the initial start was refused because capacity was unavailable. You can try Start again when resources are available.',
        { exact: false },
      ),
    ).toBeVisible();
    await fixture.screenshot(user, 'first-start-capacity-desktop-en');
  });

  it('renders the installer in Italian on mobile with preserved back navigation and reduced motion', async () => {
    await journeyRequest(fixture, peer, '/api/auth/update-user', {
      name: 'Italian reviewer',
      locale: 'it',
    });
    await peer.setViewportSize({ width: 390, height: 844 });
    await peer.goto(`${fixture.origin}/servers/new`);
    await peer.getByRole('button', { name: 'Minecraft Java', exact: true }).click();
    await peer.getByRole('button', { name: 'Avanti', exact: true }).click();
    await peer
      .locator('.installer-choice-card')
      .filter({ has: peer.getByRole('radio', { name: 'Vanilla', exact: true }) })
      .click();
    await peer.getByRole('button', { name: 'Avanti', exact: true }).click();
    await peer.getByLabel('Nome del server', { exact: true }).fill('Mondo condiviso');
    await fixture.screenshot(peer, 'installer-name-mobile-it');
    await peer.getByLabel('Nome del server', { exact: true }).press('Enter');
    await peer
      .locator('.installer-version')
      .filter({ has: peer.getByRole('radio', { name: '26.1', exact: true }) })
      .click();
    await peer.getByLabel('Mostra tutte le versioni', { exact: true }).check();
    await fixture.screenshot(peer, 'installer-version-mobile-it');
    await peer.getByRole('button', { name: 'Avanti', exact: true }).click();
    await fixture.screenshot(peer, 'installer-operators-mobile-it');
    await peer.getByRole('button', { name: 'Avanti', exact: true }).click();
    await peer.getByRole('button', { name: 'Sì', exact: true }).click();
    await fixture.screenshot(peer, 'installer-whitelist-mobile-it');
    await accessible(peer);
    await peer.getByRole('button', { name: 'Avanti', exact: true }).click();
    await peer.getByRole('button', { name: '6+', exact: true }).click();
    await browserExpect(peer.getByLabel('Disco (MiB)', { exact: true })).toHaveCount(0);
    await fixture.screenshot(peer, 'installer-resources-mobile-it');
    await peer.getByRole('button', { name: 'Avanti', exact: true }).click();
    await fixture.screenshot(peer, 'installer-review-mobile-it');
    await accessible(peer);
    expect(await peer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await peer.getByRole('button', { name: 'Indietro', exact: true }).click();
    await browserExpect(peer.getByRole('button', { name: '6+', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(pageErrors).toEqual([]);
  });

  it('rejects insufficient physical capacity then reports genuinely completed lifecycle jobs and Activity', async () => {
    await provider.setResourcesAvailable(false);
    await overview();
    await user.getByRole('button', { name: 'Start', exact: true }).click();
    await browserExpect(
      user.getByText('There is not enough available capacity to start this server.', {
        exact: true,
      }),
    ).toBeVisible();
    await fixture.screenshot(user, 'capacity-denied-desktop-en');
    await provider.setResourcesAvailable(true);
    for (const action of ['Start', 'Stop'] as const) {
      const accepted = user.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith(`/v1/servers/${provider.ids.serverId}/operations`),
      );
      await user.getByRole('button', { name: action, exact: true }).click();
      const response = await accepted;
      expect(response.status(), await response.text()).toBe(202);
      const operation = await response.json();
      await provider.processPending();
      await user.goto(`${fixture.origin}/activity/${operation.jobId}`);
      await browserExpect(
        user.getByRole('heading', { name: 'Operation details', exact: true }),
      ).toBeVisible();
      await browserExpect(user.locator('.badge').filter({ hasText: 'Completed' })).toBeVisible();
      if (action === 'Start') await fixture.screenshot(user, 'activity-completed-desktop-en');
      await overview();
    }
    await user.goto(`${fixture.origin}/activity`);
    await user.getByLabel('Status', { exact: true }).selectOption('succeeded');
    await user.getByLabel('Action', { exact: true }).selectOption('stop');
    await browserExpect(user.getByRole('row').filter({ hasText: 'Survival' })).toHaveCount(1);
    await accessible(user);
  });

  it('organizes and shares a server, discovers real members and revokes project access', async () => {
    await user.goto(`${fixture.origin}/projects`);
    await user.getByRole('button', { name: 'Create project', exact: true }).click();
    const dialog = user.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('Friends');
    await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
    await browserExpect(user.getByRole('heading', { name: 'Friends', exact: true })).toBeVisible();
    projectId = new URL(user.url()).pathname.split('/').at(-1) ?? '';
    await user.goto(`${fixture.origin}/servers/${provider.ids.serverId}/settings`);
    const metadata = user
      .locator('section')
      .filter({ has: user.getByRole('heading', { name: 'Name and project', exact: true }) });
    await metadata.getByLabel('Name', { exact: true }).fill('Alex Survival');
    await metadata.getByLabel('Project', { exact: true }).selectOption(projectId);
    await metadata.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(
      user.getByRole('heading', { name: 'Alex Survival', exact: true }),
    ).toBeVisible();
    await user.goto(`${fixture.origin}/projects/${projectId}`);
    const add = user
      .locator('section')
      .filter({ has: user.getByRole('heading', { name: 'Add member', exact: true }) });
    await add.getByLabel('Email', { exact: true }).fill(identities.peerEmail);
    await add.getByRole('button', { name: 'Find account', exact: true }).click();
    await browserExpect(add.getByText('Taylor', { exact: true })).toBeVisible();
    await add.getByLabel('Role', { exact: true }).selectOption('viewer');
    await add.getByRole('button', { name: 'Add member', exact: true }).click();
    await browserExpect(user.getByLabel('Role for Taylor')).toHaveValue('viewer');
    await fixture.screenshot(user, 'project-sharing-desktop-en');
    await accessible(user);
    await peer.goto(`${fixture.origin}/servers/${provider.ids.serverId}`);
    await browserExpect(
      peer.getByRole('heading', { name: 'Alex Survival', exact: true }),
    ).toBeVisible();
    await browserExpect(peer.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
    const denied = await peer.request.post(
      `${fixture.origin}/v1/servers/${provider.ids.serverId}/operations`,
      {
        headers: { Origin: fixture.origin },
        data: { action: 'start', idempotencyKey: 'viewer-must-not-start' },
      },
    );
    expect(denied.status()).toBe(403);
    await user
      .getByRole('row')
      .filter({ hasText: 'Taylor' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    await user.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await browserExpect(user.getByLabel('Role for Taylor')).toHaveCount(0);
    expect(
      (
        await peer.request.get(`${fixture.origin}/v1/platform/servers/${provider.ids.serverId}`)
      ).status(),
    ).toBe(404);
    await peer.reload();
    await browserExpect(
      peer.getByRole('heading', { name: 'Alex Survival', exact: true }),
    ).toHaveCount(0);
  });

  it('operates Owner quotas and renders health, infrastructure, mappings and protected settings honestly', async () => {
    await owner.goto(`${fixture.origin}/owner/users`);
    await owner.getByLabel('Search', { exact: true }).fill('Alex');
    await owner.getByRole('button', { name: 'Search', exact: true }).click();
    const historyResponse = owner.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/v1/platform/owner/audit' &&
        url.searchParams.get('userId') === identities.userId &&
        response.status() === 200
      );
    });
    await owner.getByRole('link', { name: 'Alex', exact: true }).click();
    const initialHistory = (await (await historyResponse).json()) as {
      items: Array<{ action: string }>;
    };
    const history = owner
      .locator('section')
      .filter({ has: owner.getByRole('heading', { name: 'Limit change history', exact: true }) });
    const initialLimitChanges = initialHistory.items.filter(
      (event) => event.action === 'resource.user_limits.updated',
    ).length;
    await browserExpect(
      history.getByText('resource.user_limits.updated', { exact: true }),
    ).toHaveCount(initialLimitChanges);
    await owner.getByText('Set individual limits', { exact: true }).click();
    const quotaSection = owner
      .locator('section')
      .filter({ has: owner.getByRole('heading', { name: 'Allowance', exact: true }) });
    await quotaSection.getByLabel('Memory (MiB)', { exact: true }).fill('3072');
    await quotaSection
      .getByLabel('Reason', { exact: true })
      .fill('Browser checked individual resource limits');
    await quotaSection.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(
      quotaSection.getByText('Individual limits active', { exact: false }),
    ).toBeVisible();
    await browserExpect(quotaSection.getByText('No expiration', { exact: false })).toBeVisible();
    await browserExpect(
      history.getByText('resource.user_limits.updated', { exact: true }),
    ).toHaveCount(initialLimitChanges + 1);
    const latestChange = history.locator('tbody tr').first();
    await latestChange.locator('summary').click();
    await browserExpect(
      latestChange.getByText('Browser checked individual resource limits', { exact: true }),
    ).toBeVisible();
    expect(
      (
        await journeyRequest<{ quota: { limits: { memoryMiB: number } } }>(
          fixture,
          owner,
          `/v1/platform/owner/users/${identities.userId}`,
        )
      ).quota.limits.memoryMiB,
    ).toBe(3072);
    await fixture.screenshot(owner, 'owner-user-quota-desktop-en');
    for (const [path, heading, name] of [
      ['/owner', 'Platform health', 'owner-health-desktop-en'],
      ['/owner/infrastructure', 'Infrastructure', 'owner-infrastructure-desktop-en'],
      ['/owner/settings', 'Platform settings', 'owner-settings-desktop-en'],
      ['/owner/integrations', 'Integrations', 'owner-integrations-desktop-en'],
    ] as const) {
      await owner.goto(`${fixture.origin}${path}`);
      await browserExpect(owner.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      if (path === '/owner')
        await browserExpect(
          owner.getByRole('heading', { name: 'Gateway routes', exact: true }),
        ).toBeVisible();
      await fixture.screenshot(owner, name);
      await accessible(owner);
    }
    expect((await user.request.get(`${fixture.origin}/v1/owner/settings`)).status()).toBe(403);
    expect(pageErrors).toEqual([]);
  });

  it('renders Italian mobile server and Activity journeys with keyboard focus and no page overflow', async () => {
    await journeyRequest(fixture, user, '/api/auth/update-user', { name: 'Alex', locale: 'it' });
    await user.evaluate(() => localStorage.setItem('nh.locale', 'it'));
    await user.setViewportSize({ width: 390, height: 844 });
    await user.goto(`${fixture.origin}/servers`);
    await browserExpect(user.getByRole('link', { name: /^(Alex )?Survival$/ })).toBeVisible();
    await fixture.screenshot(user, 'servers-mobile-it');
    await accessible(user);
    expect(
      await user.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await user.keyboard.press('Tab');
    expect(await user.evaluate(() => document.activeElement !== document.body)).toBe(true);
    await user.goto(`${fixture.origin}/activity`);
    await browserExpect(user.getByRole('heading', { name: 'Attività', exact: true })).toBeVisible();
    await fixture.screenshot(user, 'activity-mobile-it');
    await accessible(user);
    expect(
      await user.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  it('changes protected platform settings and rollout through Owner forms without exposing credentials or bypassing evidence', async () => {
    await owner.goto(`${fixture.origin}/owner/settings`);
    const instance = owner
      .locator('details')
      .filter({ has: owner.locator('summary').filter({ hasText: 'Instance name' }) });
    await instance.locator('summary').click();
    await instance.getByLabel('Instance name', { exact: true }).fill('NickHosting Browser');
    await instance.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect
      .poll(
        async () =>
          (
            await journeyRequest<{ config: { values: { instanceName: string } } }>(
              fixture,
              owner,
              '/v1/owner/settings',
            )
          ).config.values.instanceName,
      )
      .toBe('NickHosting Browser');
    const credential = owner
      .locator('details')
      .filter({ has: owner.locator('summary').filter({ hasText: 'Pterodactyl Application key' }) });
    await credential.locator('summary').click();
    await credential
      .getByLabel('New credential', { exact: true })
      .fill('browser-fixture-rotated-application');
    await credential.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(credential.getByLabel('New credential', { exact: true })).toHaveValue('');
    expect(
      JSON.stringify(await journeyRequest(fixture, owner, '/v1/owner/settings')),
    ).not.toContain('browser-fixture-rotated-application');
    await owner.goto(`${fixture.origin}/owner/integrations`);
    await owner.getByLabel('Availability', { exact: true }).selectOption('private-testing');
    await owner.getByLabel('Tester user IDs (one per line)', { exact: true }).fill('');
    await owner.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(owner.getByText('Changes saved', { exact: true })).toBeVisible();
    const hidden = await journeyRequest<Array<{ id: string; access: { canCreate: boolean } }>>(
      fixture,
      user,
      '/v1/games',
    );
    expect(hidden.find((game) => game.id === 'minecraft-java')?.access.canCreate ?? false).toBe(
      false,
    );
    await owner
      .getByLabel('Tester user IDs (one per line)', { exact: true })
      .fill(identities.userId);
    await owner.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect
      .poll(
        async () =>
          (
            await journeyRequest<Array<{ id: string; access: { canCreate: boolean } }>>(
              fixture,
              user,
              '/v1/games',
            )
          ).find((game) => game.id === 'minecraft-java')?.access.canCreate,
      )
      .toBe(true);
    const choices = await journeyRequest<Array<{ runtime: string }>>(
      fixture,
      user,
      '/v1/minecraft/choices',
    );
    expect(choices.map((choice) => choice.runtime)).toEqual(['vanilla']);
    await fixture.screenshot(owner, 'owner-rollout-testers-desktop-en');
    await owner.getByLabel('Availability', { exact: true }).selectOption('public');
    await owner.getByLabel('Tester user IDs (one per line)', { exact: true }).fill('');
    await owner.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(owner.getByText('Changes saved', { exact: true })).toBeVisible();
  });

  it('requires explicit Owner acknowledgement for an uncertain non-power effect without claiming rollback', async () => {
    const queued = await journeyRequest<{ jobId: string }>(
      fixture,
      user,
      `/v1/servers/${provider.ids.serverId}/operations`,
      { action: 'backup', idempotencyKey: 'browser-lost-backup-response' },
    );
    const create = provider.adapter.createBackup;
    provider.adapter.createBackup = async (...args) => {
      await create(...args);
      throw new PterodactylError('unavailable', 'client', 'unknown');
    };
    try {
      await provider.management.process(queued.jobId);
    } finally {
      provider.adapter.createBackup = create;
    }
    const before = await journeyRequest<{ ownerRecovery: { available: boolean } | null }>(
      fixture,
      owner,
      `/v1/platform/jobs/${queued.jobId}`,
    );
    expect(before.ownerRecovery?.available).toBe(false);
    await owner.goto(`${fixture.origin}/activity/${queued.jobId}`);
    await browserExpect(
      owner.getByRole('button', { name: 'Review uncertain operation', exact: true }),
    ).toBeDisabled();
    // Stage the elapsed interval in this disposable schema. The corresponding
    // backend test proves the <120s refusal; no provider/job outcome is changed.
    await fixture.database.db
      .updateTable('server_operations')
      .set({ effect_started_at: new Date(Date.now() - 121000) })
      .where('job_id', '=', queued.jobId)
      .execute();
    await owner.reload();
    await browserExpect(
      owner.getByRole('button', { name: 'Review uncertain operation', exact: true }),
    ).toBeEnabled();
    await browserExpect(
      owner.getByText(
        'The provider outcome is not confirmed. Do not repeat this action; an Owner must inspect the evidence.',
        { exact: true },
      ),
    ).toBeVisible();
    await fixture.screenshot(owner, 'activity-uncertain-owner-desktop-en');
    await owner.getByRole('button', { name: 'Review uncertain operation', exact: true }).click();
    const dialog = owner.getByRole('dialog');
    await browserExpect(
      dialog.getByText('It does not undo changes', { exact: false }),
    ).toBeVisible();
    await dialog
      .getByLabel('Reason', { exact: true })
      .fill('Reviewed isolated provider inventory; acknowledge unknown outcome');
    await dialog
      .getByLabel('I have reviewed the provider state and understand that changes may remain.', {
        exact: true,
      })
      .check();
    await dialog.getByRole('button', { name: 'Acknowledge unknown failure', exact: true }).click();
    await browserExpect(dialog).not.toBeVisible();
    const result = await journeyRequest<{
      state: string;
      phase: string;
      errorCode: string;
      retry: { allowed: boolean };
    }>(fixture, owner, `/v1/platform/jobs/${queued.jobId}`);
    expect(result).toMatchObject({
      state: 'failed',
      phase: 'owner_resolved_failed',
      errorCode: 'operation_uncertain',
      retry: { allowed: false },
    });
    expect(
      await fixture.database.db
        .selectFrom('audit_events')
        .select('metadata')
        .where('action', '=', 'server.operation.owner_resolution')
        .execute(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ outcome: 'acknowledged_unknown_failure' }),
        }),
      ]),
    );
    await browserExpect(owner.getByText('Failed', { exact: true })).toBeVisible();
    await browserExpect(owner.getByText('Unknown', { exact: true })).toBeVisible();
    await browserExpect(
      owner.getByText(
        'The Owner acknowledged the failure. The external outcome is unknown; changes may remain. This operation will not be replayed automatically.',
        { exact: true },
      ),
    ).toBeVisible();
    await browserExpect(
      owner.getByText('The result is being checked. Do not repeat the operation.', { exact: true }),
    ).toHaveCount(0);
    await browserExpect(
      owner.getByText(
        'The provider outcome is not confirmed. Do not repeat this action; an Owner must inspect the evidence.',
        { exact: true },
      ),
    ).toHaveCount(0);
    await browserExpect(
      owner.getByRole('button', { name: 'Review uncertain operation', exact: true }),
    ).toHaveCount(0);
    await browserExpect(
      owner.getByRole('button', { name: 'Request a new attempt', exact: true }),
    ).toHaveCount(0);
    await fixture.screenshot(owner, 'activity-acknowledged-failure-desktop-en');
    await accessible(owner);
    await owner.goto(`${fixture.origin}/activity`);
    const row = owner.locator('tr').filter({
      has: owner.locator(`a[href="/activity/${queued.jobId}"]`),
    });
    await browserExpect(row.getByText('Failed', { exact: true })).toBeVisible();
    await browserExpect(row.getByText('Outcome not confirmed', { exact: true })).toHaveCount(0);
  });

  it('reviews English mobile and Italian desktop density, localization and accessibility', async () => {
    for (const [locale, mobile, name] of [
      ['en', true, 'servers-mobile-en'],
      ['it', false, 'servers-desktop-it'],
    ] as const) {
      await journeyRequest(fixture, user, '/api/auth/update-user', { name: 'Alex', locale });
      await user.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      );
      await user.goto(`${fixture.origin}/servers`);
      await browserExpect(
        user.getByRole('heading', { name: locale === 'en' ? 'Servers' : 'Server', exact: true }),
      ).toBeVisible();
      await browserExpect(user.locator('.server-artwork').first()).toBeVisible();
      await fixture.screenshot(user, name);
      await accessible(user);
      expect(
        await user.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
    expect(pageErrors).toEqual([]);
  });

  it('gives platform operators read-only audit and settings access without Owner mutations', async () => {
    await journeyRequest(
      fixture,
      owner,
      '/v1/owner/roles',
      { userId: identities.peerId, role: 'operator' },
      'PATCH',
    );
    await peer.goto(fixture.origin);
    await peer.getByRole('link', { name: 'Administration', exact: true }).click();
    await browserExpect(peer).toHaveURL(`${fixture.origin}/owner/audit`);
    await browserExpect(
      peer.getByRole('heading', { name: 'Audit log', exact: true }),
    ).toBeVisible();
    await browserExpect(peer.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
    await browserExpect(
      peer.getByRole('link', { name: 'Infrastructure', exact: true }),
    ).toHaveCount(0);
    expect((await peer.request.get(`${fixture.origin}/v1/platform/owner/audit`)).status()).toBe(
      200,
    );
    await accessible(peer);

    await peer.getByRole('link', { name: 'Settings', exact: true }).click();
    await browserExpect(
      peer.getByRole('heading', { name: 'Platform settings', exact: true }),
    ).toBeVisible();
    const instance = peer
      .locator('details')
      .filter({ has: peer.locator('summary').filter({ hasText: 'Instance name' }) });
    await instance.locator('summary').click();
    await browserExpect(
      instance.getByText('Your role can view these settings. Only the Owner can change them.'),
    ).toBeVisible();
    const before = await journeyRequest<{ config: { values: { instanceName: string } } }>(
      fixture,
      peer,
      '/v1/owner/settings',
    );
    await browserExpect(instance.locator('pre')).toContainText(before.config.values.instanceName);
    const credential = peer
      .locator('details')
      .filter({ has: peer.locator('summary').filter({ hasText: 'Pterodactyl Application key' }) });
    await credential.locator('summary').click();
    await browserExpect(credential.getByText('Configured', { exact: true })).toBeVisible();
    await browserExpect(
      peer.getByRole('button', { name: 'Save changes', exact: true }),
    ).toHaveCount(0);
    await browserExpect(peer.getByLabel('New credential', { exact: true })).toHaveCount(0);
    expect(JSON.stringify(await journeyRequest(fixture, peer, '/v1/owner/settings'))).not.toContain(
      'browser-fixture-application',
    );
    expect(
      (
        await peer.request.patch(`${fixture.origin}/v1/owner/settings`, {
          headers: { Origin: fixture.origin },
          data: { instanceName: 'Unauthorized operator change' },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await peer.request.put(`${fixture.origin}/v1/owner/secrets/pterodactylApplicationKey`, {
          headers: { Origin: fixture.origin },
          data: { value: 'browser-forbidden-credential' },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await journeyRequest<{ config: { values: { instanceName: string } } }>(
          fixture,
          owner,
          '/v1/owner/settings',
        )
      ).config.values.instanceName,
    ).toBe(before.config.values.instanceName);
    await fixture.screenshot(peer, 'operator-settings-readonly-desktop-en');
    await accessible(peer);
    expect((await peer.request.get(`${fixture.origin}/v1/owner/health`)).status()).toBe(403);
    await peer.goto(`${fixture.origin}/owner`);
    await browserExpect(peer).toHaveURL(`${fixture.origin}/`);
    await browserExpect(peer.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();

    await journeyRequest(
      fixture,
      owner,
      '/v1/owner/roles',
      { userId: identities.peerId, role: 'user' },
      'PATCH',
    );
    await peer.goto(`${fixture.origin}/owner/settings`);
    await browserExpect(peer).toHaveURL(`${fixture.origin}/`);
    await browserExpect(
      peer.getByRole('link', { name: 'Administration', exact: true }),
    ).toHaveCount(0);
    expect((await peer.request.get(`${fixture.origin}/v1/owner/settings`)).status()).toBe(403);
    expect(pageErrors).toEqual([]);
  });
});
