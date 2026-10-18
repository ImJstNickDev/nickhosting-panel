import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { DomainError } from '@nickhosting/core';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { browserLevelDat } from './minecraft-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

async function archive(files: Record<string, Buffer>) {
  const zip = new ZipFile();
  for (const [name, bytes] of Object.entries(files)) zip.addBuffer(bytes, name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('M5 Minecraft worlds through authorized APIs and durable provider jobs', () => {
  let fixture: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let identifier: string;
  let ownedDirectory: string;
  let failFiles = false;
  let readGate: Promise<void> | undefined;
  const pageErrors: string[] = [];
  const deletes: string[][] = [];
  const api = () => `/v1/servers/${provider.ids.serverId}/minecraft`;
  const route = () => `${fixture.origin}/servers/${provider.ids.serverId}/game/worlds`;

  beforeAll(async () => {
    fixture = await browserHarness();
    identities = await prepareJourneyIdentities(fixture);
    user = identities.user;
    for (const page of [user, identities.peer])
      page.on('pageerror', (error) => pageErrors.push(error.message));
    ownedDirectory = await mkdtemp(resolve('mountdata/m2-tests/m5-worlds-browser-'));
    const staging = `./${relative(process.cwd(), ownedDirectory)}`;
    await mkdir(`${ownedDirectory}/sources`);
    await mkdir(`${ownedDirectory}/expanded`);
    Object.assign(fixture.env, {
      NH_MINECRAFT_SOURCE_ROOT: `${staging}/sources`,
      NH_MINECRAFT_CONTENT_ROOT: `${staging}/expanded`,
    });
    vi.stubGlobal('fetch', async () => {
      throw new Error('Unexpected external request in isolated worlds browser fixture');
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
    const read = provider.adapter.readFile;
    provider.adapter.readFile = async (...args) => {
      await readGate;
      if (failFiles) throw new DomainError('integration_unavailable');
      return read(...args);
    };
    const remove = provider.adapter.deleteFiles;
    provider.adapter.deleteFiles = async (...args) => {
      deletes.push([...args[2]]);
      return remove(...args);
    };
  });
  afterAll(async () => {
    provider?.dispose();
    vi.unstubAllGlobals();
    await fixture?.close();
    if (ownedDirectory) await rm(ownedDirectory, { recursive: true, force: true });
  });
  beforeEach(async () => {
    failFiles = false;
    readGate = undefined;
    await running(false);
  });
  async function running(value: boolean) {
    await provider.adapter.power(identifier, value ? 'start' : 'stop');
    await fixture.database.db
      .updateTable('managed_servers')
      .set({ runtime_state: value ? 'running' : 'offline' })
      .where('id', '=', provider.ids.serverId)
      .execute();
  }
  async function operation(click: () => Promise<unknown>, expected = 'succeeded') {
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
    expect(job.state, JSON.stringify({ delivery, job })).toBe(expected);
    return job;
  }
  async function screenshot(page: Page, name: string) {
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
  async function importDialog(target: string, bytes?: Buffer) {
    await user.getByRole('button', { name: 'Import world', exact: true }).click();
    const dialog = user.getByRole('dialog', { name: 'Import world', exact: true });
    await dialog.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
      name: 'world.zip',
      mimeType: 'application/zip',
      buffer:
        bytes ??
        (await archive({
          'source/level.dat': browserLevelDat(),
          'source/data/browser.txt': Buffer.from('Isolated browser world'),
        })),
    });
    await browserExpect(
      dialog.getByText('World uploaded. Import it to add it to the server.', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await dialog.getByLabel('Folder name', { exact: true }).fill(target);
    return dialog;
  }
  async function choose(label: string, world: string) {
    await user.getByRole('button', { name: `${label}: ${world}`, exact: true }).click();
    const dialog = user.getByRole('dialog', { name: label, exact: true });
    await browserExpect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    return dialog;
  }

  it('imports, selects, downloads and removes a world only after confirmation', async () => {
    await user.goto(route());
    await browserExpect(
      user.getByRole('button', { name: 'Delete world: world', exact: true }),
    ).toBeDisabled();
    let dialog = await importDialog('imported');
    await operation(() =>
      dialog.getByRole('button', { name: 'Import world', exact: true }).click(),
    );
    await browserExpect(
      user.getByRole('button', { name: 'Select world: imported', exact: true }),
    ).toBeEnabled();
    expect((await provider.files()).get('imported/data/browser.txt')?.toString()).toBe(
      'Isolated browser world',
    );
    dialog = await choose('Select world', 'imported');
    await operation(() =>
      dialog.getByRole('button', { name: 'Select world', exact: true }).click(),
    );
    await browserExpect(
      user.getByRole('button', { name: 'Delete world: imported', exact: true }),
    ).toBeDisabled();
    expect((await provider.files()).get('server.properties')?.toString()).toContain(
      'level-name=imported',
    );
    await browserExpect(
      user
        .locator('.minecraft-world')
        .filter({ has: user.getByText('imported', { exact: true }) })
        .locator('.minecraft-world-selected'),
    ).toHaveText('Selected');
    await browserExpect(
      user.getByRole('button', { name: 'Import world', exact: true }),
    ).toBeEnabled();
    await screenshot(user, 'minecraft-worlds-desktop-en');
    await accessible();
    const requested = user
      .context()
      .waitForEvent('request', (request) => request.url().endsWith('/files/archive'));
    const downloaded = user.waitForEvent('download');
    await user.getByRole('button', { name: 'Download ZIP: imported', exact: true }).click();
    const request = await requested;
    const url = new URL(request.url());
    const fields = new URLSearchParams(request.postData() ?? '');
    expect(request.method()).toBe('POST');
    expect(url.pathname).toBe(`/v1/servers/${provider.ids.serverId}/files/archive`);
    expect(fields.get('root')).toBe('');
    expect(JSON.parse(fields.get('files') ?? 'null')).toEqual(['imported']);
    expect(await (await downloaded).failure()).toBeNull();
    dialog = await choose('Select world', 'world');
    await operation(() =>
      dialog.getByRole('button', { name: 'Select world', exact: true }).click(),
    );
    await browserExpect(
      user.getByRole('button', { name: 'Delete world: imported', exact: true }),
    ).toBeEnabled();
    dialog = await choose('Delete world', 'imported');
    expect((await provider.files()).has('imported/level.dat')).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await provider.files()).has('imported/level.dat')).toBe(true);
    dialog = await choose('Delete world', 'imported');
    await dialog.getByLabel('Create a verified backup first', { exact: true }).uncheck();
    await operation(() =>
      dialog.getByRole('button', { name: 'Delete world', exact: true }).click(),
    );
    await browserExpect(
      user.getByRole('button', { name: 'Delete world: imported', exact: true }),
    ).toHaveCount(0);
    expect((await provider.files()).has('imported/level.dat')).toBe(false);
    expect((await provider.files()).has('world/level.dat')).toBe(true);
  });

  it('retains existing world files when replacement is cancelled and backs up explicit replacement', async () => {
    await user.goto(route());
    let dialog = await importDialog('replacement');
    await operation(() =>
      dialog.getByRole('button', { name: 'Import world', exact: true }).click(),
    );
    await browserExpect(
      user.getByRole('button', { name: 'Select world: replacement', exact: true }),
    ).toBeEnabled();
    (await provider.files()).set(
      'replacement/data/original.txt',
      Buffer.from('Keep until explicit consent'),
    );
    dialog = await importDialog('replacement');
    const count = deletes.length;
    await dialog.getByRole('button', { name: 'Review replacement', exact: true }).click();
    dialog = user.getByRole('dialog', { name: 'Replace world', exact: true });
    await browserExpect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(deletes).toHaveLength(count);
    expect((await provider.files()).has('replacement/data/original.txt')).toBe(true);
    dialog = user.getByRole('dialog', { name: 'Import world', exact: true });
    await browserExpect(dialog.getByLabel('Folder name', { exact: true })).toHaveValue(
      'replacement',
    );
    await dialog.getByRole('button', { name: 'Review replacement', exact: true }).click();
    dialog = user.getByRole('dialog', { name: 'Replace world', exact: true });
    await browserExpect(
      dialog.getByLabel('Create a verified backup first', { exact: true }),
    ).toBeChecked();
    await screenshot(user, 'minecraft-worlds-replace-confirm-desktop-en');
    await operation(() =>
      dialog.getByRole('button', { name: 'Replace world', exact: true }).click(),
    );
    await browserExpect(user.getByRole('dialog')).toHaveCount(0);
    expect((await provider.files()).has('replacement/data/original.txt')).toBe(false);
    expect((await provider.files()).has('replacement/level.dat')).toBe(true);
    expect(await provider.adapter.listBackups(identifier)).toHaveLength(1);
    expect((await provider.files()).has('world/level.dat')).toBe(true);
  });

  it('reports an invalid world archive without creating a world', async () => {
    await user.goto(route());
    const dialog = await importDialog(
      'broken',
      await archive({ 'readme.txt': Buffer.from('No world data') }),
    );
    await operation(
      () => dialog.getByRole('button', { name: 'Import world', exact: true }).click(),
      'failed',
    );
    await browserExpect(
      user.getByRole('link', { name: 'View operation', exact: true }),
    ).toBeVisible();
    expect((await provider.files()).has('broken/level.dat')).toBe(false);
    await screenshot(user, 'minecraft-worlds-invalid-import-desktop-en');
  });

  it('imports new folders while running, rejects collisions and preserves a shared viewer inventory', async () => {
    await running(true);
    await user.goto(route());
    await browserExpect(
      user.getByRole('button', { name: 'Import world', exact: true }),
    ).toBeEnabled();
    await browserExpect(
      user.getByRole('button', { name: 'Delete world: world', exact: true }),
    ).toBeDisabled();
    const dialog = await importDialog('world');
    await browserExpect(
      dialog.getByText(
        'world already exists or is the active world. Choose a different folder name while the server is running.',
      ),
    ).toBeVisible();
    await browserExpect(
      dialog.getByRole('button', { name: 'Import world', exact: true }),
    ).toBeDisabled();
    await dialog.getByLabel('Folder name', { exact: true }).fill('live-import');
    await screenshot(user, 'minecraft-worlds-running-import-desktop-en');
    await operation(() =>
      dialog.getByRole('button', { name: 'Import world', exact: true }).click(),
    );
    await browserExpect(user.getByRole('dialog')).toHaveCount(0);
    await browserExpect(
      user.getByRole('button', { name: 'Delete world: live-import', exact: true }),
    ).toBeDisabled();
    expect((await provider.files()).has('live-import/level.dat')).toBe(true);
    expect((await provider.files()).get('server.properties')?.toString()).toContain(
      'level-name=world',
    );
    // The selected directory can be absent before Minecraft has generated it.
    const files = await provider.files();
    const original = files.get('server.properties');
    files.set('server.properties', Buffer.from('level-name=not-generated-yet\n'));
    try {
      await user.goto(route());
      const missingDialog = await importDialog('not-generated-yet');
      await browserExpect(
        missingDialog.getByRole('button', { name: 'Import world', exact: true }),
      ).toBeDisabled();
      await missingDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    } finally {
      if (original) files.set('server.properties', original);
    }
    await accessible();
    await running(false);
    const project = await journeyRequest<{ id: string }>(fixture, user, '/v1/projects', {
      name: 'World observers',
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
      identities.peer.getByText('You have read-only access to worlds.', { exact: true }),
    ).toBeVisible();
    await browserExpect(
      identities.peer.getByRole('button', { name: 'Import world', exact: true }),
    ).toHaveCount(0);
    await browserExpect(
      identities.peer.getByRole('button', { name: /^Select world: / }),
    ).toHaveCount(0);
    const denied = await identities.peer.request.post(`${fixture.origin}${api()}/operations`, {
      headers: { Origin: fixture.origin },
      data: {
        kind: 'world-select',
        world: 'replacement',
        idempotencyKey: 'viewer-world-selection',
      },
    });
    expect(denied.status()).toBe(403);
    await screenshot(identities.peer, 'minecraft-worlds-readonly-desktop-en');
    await accessible(identities.peer);
  });

  it('distinguishes loading and provider failure and uses version metadata without verification reports', async () => {
    let release = () => {};
    readGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await user.goto(route());
      await browserExpect(user.getByText('Loading…', { exact: true }).first()).toBeVisible();
      await screenshot(user, 'minecraft-worlds-loading-desktop-en');
    } finally {
      release();
      readGate = undefined;
    }
    await browserExpect(
      user.getByRole('button', { name: 'Select world: replacement', exact: true }),
    ).toBeEnabled();
    failFiles = true;
    await user.goto(route());
    await browserExpect(user.getByRole('alert')).toBeVisible();
    await browserExpect(user.getByText('No saved worlds found.', { exact: true })).toHaveCount(0);
    await screenshot(user, 'minecraft-worlds-provider-error-desktop-en');
    failFiles = false;
    const evidence = await fixture.database.db
      .selectFrom('minecraft_verification_evidence')
      .selectAll()
      .where('combination_id', '=', provider.ids.choiceId)
      .execute();
    await fixture.database.db
      .deleteFrom('minecraft_verification_evidence')
      .where('combination_id', '=', provider.ids.choiceId)
      .execute();
    try {
      await user.goto(route());
      await browserExpect(
        user.getByRole('button', { name: 'Import world', exact: true }),
      ).toBeEnabled();
      await browserExpect(
        user.getByRole('button', { name: 'Select world: replacement', exact: true }),
      ).toBeEnabled();
      await screenshot(user, 'minecraft-worlds-version-metadata-desktop-en');
      await accessible();
    } finally {
      for (const row of evidence)
        await fixture.database.db
          .insertInto('minecraft_verification_evidence')
          .values({ ...row, report: JSON.stringify(row.report) })
          .execute();
    }
  });

  it('shows an empty inventory honestly and cancels an upload without importing', async () => {
    const files = await provider.files();
    const levels = [...files].filter(([path]) => path.endsWith('/level.dat'));
    for (const [path] of levels) files.delete(path);
    try {
      await user.goto(route());
      await browserExpect(user.getByText('No saved worlds found.', { exact: true })).toBeVisible();
      await screenshot(user, 'minecraft-worlds-empty-desktop-en');
      await accessible();
    } finally {
      for (const [path, bytes] of levels) files.set(path, bytes);
    }
    await user.goto(route());
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const uploadRoute = `${fixture.origin}/v1/minecraft/sources/*/upload`;
    await user.route(uploadRoute, async (request) => {
      await gate;
      await request.abort();
    });
    try {
      await user.getByRole('button', { name: 'Import world', exact: true }).click();
      const dialog = user.getByRole('dialog', { name: 'Import world', exact: true });
      const uploadStarted = user.waitForRequest((request) =>
        /\/v1\/minecraft\/sources\/[^/]+\/upload$/.test(request.url()),
      );
      await dialog.locator('input[type=file]:not([webkitdirectory])').setInputFiles({
        name: 'cancel.zip',
        mimeType: 'application/zip',
        buffer: await archive({ 'level.dat': browserLevelDat() }),
      });
      await uploadStarted;
      await browserExpect(
        dialog.getByRole('button', { name: 'Cancel upload', exact: true }),
      ).toBeVisible();
      await screenshot(user, 'minecraft-worlds-upload-progress-desktop-en');
      await dialog.getByRole('button', { name: 'Cancel upload', exact: true }).click();
      release();
      await browserExpect(
        dialog.getByText('Upload cancelled. Choose the ZIP or folder again to continue.', {
          exact: true,
        }),
      ).toBeVisible();
      await browserExpect(
        dialog.getByRole('button', { name: 'Import world', exact: true }),
      ).toBeDisabled();
      expect(files.has('cancel/level.dat')).toBe(false);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    } finally {
      release();
      await user.unroute(uploadRoute);
    }
  });

  it('recovers a lost response with the same request without repeating the provider effect', async () => {
    if (!(await provider.files()).has('replacement/level.dat')) {
      await provider.adapter.createDirectory(identifier, '', 'replacement');
      (await provider.files()).set('replacement/level.dat', browserLevelDat());
    }
    await user.goto(route());
    const requests: unknown[] = [];
    let acceptedJob = '';
    const jobsBefore = await fixture.database.db
      .selectFrom('server_operations')
      .select('job_id')
      .where('server_id', '=', provider.ids.serverId)
      .execute();
    let writes = 0;
    const write = provider.adapter.writeFile;
    provider.adapter.writeFile = async (...args) => {
      if (args[1] === 'server.properties') writes++;
      return write(...args);
    };
    const endpoint = `${fixture.origin}${api()}/operations`;
    await user.route(endpoint, async (intercept) => {
      requests.push(intercept.request().postDataJSON());
      if (requests.length !== 1) return intercept.continue();
      // Lose only the browser response after the actual authorized endpoint and
      // worker have persisted their result. Recovery must reuse its identity.
      const response = await intercept.fetch();
      expect(response.status()).toBe(202);
      acceptedJob = ((await response.json()) as { jobId: string }).jobId;
      await provider.processPending();
      await intercept.abort('connectionreset');
    });
    try {
      const dialog = await choose('Select world', 'replacement');
      await dialog.getByRole('button', { name: 'Select world', exact: true }).click();
      await browserExpect(
        user.getByRole('button', { name: 'Recover request', exact: true }),
      ).toBeVisible();
      await browserExpect(
        user.getByRole('button', { name: 'Import world', exact: true }),
      ).toBeDisabled();
      expect(writes).toBe(1);
      await screenshot(user, 'minecraft-worlds-uncertain-desktop-en');
      await accessible();
      failFiles = true;
      const failedRefresh = user.waitForResponse(
        (response) => response.url().endsWith(`${api()}/worlds`) && response.status() === 503,
      );
      await user.getByRole('button', { name: 'Refresh worlds', exact: true }).click();
      await failedRefresh;
      await browserExpect(
        user.getByRole('button', { name: 'Recover request', exact: true }),
      ).toBeDisabled();
      expect(requests).toHaveLength(1);
      failFiles = false;
      await user.getByRole('button', { name: 'Refresh worlds', exact: true }).click();
      await browserExpect(
        user.getByRole('button', { name: 'Recover request', exact: true }),
      ).toBeEnabled();
      expect(requests).toHaveLength(1);
      const serverEndpoint = `${fixture.origin}/v1/platform/servers/${provider.ids.serverId}`;
      await user.route(serverEndpoint, async (intercept) =>
        intercept.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'integration_unavailable',
              messageKey: 'errors.integration_unavailable',
            },
          }),
        }),
      );
      try {
        const failedServer = user.waitForResponse(
          (response) => response.url() === serverEndpoint && response.status() === 503,
          { timeout: 20_000 },
        );
        await failedServer; // Exercise the shared server observation's real polling interval.
        await browserExpect(
          user.getByRole('button', { name: 'Recover request', exact: true }),
        ).toBeDisabled();
        expect(requests).toHaveLength(1);
      } finally {
        await user.unroute(serverEndpoint);
      }
      const restoredServer = user.waitForResponse(
        (response) => response.url() === serverEndpoint && response.status() === 200,
      );
      await user.getByRole('button', { name: 'Try again', exact: true }).first().click();
      await restoredServer;
      await browserExpect(
        user.getByRole('button', { name: 'Recover request', exact: true }),
      ).toBeEnabled();
      await user.getByRole('button', { name: 'Recover request', exact: true }).click();
      await browserExpect(
        user.getByRole('button', { name: 'Recover request', exact: true }),
      ).toHaveCount(0);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(writes).toBe(1);
      const job = await fixture.database.db
        .selectFrom('operation_jobs')
        .select('state')
        .where('id', '=', acceptedJob)
        .executeTakeFirstOrThrow();
      expect(job.state).toBe('succeeded');
      const jobsAfter = await fixture.database.db
        .selectFrom('server_operations')
        .select('job_id')
        .where('server_id', '=', provider.ids.serverId)
        .execute();
      expect(jobsAfter).toHaveLength(jobsBefore.length + 1);
    } finally {
      await user.unroute(endpoint);
      provider.adapter.writeFile = write;
    }
  });

  it('imports a selected world folder with nested files while running through the existing world job', async () => {
    const directory = resolve(ownedDirectory, 'folder-world');
    await mkdir(resolve(directory, 'region'), { recursive: true });
    await mkdir(resolve(directory, 'data/nested'), { recursive: true });
    await writeFile(resolve(directory, 'level.dat'), browserLevelDat());
    await writeFile(resolve(directory, 'region/r.0.0.mca'), Buffer.from([0, 1, 2, 255]));
    await writeFile(resolve(directory, 'data/nested/note.txt'), 'Folder import fixture');
    await running(true);
    await user.goto(route());
    await user.getByRole('button', { name: 'Import world', exact: true }).click();
    const dialog = user.getByRole('dialog', { name: 'Import world', exact: true });
    await dialog.locator('input[webkitdirectory]').setInputFiles(directory);
    await browserExpect(
      dialog.getByText('World uploaded. Import it to add it to the server.', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await browserExpect(dialog.getByLabel('Folder name', { exact: true })).toHaveValue(
      'folder-world',
    );
    await screenshot(user, 'minecraft-worlds-folder-import-desktop-en');
    await accessible();
    const selectedBefore = (await provider.files()).get('server.properties')?.toString();
    await operation(() =>
      dialog.getByRole('button', { name: 'Import world', exact: true }).click(),
    );
    await browserExpect(user.getByRole('dialog')).toHaveCount(0);
    const files = await provider.files();
    expect(files.get('folder-world/data/nested/note.txt')?.toString()).toBe(
      'Folder import fixture',
    );
    expect(files.get('folder-world/region/r.0.0.mca')).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(files.get('folder-world/level.dat')).toEqual(browserLevelDat());
    expect(files.get('server.properties')?.toString()).toBe(selectedBefore);
    expect(files.has('folder-world/folder-world/level.dat')).toBe(false);
  });

  it('rejects a folder without level.dat before uploading or requesting an operation', async () => {
    const directory = resolve(ownedDirectory, 'not-a-world');
    await mkdir(directory);
    await writeFile(resolve(directory, 'readme.txt'), 'Not a world');
    await user.goto(route());
    await user.getByRole('button', { name: 'Import world', exact: true }).click();
    const dialog = user.getByRole('dialog', { name: 'Import world', exact: true });
    const writes: string[] = [];
    const reserved = (request: import('@playwright/test').Request) => {
      if (
        request.method() === 'POST' &&
        (request.url().includes('/v1/minecraft/sources') ||
          request.url().endsWith(`${api()}/operations`))
      )
        writes.push(request.url());
    };
    user.on('request', reserved);
    try {
      await dialog.locator('input[webkitdirectory]').setInputFiles(directory);
      await browserExpect(dialog.getByRole('alert')).toContainText(
        'Choose the world folder containing level.dat.',
      );
      await browserExpect(
        dialog.getByRole('button', { name: 'Import world', exact: true }),
      ).toBeDisabled();
      expect(writes).toEqual([]);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    } finally {
      user.off('request', reserved);
    }
    expect(pageErrors).toEqual([]);
  });

  it('renders Italian mobile worlds and import controls without overflow', async () => {
    await journeyRequest(fixture, user, '/api/auth/update-user', { locale: 'it' });
    const localizedSession = await journeyRequest<{ subject: { locale: string } }>(
      fixture,
      user,
      '/v1/web/session',
    );
    expect(localizedSession.subject.locale).toBe('it');
    await user.goto(fixture.origin);
    // Let the shell apply the persisted session locale before navigating again.
    await browserExpect(user.locator('html')).toHaveAttribute('lang', 'it');
    await user.goto(route());
    for (const width of [390, 320]) {
      await user.setViewportSize({ width, height: 844 });
      await browserExpect(
        user.getByRole('button', { name: 'Importa mondo', exact: true }),
      ).toBeVisible();
      await accessible();
      await screenshot(user, `minecraft-worlds-${width}-mobile-it`);
    }
    await user.getByRole('button', { name: 'Importa mondo', exact: true }).click();
    await browserExpect(user.getByRole('dialog')).toBeVisible();
    await browserExpect(
      user.getByRole('button', { name: 'Scegli cartella', exact: true }),
    ).toBeVisible();
    await screenshot(user, 'minecraft-worlds-import-mobile-it');
    await accessible();
    expect(pageErrors).toEqual([]);
  });
});
