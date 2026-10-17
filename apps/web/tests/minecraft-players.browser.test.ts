import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { DomainError } from '@nickhosting/core';
import type { ConsoleRelayOptions } from '@nickhosting/pterodactyl-adapter';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 Minecraft players through authorized APIs and provider file confirmation', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let identifier: string;
  const player = { name: 'BrowserAlex', id: '12345678123442348234123456789abc' };
  const uuid = '12345678-1234-4234-8234-123456789abc';
  const pageErrors: string[] = [];
  const commands: string[] = [];
  const streams = new Set<ConsoleRelayOptions>();
  let confirmCommands = true;
  let rejectCommands = false;
  let failFiles = false;
  let onlineUnavailable = false;
  let onlineGate: Promise<void> | undefined;
  const api = () => `/v1/servers/${provider.ids.serverId}/minecraft`;
  const route = () => `${fixture.origin}/servers/${provider.ids.serverId}/game/players`;

  beforeAll(async () => {
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
    user = identities.user;
    for (const page of [user, identities.peer])
      page.on('pageerror', (error) => pageErrors.push(error.message));
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.href === `https://api.mojang.com/users/profiles/minecraft/${player.name}` ||
        url.href === `https://sessionserver.mojang.com/session/minecraft/profile/${player.id}`
      )
        return Response.json(player);
      throw new Error('Unexpected external request in isolated player browser fixture');
    });
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
    const server = await fixture.database.db
      .selectFrom('managed_servers')
      .select('pterodactyl_identifier')
      .where('id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    identifier = server.pterodactyl_identifier ?? '';
    const files = await provider.files();
    files.set('banned-players.json', Buffer.from('[]'));
    const read = provider.adapter.readFile;
    provider.adapter.readFile = async (...args) => {
      if (failFiles) throw new DomainError('integration_unavailable');
      return read(...args);
    };
    const resources = provider.adapter.getResources;
    provider.adapter.getResources = async (...args) => {
      if (rejectCommands) throw new DomainError('forbidden');
      return resources(...args);
    };
    const relay = provider.adapter.relayConsole;
    provider.adapter.relayConsole = async (id, input) => {
      const connection = await relay(id, input);
      streams.add(input);
      return {
        ...connection,
        close() {
          streams.delete(input);
          connection.close();
        },
      };
    };
    provider.adapter.sendCommand = async (_id, command) => {
      if (command === 'list') {
        await onlineGate;
        if (onlineUnavailable) {
          for (const stream of streams) stream.onEvent({ type: 'closed' });
          return;
        }
        for (const stream of streams)
          stream.onEvent({
            type: 'console',
            data: `[12:34:56] [Server thread/INFO]: There are 1 of a max of 20 players online: ${player.name}`,
          });
        return;
      }
      commands.push(command);
      if (!confirmCommands) return;
      const files = await provider.files();
      const entry = { name: player.name, uuid };
      if (command === `op ${player.name}`)
        files.set(
          'ops.json',
          Buffer.from(JSON.stringify([{ ...entry, level: 4, bypassesPlayerLimit: false }])),
        );
      if (command === `deop ${player.name}`) files.set('ops.json', Buffer.from('[]'));
      if (command === `whitelist add ${player.name}`)
        files.set('whitelist.json', Buffer.from(JSON.stringify([entry])));
      if (command === `whitelist remove ${player.name}`)
        files.set('whitelist.json', Buffer.from('[]'));
      if (command === 'whitelist on' || command === 'whitelist off')
        files.set(
          'server.properties',
          Buffer.from(
            (files.get('server.properties')?.toString() ?? '').replace(
              /^white-list=.*$/m,
              `white-list=${command === 'whitelist on'}`,
            ),
          ),
        );
      if (command.startsWith(`ban ${player.name}`))
        files.set(
          'banned-players.json',
          Buffer.from(JSON.stringify([{ ...entry, reason: 'Browser test', expires: 'forever' }])),
        );
      if (command === `pardon ${player.name}`) files.set('banned-players.json', Buffer.from('[]'));
    };
  });

  afterAll(async () => {
    provider?.dispose();
    vi.unstubAllGlobals();
    await fixture?.close();
  });
  beforeEach(() => {
    rejectCommands = false;
    confirmCommands = true;
    failFiles = false;
    onlineUnavailable = false;
    onlineGate = undefined;
  });

  async function running(value: boolean) {
    await provider.adapter.power(identifier, value ? 'start' : 'stop');
    await fixture.database.db
      .updateTable('managed_servers')
      .set({ runtime_state: value ? 'running' : 'offline' })
      .where('id', '=', provider.ids.serverId)
      .execute();
  }
  async function operation(click: () => Promise<unknown>) {
    const response = user.waitForResponse(
      (result) =>
        result.request().method() === 'POST' && result.url().endsWith(`${api()}/operations`),
    );
    await click();
    const accepted = await response;
    expect(accepted.status(), await accepted.text()).toBe(202);
    const { jobId } = (await accepted.json()) as { jobId: string };
    const delivery = await provider.processPending();
    const job = await fixture.database.db
      .selectFrom('operation_jobs')
      .select(['state', 'error_code'])
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(job, JSON.stringify(delivery)).toEqual({ state: 'succeeded', error_code: null });
  }
  async function action(
    click: () => Promise<unknown>,
    expectedCommand: string | null,
    status = 202,
  ) {
    const count = commands.length;
    const response = user.waitForResponse(
      (result) =>
        result.request().method() === 'POST' && result.url().endsWith(`${api()}/players/actions`),
    );
    await click();
    const result = await response;
    expect(result.status(), await result.text()).toBe(status);
    expect(commands.slice(count)).toEqual(expectedCommand === null ? [] : [expectedCommand]);
    return result;
  }
  async function screenshot(page: Page, name: string) {
    // All displayed identities are fixture-only; keep the search/input controls
    // visible for meaningful layout review instead of masking autocomplete=off.
    await page.screenshot({
      path: resolve('.codex/local/m5-browser/screenshots', `${name}.png`),
      fullPage: true,
    });
  }
  async function accessible(page = user) {
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((n) => n.target) })),
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }

  async function choose(label: string, row = true) {
    await user
      .getByRole('button', { name: row ? `${label}: ${player.name}` : label, exact: true })
      .click();
    const dialog = user.getByRole('dialog', { name: label, exact: true });
    await browserExpect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    return dialog;
  }

  it('adds and removes verified player access offline through durable jobs', async () => {
    await user.goto(route());
    await browserExpect(
      user.getByText('No players in the saved lists.', { exact: true }),
    ).toBeVisible();
    await browserExpect(
      user.getByText('Server offline. Online players cannot be checked.', { exact: true }),
    ).toBeVisible();
    await screenshot(user, 'minecraft-players-empty-desktop-en');
    await accessible();
    await user.getByRole('button', { name: 'Add player', exact: true }).click();
    const username = user.getByLabel('Minecraft username', { exact: true });
    await browserExpect(username).toBeFocused();
    await username.fill(player.name);
    await username.press('Enter');
    await browserExpect(
      user.getByText('Verified Minecraft account', { exact: true }),
    ).toBeVisible();
    let dialog = await choose('Add to whitelist', false);
    await operation(() =>
      dialog.getByRole('button', { name: 'Add to whitelist', exact: true }).click(),
    );
    await browserExpect(user.locator('.minecraft-player')).toHaveCount(1);
    expect(
      JSON.parse((await provider.files()).get('whitelist.json')?.toString() ?? 'null'),
    ).toEqual([{ name: player.name, uuid }]);

    dialog = await choose('Make operator');
    await dialog.getByText('Advanced permissions', { exact: true }).click();
    await dialog.getByLabel('Operator level', { exact: true }).selectOption('2');
    await dialog.getByLabel('Bypass the player limit', { exact: true }).check();
    await operation(() =>
      dialog.getByRole('button', { name: 'Make operator', exact: true }).click(),
    );
    await browserExpect(
      user.getByRole('button', { name: `Remove operator: ${player.name}`, exact: true }),
    ).toBeEnabled();
    expect(JSON.parse((await provider.files()).get('ops.json')?.toString() ?? 'null')).toEqual([
      { name: player.name, uuid, level: 2, bypassesPlayerLimit: true },
    ]);
    await user.reload();
    await browserExpect(user.locator('.minecraft-player')).toHaveCount(1);
    await screenshot(user, 'minecraft-players-offline-desktop-en');
    await accessible();
    dialog = await choose('Remove operator');
    await operation(() =>
      dialog.getByRole('button', { name: 'Remove operator', exact: true }).click(),
    );
    await browserExpect(
      user.getByRole('button', { name: `Make operator: ${player.name}`, exact: true }),
    ).toBeEnabled();
    dialog = await choose('Remove from whitelist');
    await operation(() =>
      dialog.getByRole('button', { name: 'Remove from whitelist', exact: true }).click(),
    );
    await browserExpect(user.locator('.minecraft-player')).toHaveCount(0);
    expect(JSON.parse((await provider.files()).get('ops.json')?.toString() ?? 'null')).toEqual([]);
    expect(
      JSON.parse((await provider.files()).get('whitelist.json')?.toString() ?? 'null'),
    ).toEqual([]);
    expect(commands).toEqual([]);
  });

  it('dispatches typed running actions and refreshes authoritative lists', async () => {
    await running(true);
    await user.goto(route());
    await browserExpect(user.locator('.minecraft-player')).toHaveCount(1);
    await browserExpect(user.locator('.minecraft-player-role--online')).toHaveText('Online');
    for (const [label, command, next] of [
      ['Make operator', `op ${player.name}`, 'Remove operator'],
      ['Add to whitelist', `whitelist add ${player.name}`, 'Remove from whitelist'],
    ] as const) {
      const dialog = await choose(label);
      await action(() => dialog.getByRole('button', { name: label, exact: true }).click(), command);
      await browserExpect(
        user.getByRole('button', { name: `${next}: ${player.name}`, exact: true }),
      ).toBeEnabled();
    }
    await user.getByRole('switch', { name: 'Whitelist', exact: true }).click();
    let dialog = user.getByRole('dialog', { name: 'Enable whitelist', exact: true });
    await action(
      () => dialog.getByRole('button', { name: 'Enable whitelist', exact: true }).click(),
      'whitelist on',
    );
    await browserExpect(user.getByRole('switch', { name: 'Whitelist', exact: true })).toBeChecked();
    await screenshot(user, 'minecraft-players-running-desktop-en');
    await accessible();
    dialog = await choose('Kick player');
    await dialog.getByLabel('Reason (optional)', { exact: true }).fill('Browser test');
    await action(
      () => dialog.getByRole('button', { name: 'Kick player', exact: true }).click(),
      `kick ${player.name} Browser test`,
    );
    await browserExpect(
      user.getByText('Kick command sent. The player may reconnect.', { exact: true }),
    ).toBeVisible();
    // A dispatch receipt cannot prove that the game disconnected the player.
    await browserExpect(user.locator('.minecraft-player-role--online')).toHaveText('Online');
    dialog = await choose('Ban player');
    await dialog.getByLabel('Reason (optional)', { exact: true }).fill('Browser test');
    await action(
      () => dialog.getByRole('button', { name: 'Ban player', exact: true }).click(),
      `ban ${player.name} Browser test`,
    );
    await browserExpect(
      user.getByRole('button', { name: `Unban player: ${player.name}`, exact: true }),
    ).toBeEnabled();
    for (const [label, command, next] of [
      ['Unban player', `pardon ${player.name}`, 'Ban player'],
      ['Remove operator', `deop ${player.name}`, 'Make operator'],
      ['Remove from whitelist', `whitelist remove ${player.name}`, 'Add to whitelist'],
    ] as const) {
      dialog = await choose(label);
      await action(() => dialog.getByRole('button', { name: label, exact: true }).click(), command);
      await browserExpect(
        user.getByRole('button', { name: `${next}: ${player.name}`, exact: true }),
      ).toBeEnabled();
    }
    await user.getByRole('switch', { name: 'Whitelist', exact: true }).click();
    dialog = user.getByRole('dialog', { name: 'Disable whitelist', exact: true });
    await action(
      () => dialog.getByRole('button', { name: 'Disable whitelist', exact: true }).click(),
      'whitelist off',
    );
    await browserExpect(
      user.getByRole('switch', { name: 'Whitelist', exact: true }),
    ).not.toBeChecked();
  });

  it('keeps rejected and unconfirmed commands visible without inventing success', async () => {
    await running(true);
    await user.goto(route());
    let dialog = await choose('Make operator');
    rejectCommands = true;
    await action(
      () => dialog.getByRole('button', { name: 'Make operator', exact: true }).click(),
      null,
      403,
    );
    await browserExpect(dialog.getByRole('alert')).toBeVisible();
    expect(JSON.parse((await provider.files()).get('ops.json')?.toString() ?? 'null')).toEqual([]);
    await screenshot(user, 'minecraft-players-rejected-desktop-en');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    rejectCommands = false;
    confirmCommands = false;
    dialog = await choose('Make operator');
    await action(
      () => dialog.getByRole('button', { name: 'Make operator', exact: true }).click(),
      `op ${player.name}`,
      409,
    );
    await browserExpect(user.getByRole('dialog')).toHaveCount(0);
    await browserExpect(user.getByRole('alert')).toBeVisible();
    await browserExpect(
      user.getByRole('button', { name: `Make operator: ${player.name}`, exact: true }),
    ).toBeDisabled();
    await browserExpect(
      user.locator('.minecraft-player').getByText('Operator', { exact: true }),
    ).toHaveCount(0);
    await screenshot(user, 'minecraft-players-uncertain-desktop-en');
    await accessible();
    confirmCommands = true;
    const attempts = commands.length;
    // Model the provider persisting the original command late. Refresh must
    // unlock the controls from this evidence without resending the command.
    (await provider.files()).set(
      'ops.json',
      Buffer.from(
        JSON.stringify([{ name: player.name, uuid, level: 4, bypassesPlayerLimit: false }]),
      ),
    );
    await user.getByRole('button', { name: 'Refresh players', exact: true }).click();
    await browserExpect(
      user.getByRole('button', { name: `Remove operator: ${player.name}`, exact: true }),
    ).toBeEnabled();
    await browserExpect(user.getByRole('alert')).toHaveCount(0);
    expect(commands).toHaveLength(attempts);
  });

  it('distinguishes loading and unavailable online observations from an empty server', async () => {
    // The actual endpoint coalesces observations for five seconds. Let that
    // freshness window expire before holding a new provider observation.
    await delay(5100);
    let release = () => {};
    onlineGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await user.goto(route());
      await browserExpect(
        user.getByText('Checking online players…', { exact: true }),
      ).toBeVisible();
      await screenshot(user, 'minecraft-players-loading-desktop-en');
    } finally {
      release();
      onlineGate = undefined;
    }
    await browserExpect(user.locator('.minecraft-player')).toHaveCount(1);
    onlineUnavailable = true;
    try {
      await user.getByRole('button', { name: 'Refresh players', exact: true }).click();
      await browserExpect(
        user.getByText('Online players are unavailable. Saved lists are still shown.', {
          exact: true,
        }),
      ).toBeVisible({ timeout: 20_000 }); // Honor the real five-second cache and polling interval.
      await browserExpect(user.getByText('No players online.', { exact: true })).toHaveCount(0);
      await screenshot(user, 'minecraft-players-online-unavailable-desktop-en');
      await accessible();
    } finally {
      onlineUnavailable = false;
    }
  });

  it('preserves useful read-only lists and rejects mutation by a shared viewer', async () => {
    const project = await journeyRequest<{ id: string }>(fixture, user, '/v1/projects', {
      name: 'Player observers',
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
    await identities.peer.goto(route());
    await browserExpect(
      identities.peer.getByText('You have read-only access to players.', { exact: true }),
    ).toBeVisible();
    await browserExpect(
      identities.peer.getByRole('button', { name: 'Add player', exact: true }),
    ).toHaveCount(0);
    await browserExpect(identities.peer.locator('.minecraft-player-actions button')).toHaveCount(0);
    await browserExpect(
      identities.peer.getByRole('switch', { name: 'Whitelist', exact: true }),
    ).toBeDisabled();
    const before = commands.length;
    const denied = await identities.peer.request.post(`${fixture.origin}${api()}/players/actions`, {
      headers: { Origin: fixture.origin },
      data: { action: 'op', name: player.name },
    });
    expect(denied.status()).toBe(403);
    expect(commands).toHaveLength(before);
    await screenshot(identities.peer, 'minecraft-players-readonly-desktop-en');
    await accessible(identities.peer);
  });

  it('shows provider failures and unsupported versions without empty-list success', async () => {
    failFiles = true;
    await user.goto(route());
    await browserExpect(user.getByRole('alert')).toBeVisible();
    await browserExpect(
      user.getByText('No players in the saved lists.', { exact: true }),
    ).toHaveCount(0);
    await screenshot(user, 'minecraft-players-provider-error-desktop-en');
    failFiles = false;
    const db = fixture.database.db;
    const combination = await db
      .selectFrom('minecraft_combinations')
      .select('combination')
      .where('id', '=', provider.ids.choiceId)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('minecraft_combinations')
      .set({
        combination: JSON.stringify({
          ...(combination.combination as Record<string, unknown>),
          release: '1.6.4',
        }),
      })
      .where('id', '=', provider.ids.choiceId)
      .execute();
    try {
      await user.goto(route());
      await browserExpect(
        user.getByText('Player management is unavailable for this version.', { exact: true }),
      ).toBeVisible();
      await browserExpect(
        user.getByRole('button', { name: 'Add player', exact: true }),
      ).toHaveCount(0);
      await screenshot(user, 'minecraft-players-unsupported-desktop-en');
    } finally {
      await db
        .updateTable('minecraft_combinations')
        .set({ combination: JSON.stringify(combination.combination) })
        .where('id', '=', provider.ids.choiceId)
        .execute();
    }
  });

  it('renders localized mobile player controls without overflow', async () => {
    await journeyRequest(fixture, user, '/api/auth/update-user', { locale: 'it' });
    await user.evaluate(() => localStorage.setItem('nh.locale', 'it'));
    await user.setViewportSize({ width: 390, height: 844 });
    await user.goto(route());
    await browserExpect(
      user.getByRole('button', { name: 'Aggiungi giocatore', exact: true }),
    ).toBeVisible();
    await browserExpect(user.locator('.minecraft-player')).toHaveCount(1);
    await screenshot(user, 'minecraft-players-mobile-it');
    for (const width of [390, 320]) {
      await user.setViewportSize({ width, height: 844 });
      for (const selector of ['.minecraft-players-whitelist', '.minecraft-players-add']) {
        const bounds = await user.locator(selector).boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds?.x).toBeGreaterThanOrEqual(0);
        expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
      }
      await accessible();
    }
    await screenshot(user, 'minecraft-players-small-mobile-it');
    await user.setViewportSize({ width: 390, height: 844 });
    await user.getByRole('button', { name: 'Aggiungi giocatore', exact: true }).click();
    await browserExpect(user.getByLabel('Nome utente Minecraft', { exact: true })).toBeFocused();
    await screenshot(user, 'minecraft-players-add-mobile-it');
    await accessible();
    expect(pageErrors).toEqual([]);
  });
});
