import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { parseMinecraftProperties } from '@nickhosting/minecraft';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('Minecraft settings browser journeys', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  const errors: string[] = [];
  beforeAll(async () => {
    fixture = await browserHarness({
      browser: process.env.NH_BROWSER === 'firefox' ? 'firefox' : 'chromium',
    });
    identities = await prepareJourneyIdentities(fixture);
    page = identities.user;
    for (const current of [page, identities.peer])
      current.on('pageerror', (error) => errors.push(error.message));
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
    // Provider file bytes are synthetic. The profile handler determines the
    // actual editable field set from these bytes, not a mocked management UI.
    const files = await provider.files();
    files.set(
      'server.properties',
      Buffer.concat([
        files.get('server.properties') ?? Buffer.alloc(0),
        Buffer.from(
          '\nhardcore=false\nallow-flight=false\nspawn-monsters=true\nspawn-animals=true\nspawn-npcs=true\ngenerate-structures=true\nspawn-protection=16\nplayer-idle-timeout=0\nrcon.password=fixture-secret-not-visible\n',
        ),
      ]),
    );
  });
  afterAll(async () => {
    provider?.dispose();
    await fixture?.close();
  });
  const base = () => `/servers/${provider.ids.serverId}/game`;
  const profilePath = () => `/v1/servers/${provider.ids.serverId}/minecraft`;
  const form = (current = page) => current.getByRole('form', { name: 'Server properties' });
  const save = () => form().getByRole('button', { name: 'Save changes', exact: true });
  async function screenshot(name: string, current = page) {
    await current.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
    });
    await current.mouse.move(700, 70);
    await current.screenshot({
      path: resolve('.codex/local/m5-browser/screenshots', `${name}.png`),
      fullPage: true,
    });
  }
  async function accessible(current = page) {
    const result = await new AxeBuilder({ page: current })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map((item) => ({
        id: item.id,
        nodes: item.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  }
  function acceptedResponse() {
    return page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`${profilePath()}/operations`),
    );
  }

  it('groups Minecraft navigation and saves only changed supported fields through the real job', async () => {
    await page.goto(`${fixture.origin}/servers/${provider.ids.serverId}/settings`);
    const top = page.getByRole('navigation', { name: 'Servers', exact: true });
    await browserExpect(top.getByRole('link', { name: 'Minecraft', exact: true })).toHaveCount(1);
    for (const legacy of ['Players', 'Worlds', 'Content'])
      await browserExpect(top.getByRole('link', { name: legacy, exact: true })).toHaveCount(0);
    await top.getByRole('link', { name: 'Minecraft', exact: true }).click();
    await browserExpect(page).toHaveURL(`${fixture.origin}${base()}/properties`);
    const tabs = page.getByRole('navigation', { name: 'Minecraft', exact: true });
    await browserExpect(tabs.getByRole('link')).toHaveCount(4);
    await tabs.getByRole('link', { name: 'Players', exact: true }).click();
    await browserExpect(page).toHaveURL(`${fixture.origin}${base()}/players`);
    await page.goto(`${fixture.origin}${base()}/properties`);
    await browserExpect(form().getByRole('switch', { name: 'Player combat' })).toBeChecked();
    await browserExpect(form().getByLabel('Player limit', { exact: true })).toHaveValue('20');
    await browserExpect(save()).toHaveCount(0);
    for (const heading of ['Gameplay', 'World', 'Access', 'Performance'])
      await browserExpect(
        form().getByRole('heading', { name: heading, exact: true }),
      ).toBeVisible();
    expect(await form().innerText()).not.toContain('fixture-secret-not-visible');
    await form()
      .getByRole('textbox', { name: 'Server description', exact: true })
      .fill('Unsaved example');
    await form().getByRole('radio', { name: 'Hard', exact: true }).press('Space');
    await form().getByRole('button', { name: 'Reset changes', exact: true }).click();
    await browserExpect(
      form().getByRole('textbox', { name: 'Server description', exact: true }),
    ).toHaveValue('Browser survival');
    await browserExpect(form().getByRole('radio', { name: 'Normal', exact: true })).toBeChecked();
    await browserExpect(save()).toHaveCount(0);
    await form()
      .getByRole('textbox', { name: 'Server description', exact: true })
      .fill('Weekend survival');
    await form().getByRole('radio', { name: 'Hard', exact: true }).press('Space');
    await form().getByLabel('Player limit', { exact: true }).fill('8');
    const responsePromise = acceptedResponse();
    await save().click();
    const response = await responsePromise;
    expect(response.status()).toBe(202);
    expect(response.request().postDataJSON()).toMatchObject({
      command: {
        kind: 'properties',
        changes: { motd: 'Weekend survival', difficulty: 'hard', 'max-players': 8 },
      },
    });
    expect(Object.keys(response.request().postDataJSON().command.changes).sort()).toEqual([
      'difficulty',
      'max-players',
      'motd',
    ]);
    const { jobId } = (await response.json()) as { jobId: string };
    expect(
      await fixture.database.db
        .selectFrom('operation_jobs')
        .select('state')
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'queued' });
    await browserExpect(form().getByLabel('Player limit', { exact: true })).toBeDisabled();
    await browserExpect(page.getByText('Changes saved', { exact: true })).toHaveCount(0);
    expect(
      parseMinecraftProperties((await provider.files()).get('server.properties')?.toString() ?? '')
        .motd,
    ).toBe('Browser survival');
    const delivery = await provider.processPending();
    expect(
      await fixture.database.db
        .selectFrom('operation_jobs')
        .select(['state', 'error_code'])
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow(),
      JSON.stringify(delivery),
    ).toEqual({ state: 'succeeded', error_code: null });
    await browserExpect(save()).toHaveCount(0);
    await browserExpect(form().getByLabel('Player limit', { exact: true })).toBeEnabled();
    expect(
      parseMinecraftProperties((await provider.files()).get('server.properties')?.toString() ?? ''),
    ).toMatchObject({ motd: 'Weekend survival', difficulty: 'hard', 'max-players': '8' });
    await page.getByRole('heading', { name: 'Gameplay', exact: true }).hover();
    await screenshot('minecraft-settings-desktop-en');
    await accessible();
    await journeyRequest(fixture, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await browserExpect(page.getByLabel('Limite giocatori', { exact: true })).toHaveValue('8');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await screenshot('minecraft-settings-mobile-it');
    await accessible();
    await journeyRequest(fixture, page, '/api/auth/update-user', { locale: 'en' });
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  it('keeps supported settings readable without save actions while running or shared view-only', async () => {
    const db = fixture.database.db;
    await db
      .updateTable('managed_servers')
      .set({ runtime_state: 'running' })
      .where('id', '=', provider.ids.serverId)
      .execute();
    await page.goto(`${fixture.origin}${base()}/properties`);
    await browserExpect(form().getByLabel('Player limit', { exact: true })).toBeDisabled();
    await browserExpect(save()).toHaveCount(0);
    await browserExpect(
      page.getByText('Stop the server before changing these settings.'),
    ).toBeVisible();
    await screenshot('minecraft-settings-running-desktop-en');
    await accessible();
    await db
      .updateTable('managed_servers')
      .set({ runtime_state: 'offline' })
      .where('id', '=', provider.ids.serverId)
      .execute();
    const project = await journeyRequest<{ id: string }>(fixture, page, '/v1/projects', {
      name: 'Shared world',
    });
    await journeyRequest(
      fixture,
      page,
      `/v1/platform/servers/${provider.ids.serverId}`,
      { projectId: project.id },
      'PATCH',
    );
    await journeyRequest(
      fixture,
      page,
      `/v1/projects/${project.id}/members`,
      { userId: identities.peerId, role: 'viewer' },
      'PUT',
    );
    await identities.peer.goto(`${fixture.origin}${base()}/properties`);
    await browserExpect(
      form(identities.peer).getByLabel('Player limit', { exact: true }),
    ).toBeDisabled();
    await browserExpect(
      form(identities.peer).getByRole('button', { name: 'Save changes' }),
    ).toHaveCount(0);
    await browserExpect(
      identities.peer.getByText('You do not have permission to make this change.'),
    ).toBeVisible();
    await accessible(identities.peer);
  });

  it('filters an older runtime to its supported fields instead of advertising newer settings', async () => {
    const current = await journeyRequest<Record<string, unknown>>(fixture, page, profilePath());
    // UI contract fixture only: no claim that this fake provider runs Minecraft1.5.2.
    const older = {
      ...current,
      version: '1.5.2',
      supportedProperties: [
        'motd',
        'difficulty',
        'gamemode',
        'max-players',
        'pvp',
        'white-list',
        'view-distance',
      ],
      effectiveProperties: {
        motd: 'Legacy world',
        difficulty: '2',
        gamemode: '0',
        'max-players': '20',
        pvp: 'true',
        'white-list': 'false',
        'view-distance': '10',
      },
    };
    await page.route(`**${profilePath()}`, (route) => route.fulfill({ json: older }));
    try {
      await page.goto(`${fixture.origin}${base()}/properties`);
      await browserExpect(
        form().getByRole('textbox', { name: 'Server description', exact: true }),
      ).toHaveValue('Legacy world');
      await browserExpect(form().getByRole('radio', { name: 'Normal', exact: true })).toBeChecked();
      await browserExpect(
        form().getByRole('radio', { name: 'Survival', exact: true }),
      ).toBeChecked();
      await browserExpect(
        form().getByLabel('Simulation distance (chunks)', { exact: true }),
      ).toHaveCount(0);
      await browserExpect(
        form().getByRole('switch', { name: 'Allow flying', exact: true }),
      ).toHaveCount(0);
      await browserExpect(form().getByRole('heading', { name: 'World', exact: true })).toHaveCount(
        0,
      );
      await screenshot('minecraft-settings-legacy-desktop-en');
      await accessible();
    } finally {
      await page.unroute(`**${profilePath()}`);
    }
  });

  it('preserves drafts after request errors and an uncertain durable operation without claiming success', async () => {
    await page.goto(`${fixture.origin}${base()}/properties`);
    await form()
      .getByRole('textbox', { name: 'Server description', exact: true })
      .fill('Preserved draft');
    const operationURL = `**${profilePath()}/operations`;
    // Inject one external-service error at the HTTP boundary; retry uses real handlers.
    await page.route(operationURL, (route) =>
      route.fulfill({
        status: 503,
        json: {
          error: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
        },
      }),
    );
    const failed = acceptedResponse();
    await save().click();
    expect((await failed).status()).toBe(503);
    await browserExpect(
      form().getByRole('textbox', { name: 'Server description', exact: true }),
    ).toHaveValue('Preserved draft');
    await browserExpect(form().getByRole('alert')).toBeVisible();
    await browserExpect(save()).toBeEnabled();
    await screenshot('minecraft-settings-error-desktop-en');
    await page.unroute(operationURL);
    const accepted = acceptedResponse();
    await save().click();
    const response = await accepted;
    expect(response.status()).toBe(202);
    const { jobId } = (await response.json()) as { jobId: string };
    // Fault injection in a disposable schema: no external file mutation is delivered.
    await fixture.database.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('server_operations')
        .set({ effect_state: 'uncertain' })
        .where('job_id', '=', jobId)
        .execute();
      await tx
        .updateTable('operation_jobs')
        .set({ state: 'failed', error_code: 'operation_uncertain', completed_at: new Date() })
        .where('id', '=', jobId)
        .execute();
    });
    await browserExpect(
      page.getByText('The result is being checked. Do not repeat the operation.'),
    ).toBeVisible();
    await browserExpect(
      form().getByRole('textbox', { name: 'Server description', exact: true }),
    ).toHaveValue('Preserved draft');
    await browserExpect(form().locator('button[type="submit"]')).toBeDisabled();
    await browserExpect(page.getByText('Changes saved', { exact: true })).toHaveCount(0);
    await screenshot('minecraft-settings-uncertain-desktop-en');
    await accessible();
    // Reconciliation may finish the same previously uncertain job. A new page
    // load or a different job ID must not be required to resume normal editing.
    const files = await provider.files();
    files.set(
      'server.properties',
      Buffer.from(
        (files.get('server.properties')?.toString() ?? '').replace(
          /^motd=.*$/m,
          'motd=Preserved draft',
        ),
      ),
    );
    await fixture.database.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('server_operations')
        .set({ effect_state: 'confirmed' })
        .where('job_id', '=', jobId)
        .execute();
      await tx
        .updateTable('operation_jobs')
        .set({ state: 'succeeded', error_code: null, completed_at: new Date() })
        .where('id', '=', jobId)
        .execute();
      await tx
        .updateTable('managed_servers')
        .set({ active_operation_id: null })
        .where('id', '=', provider.ids.serverId)
        .execute();
    });
    await browserExpect(
      form().getByRole('textbox', { name: 'Server description', exact: true }),
    ).toBeEnabled({ timeout: 15000 });
    await browserExpect(save()).toHaveCount(0);
    await browserExpect(
      page.getByText('The result is being checked. Do not repeat the operation.'),
    ).toHaveCount(0);
    await browserExpect(
      form().getByRole('textbox', { name: 'Server description', exact: true }),
    ).toHaveValue('Preserved draft');
    expect(errors).toEqual([]);
  });
});
