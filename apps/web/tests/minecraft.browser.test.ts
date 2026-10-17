import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { parseMinecraftProperties } from '@nickhosting/minecraft';
import { expect as browserExpect, type Locator, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { browserMinecraft } from './minecraft-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

async function archive(files: Record<string, Buffer>) {
  const zip = new ZipFile();
  for (const [name, bytes] of Object.entries(files)) zip.addBuffer(bytes, name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('M5 Minecraft browser management through actual API and durable jobs', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let base: string;
  let ownedDirectory: string;
  const pageErrors: string[] = [];
  beforeAll(async () => {
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
    user = identities.user;
    user.on('pageerror', (error) => pageErrors.push(error.message));
    identities.owner.on('pageerror', (error) => pageErrors.push(error.message));
    ownedDirectory = await mkdtemp(resolve('mountdata/m2-tests/m5-minecraft-browser-'));
    const staging = `./${relative(process.cwd(), ownedDirectory)}`;
    await mkdir(`${ownedDirectory}/sources`);
    await mkdir(`${ownedDirectory}/expanded`);
    Object.assign(fixture.env, {
      NH_MINECRAFT_SOURCE_ROOT: `${staging}/sources`,
      NH_MINECRAFT_CONTENT_ROOT: `${staging}/expanded`,
    });
    vi.stubGlobal('fetch', async () => {
      throw new Error('Unexpected external request in isolated Minecraft browser fixture');
    });
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
    base = `${fixture.origin}/servers/${provider.ids.serverId}/game`;
  });
  afterAll(async () => {
    provider?.dispose();
    vi.unstubAllGlobals();
    await fixture?.close();
    if (ownedDirectory) await rm(ownedDirectory, { recursive: true, force: true });
  });
  function section(title: string, page = user) {
    return page.locator('section').filter({
      has: page.getByRole('heading', { name: title, exact: true }),
    });
  }
  async function operation(click: () => Promise<unknown>, beforeDelivery?: () => Promise<void>) {
    const response = user.waitForResponse(
      (result) =>
        result.request().method() === 'POST' &&
        result.url().endsWith(`/v1/servers/${provider.ids.serverId}/minecraft/operations`),
    );
    await click();
    const result = await response;
    expect(result.status(), await result.text()).toBe(202);
    const accepted = (await result.json()) as { jobId: string };
    await beforeDelivery?.();
    const delivery = await provider.processPending();
    const job = await fixture.database.db
      .selectFrom('operation_jobs')
      .select(['state', 'error_code'])
      .where('id', '=', accepted.jobId)
      .executeTakeFirstOrThrow();
    expect(job, JSON.stringify(delivery)).toEqual({ state: 'succeeded', error_code: null });
    return accepted.jobId;
  }
  async function upload(input: Locator, name: string, bytes: Buffer, form: Locator) {
    await input.setInputFiles({ name, mimeType: 'application/zip', buffer: bytes });
    await browserExpect(form.getByText('Upload verified', { exact: true })).toBeVisible({
      timeout: 15000,
    });
  }
  async function accessible(page: Page) {
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map((value) => ({ id: value.id, nodes: value.nodes.map((n) => n.target) })),
    ).toEqual([]);
  }

  it('renders evidence-supported properties and persists their real operation result', async () => {
    const files = await provider.files();
    files.set(
      'server.properties',
      Buffer.concat([
        files.get('server.properties') ?? Buffer.alloc(0),
        Buffer.from(
          '\nrcon.password=isolated-browser-hidden-secret\nserver-port=25565\nonline-mode=true\n',
        ),
      ]),
    );
    const profile = await journeyRequest<{ effectiveProperties: Record<string, string> }>(
      fixture,
      user,
      `/v1/servers/${provider.ids.serverId}/minecraft`,
    );
    expect(profile.effectiveProperties).toMatchObject({ pvp: 'true', 'max-players': '20' });
    expect(profile.effectiveProperties).not.toHaveProperty('rcon.password');
    expect(profile.effectiveProperties).not.toHaveProperty('server-port');
    expect(profile.effectiveProperties).not.toHaveProperty('online-mode');
    expect(JSON.stringify(profile)).not.toContain('isolated-browser-hidden-secret');
    await user.goto(`${base}/properties`);
    const form = user.getByRole('form', { name: 'Server properties' });
    await browserExpect(
      form.getByRole('textbox', { name: 'Server description', exact: true }),
    ).toBeVisible();
    await browserExpect(form.getByLabel('Player combat', { exact: true })).toBeChecked();
    await browserExpect(form.getByLabel('Player limit', { exact: true })).toHaveValue('20');
    await browserExpect(form.getByLabel('Allow flying', { exact: true })).toHaveCount(0);
    await form
      .getByRole('textbox', { name: 'Server description', exact: true })
      .fill('Weekend survival');
    await form.getByRole('radio', { name: 'Hard', exact: true }).press('Space');
    await form.getByLabel('Player limit', { exact: true }).fill('8');
    await operation(() => form.getByRole('button', { name: 'Save changes', exact: true }).click());
    const content = parseMinecraftProperties(
      (await provider.files()).get('server.properties')?.toString() ?? '',
    );
    expect(content).toMatchObject({
      motd: 'Weekend survival',
      difficulty: 'hard',
      'max-players': '8',
    });
    await browserExpect(
      form.getByRole('textbox', { name: 'Server description', exact: true }),
    ).toHaveText('Weekend survival');
    await browserExpect(
      form.getByRole('button', { name: 'Save changes', exact: true }),
    ).toHaveCount(0);
    await fixture.screenshot(user, 'minecraft-properties-desktop-en');
    await accessible(user);
  });

  it('keeps Vanilla mod controls absent and verifies explicit modpack replacement with a backup', async () => {
    await user.goto(`${base}/content`);
    await browserExpect(section('Remove content')).toHaveCount(0);
    await operation(() =>
      section('Verify installation')
        .getByRole('button', { name: 'Verify installation', exact: true })
        .click(),
    );
    await browserExpect(
      section('Verify installation').getByRole('button', {
        name: 'Verify installation',
        exact: true,
      }),
    ).toBeEnabled();
    const pack = await archive({
      'modrinth.index.json': Buffer.from(
        JSON.stringify({
          formatVersion: 1,
          game: 'minecraft',
          name: 'Isolated Vanilla fixture',
          versionId: 'browser-1',
          dependencies: { minecraft: browserMinecraft.release },
          files: [],
        }),
      ),
      'server-overrides/config/browser.properties': Buffer.from('fixture=true\n'),
    });
    const replace = section('Replace modpack');
    await upload(
      replace.getByLabel('Verified upload', { exact: true }),
      'vanilla.mrpack',
      pack,
      replace,
    );
    await replace.getByRole('button', { name: 'Paths to delete', exact: true }).click();
    await browserExpect(replace.locator('code').filter({ hasText: /^world$/ })).toBeVisible();
    await replace.getByLabel('Delete the listed content and worlds', { exact: true }).check();
    await replace.getByRole('button', { name: 'Replace modpack', exact: true }).click();
    const dialog = user.getByRole('dialog');
    await browserExpect(dialog).toContainText(
      'A backup must finish before deletion when requested.',
    );
    expect((await provider.files()).has('world/level.dat')).toBe(true);
    await fixture.screenshot(user, 'minecraft-replacement-confirm-desktop-en');
    await operation(() =>
      dialog.getByRole('button', { name: 'Replace modpack', exact: true }).click(),
    );
    const files = await provider.files();
    expect(files.get('config/browser.properties')?.toString()).toBe('fixture=true\n');
    expect(files.has('world/level.dat')).toBe(false);
    expect(files.get('server.jar')).toEqual(browserMinecraft.serverJar);
    const server = await fixture.database.db
      .selectFrom('managed_servers')
      .select('pterodactyl_identifier')
      .where('id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    expect(await provider.adapter.listBackups(server.pterodactyl_identifier ?? '')).toHaveLength(1);
    await browserExpect(
      section('Verify installation').getByRole('button', {
        name: 'Verify installation',
        exact: true,
      }),
    ).toBeVisible();
    await browserExpect(
      user.getByRole('cell', { name: 'config/browser.properties', exact: true }),
    ).toBeVisible();
    await browserExpect(
      section('Verify installation').getByRole('button', {
        name: 'Verify installation',
        exact: true,
      }),
    ).toBeEnabled();
    await fixture.screenshot(user, 'minecraft-content-desktop-en');
  });

  it('keeps compatibility evidence Owner-only and renders Italian management on mobile', async () => {
    expect(
      (await user.request.get(`${fixture.origin}/v1/owner/minecraft/compatibility`)).status(),
    ).toBe(403);
    expect(
      (
        await identities.peer.request.get(
          `${fixture.origin}/v1/servers/${provider.ids.serverId}/minecraft`,
        )
      ).status(),
    ).toBe(403);
    await identities.owner.goto(`${fixture.origin}/owner/integrations/minecraft/versions`);
    await browserExpect(
      identities.owner.getByRole('heading', { name: 'Minecraft', exact: true }),
    ).toBeVisible();
    await browserExpect(
      identities.owner.getByRole('cell').filter({
        has: identities.owner.getByText(browserMinecraft.release, { exact: true }),
      }),
    ).toBeVisible();
    await fixture.screenshot(identities.owner, 'owner-minecraft-desktop-en');
    await accessible(identities.owner);
    await journeyRequest(fixture, user, '/api/auth/update-user', { locale: 'it' });
    await user.goto(fixture.origin);
    await user.evaluate(() => localStorage.setItem('nh.locale', 'it'));
    await user.setViewportSize({ width: 390, height: 844 });
    await user.goto(`${base}/properties`);
    await browserExpect(
      user.getByRole('form', { name: 'Proprietà del server', exact: true }),
    ).toBeVisible();
    expect(
      await user.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await fixture.screenshot(user, 'minecraft-properties-mobile-it');
    await accessible(user);
    expect(pageErrors).toEqual([]);
  });
});
