import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as check, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import type { ContentHttp } from '../../../packages/content-providers/src/index.js';
import { createMinecraftModsService } from '../../../packages/server-management/src/minecraft-mods.js';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('Mods through the authenticated app, API, PostgreSQL and Fileman', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let root: string;
  let bytes: Buffer;
  const power: string[] = [];
  const json = vi.fn<ContentHttp['json']>(async (input) => {
    const pathname = new URL(input).pathname;
    const project = {
      id: 'copper',
      slug: 'copper',
      title: 'Copper Toolkit',
      description: 'Tools for a shared Minecraft world.',
      body: '# Copper Toolkit\nServer utilities.',
      project_type: 'mod',
      downloads: 1234,
      categories: ['utility'],
      environment: ['dedicated_server_only'],
    };
    if (pathname.endsWith('/search'))
      return {
        offset: 0,
        total_hits: 1,
        hits: [{ ...project, project_id: project.id, author: 'Fixture author' }],
      };
    if (pathname.endsWith('/project/copper')) return project;
    const version = {
      id: 'copper1',
      project_id: 'copper',
      name: 'Copper Toolkit 1.0',
      version_number: '1.0',
      game_versions: ['26.1'],
      loaders: ['fabric'],
      date_published: '2026-10-10T00:00:00Z',
      version_type: 'release',
      environment: 'dedicated_server_only',
      dependencies: [],
      files: [
        {
          url: 'https://cdn.modrinth.com/data/copper/copper.jar',
          filename: 'copper.jar',
          size: bytes.length,
          primary: true,
          hashes: { sha1: createHash('sha1').update(bytes).digest('hex') },
        },
      ],
    };
    if (pathname.endsWith('/project/copper/version')) return [version];
    if (pathname.endsWith('/version/copper1')) return version;
    throw new Error(`Unexpected isolated catalog request ${pathname}`);
  });
  const download = vi.fn<ContentHttp['download']>(async (_artifact, destination) => {
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  beforeAll(async () => {
    const zip = new ZipFile();
    zip.addBuffer(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          id: 'copper',
          version: '1.0',
          environment: 'server',
        }),
      ),
      'fabric.mod.json',
    );
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    bytes = Buffer.concat(chunks);
    fixture = await browserHarness({
      browser: 'firefox',
      minecraftContentHttp: { json, download },
    });
    const identities = await prepareJourneyIdentities(fixture);
    user = identities.user;
    root = await mkdtemp(resolve('mountdata/test-assets/mods-browser-'));
    Object.assign(fixture.env, {
      NH_CONTENT_SOURCE_ROOT: `./${relative(process.cwd(), root)}`,
      NH_CONTENT_SOURCE_FREE_BYTES: '0',
      NH_CONTENT_SOURCE_FREE_PERCENT: '0',
      NH_CONTENT_METADATA_USER_AGENT: 'NickHosting isolated Mods browser journey',
    });
    provider = await installBrowserFixtures(
      fixture.database,
      identities.ownerId,
      identities.userId,
      fixture.env,
      fixture.codec,
    );
    fixture.setManagement(provider.management);
    const db = fixture.database.db;
    await db
      .updateTable('runtime_egg_mappings')
      .set({ runtime_id: 'fabric' })
      .where('id', '=', provider.ids.mappingId)
      .execute();
    const profile = await db
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', provider.ids.serverId)
      .executeTakeFirstOrThrow();
    const combination = await db
      .selectFrom('minecraft_combinations')
      .selectAll()
      .where('id', '=', profile.combination_id)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('minecraft_combinations')
      .set({
        combination: JSON.stringify({
          ...(combination.combination as object),
          profile: 'fabric',
          loaderVersion: '0.18.0',
        }),
      })
      .where('id', '=', combination.id)
      .execute();
    await db
      .updateTable('managed_servers')
      .set({ runtime_state: 'running' })
      .where('id', '=', provider.ids.serverId)
      .execute();
    const originalPower = provider.adapter.power;
    provider.adapter.power = async (id, action) => {
      power.push(action);
      return originalPower(id, action);
    };
  });
  afterAll(async () => {
    if (fixture && provider)
      await createMinecraftModsService({
        db: fixture.database.db,
        env: fixture.env,
        runtime: provider.management,
      }).drain();
    provider?.dispose();
    await fixture?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('prepares and publishes a mod through the real handlers without a power command', async () => {
    await user.setViewportSize({ width: 1440, height: 1000 });
    await user.goto(`${fixture.origin}/servers/${provider.ids.serverId}/game/mods`);
    await check(user.getByRole('button', { name: /Copper Toolkit/ }).first()).toBeVisible({
      timeout: 10000,
    });
    await user
      .getByRole('button', { name: /Copper Toolkit/ })
      .first()
      .click();
    await check(user.locator('.mods-details')).toBeVisible();
    await check(user.locator('.mods-description')).toContainText('Server utilities.');
    await check(user.locator('.mods-project input[type="checkbox"]')).not.toBeChecked();
    await user.screenshot({
      path: resolve('docs/screenshots/m5/minecraft-mods-app-discover.png'),
      fullPage: true,
    });
    await user.locator('.mods-project input[type="checkbox"]').check();
    await user.getByRole('button', { name: 'Install (1)', exact: true }).click();
    await check(user.getByRole('button', { name: /^Apply$/ })).toBeEnabled({ timeout: 15000 });
    const files = await provider.files();
    expect(files.has('mods/copper.jar')).toBe(false);
    expect([...files.keys()].some((path) => path.endsWith('.jar.pending'))).toBe(true);
    await user.screenshot({
      path: resolve('docs/screenshots/m5/minecraft-mods-app-review.png'),
      fullPage: true,
    });
    await user.getByRole('button', { name: /^Apply$/ }).click();
    await check.poll(() => files.has('mods/copper.jar')).toBe(true);
    expect(files.get('mods/copper.jar')).toEqual(bytes);
    await check(user.locator('.mods-installed-row')).toContainText('Copper Toolkit');
    await user.getByRole('button', { name: 'Disable Copper Toolkit', exact: true }).click();
    await check(user.locator('.mods-installed-row')).toContainText('Disable');
    expect(files.has('mods/copper.jar')).toBe(true);
    await user
      .locator('.mods-installed-row')
      .getByRole('button', { name: /Remove/ })
      .click();
    await check(
      user.getByRole('button', { name: 'Disable Copper Toolkit', exact: true }),
    ).toBeVisible();
    expect(download).toHaveBeenCalledTimes(1);
    expect(power).toEqual([]);
    const activity = await journeyRequest<{ items: { action: string; outcome: string }[] }>(
      fixture,
      user,
      `/v1/platform/activity?serverId=${provider.ids.serverId}`,
    );
    expect(activity.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'minecraft.mods.applied', outcome: 'succeeded' }),
      ]),
    );
    expect(
      (
        await new AxeBuilder({ page: user })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await user.getByRole('link', { name: 'Console', exact: true }).click();
    await check(user.locator('.minecraft-mod-restart')).toContainText('Restart the server');
    expect(power).toEqual([]);
  });
});
