import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect as browserExpect, type Page, type Route } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 uploads coalesce display refreshes without delaying file writes', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let base: string;
  let endpoint: string;
  const stage = resolve(`mountdata/test-assets/upload-refresh-${randomUUID()}`);
  const listings: string[] = [];
  const uploads: { path: string; overwrite: string | null }[] = [];
  const errors: string[] = [];

  beforeAll(async () => {
    harness = await browserHarness();
    const identities = await prepareJourneyIdentities(harness);
    user = identities.user;
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    endpoint = `/v1/servers/${provider.ids.serverId}/files`;
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    user.on('pageerror', (error) => errors.push(error.message));
    user.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === endpoint && request.method() === 'GET')
        listings.push(url.searchParams.get('path') ?? '');
      if (url.pathname === `${endpoint}/upload` && request.method() === 'PUT')
        uploads.push({
          path: url.searchParams.get('path') ?? '',
          overwrite: url.searchParams.get('overwrite'),
        });
    });
  });
  afterEach(async () => {
    await user.unrouteAll({ behavior: 'ignoreErrors' });
    await user.goto(`${harness.origin}/servers`);
    // Each case starts with a fresh tab preference, independent of saved folders.
    await user.evaluate(() => sessionStorage.clear());
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
    await rm(stage, { recursive: true, force: true });
  });
  function batch(prefix: string, count: number) {
    return Array.from({ length: count }, (_, index) => ({
      name: `${prefix}-${String(index + 1).padStart(2, '0')}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(`contents ${index + 1}`),
    }));
  }
  const queue = () => user.locator('.fm-uploads');
  const entry = (name: string) =>
    user.locator('.fm-entry').filter({ has: user.getByRole('button', { name, exact: true }) });
  const isListing = (url: URL) => url.pathname === endpoint;
  async function open() {
    await user.goto(base);
    await browserExpect(entry('world')).toBeVisible();
    await browserExpect(user.getByRole('button', { name: 'Upload', exact: true })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    listings.length = 0;
    uploads.length = 0;
  }
  async function choose(files: ReturnType<typeof batch>) {
    await user.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(files);
  }
  async function completed(files: ReturnType<typeof batch>, directory = '') {
    await browserExpect
      .poll(
        async () => {
          const remote = await provider.files();
          return files.every((file) => remote.get(`${directory}${file.name}`)?.equals(file.buffer));
        },
        { timeout: 30000 },
      )
      .toBe(true);
  }

  async function holdFirstListing() {
    let held: { route: Route; body: unknown } | undefined;
    let claimed = false;
    await user.route(isListing, async (route) => {
      if (route.request().method() !== 'GET' || claimed) return route.continue();
      claimed = true;
      // Capture an actual old listing, then delay delivery to the browser.
      const response = await route.fetch();
      held = { route, body: await response.json() };
    });
    return {
      ready: () => Boolean(held),
      async release() {
        if (held) await held.route.fulfill({ json: held.body }).catch(() => {});
      },
    };
  }

  it.each(['', 'world'])(
    'uploads a deleted filename again without replacement consent in folder "%s"',
    async (directory) => {
      await open();
      if (directory) {
        await entry(directory).getByRole('button', { name: directory, exact: true }).click();
        await browserExpect(entry('level.dat')).toBeVisible();
      }
      const files = batch(`reupload-${directory || 'root'}`, 1);
      const file = files[0];
      if (!file) throw new Error('Missing upload fixture');
      const name = file.name;
      const prefix = directory ? `${directory}/` : '';
      await choose(files);
      await completed(files, prefix);
      await browserExpect(queue()).toHaveCount(0);
      await browserExpect(entry(name)).toBeVisible();
      await entry(name)
        .getByRole('button', { name: `Actions for ${name}`, exact: true })
        .click();
      await user.getByRole('menuitem', { name: 'Delete', exact: true }).click();
      await user.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await browserExpect(user.getByRole('dialog')).toHaveCount(0);
      await browserExpect(entry(name)).toHaveCount(0);
      expect((await provider.files()).has(`${prefix}${name}`)).toBe(false);

      const replacement = [{ ...file, buffer: Buffer.from('Uploaded after deletion') }];
      await choose(replacement);
      await completed(replacement, prefix);
      await browserExpect(queue()).toHaveCount(0);
      await browserExpect(user.getByRole('dialog')).toHaveCount(0);
      await browserExpect(entry(name)).toBeVisible();
      expect(uploads).toEqual([
        { path: `${prefix}${name}`, overwrite: null },
        { path: `${prefix}${name}`, overwrite: null },
      ]);
    },
  );

  it('restores the current nested folder after reload and remembers returning to root', async () => {
    await journeyRequest(harness, user, endpoint, {
      action: 'mkdir',
      root: 'world',
      name: 'remembered-folder',
    });
    (await provider.files()).set('world/remembered-folder/nested.txt', Buffer.from('Nested file'));
    await open();
    await entry('world').getByRole('button', { name: 'world', exact: true }).click();
    await entry('remembered-folder')
      .getByRole('button', { name: 'remembered-folder', exact: true })
      .click();
    await browserExpect(entry('nested.txt')).toBeVisible();
    await user.reload();
    await browserExpect(entry('nested.txt')).toBeVisible();
    await browserExpect(entry('world')).toHaveCount(0);
    await browserExpect(user.getByRole('navigation', { name: 'File location' })).toContainText(
      'remembered-folder',
    );
    await user.locator('.fm-breadcrumb').getByRole('button', { name: 'root', exact: true }).click();
    await browserExpect(entry('world')).toBeVisible();
    await user.reload();
    await browserExpect(entry('world')).toBeVisible();
    await browserExpect(entry('nested.txt')).toHaveCount(0);
    await browserExpect(user.getByRole('navigation', { name: 'File location' })).not.toContainText(
      'remembered-folder',
    );
  });

  it('returns to root after leaving Files, including browser Back, but keeps cancelled navigation', async () => {
    (await provider.files()).set('world/navigation.txt', Buffer.from('Keep this draft'));
    await open();
    const tabs = user.locator('.tabs');
    const openWorld = async () => {
      await entry('world').getByRole('button', { name: 'world', exact: true }).click();
      await browserExpect(entry('level.dat')).toBeVisible();
    };
    await openWorld();
    await tabs.getByRole('link', { name: 'Console', exact: true }).click();
    await browserExpect(user).toHaveURL(base.replace(/\/files$/, '/console'));
    await tabs.getByRole('link', { name: 'Files', exact: true }).click();
    await browserExpect(entry('world')).toBeVisible();
    await browserExpect(entry('level.dat')).toHaveCount(0);

    await openWorld();
    await tabs.getByRole('link', { name: 'Status', exact: true }).click();
    await browserExpect(user).toHaveURL(base.replace(/\/files$/, '/status'));
    await browserExpect(user.locator('.file-manager')).toHaveCount(0);
    await user.goBack();
    await browserExpect(entry('world')).toBeVisible();
    await browserExpect(entry('level.dat')).toHaveCount(0);

    await openWorld();
    await entry('navigation.txt')
      .getByRole('button', { name: 'navigation.txt', exact: true })
      .click();
    const editor = user.locator('.cm-content');
    await browserExpect(editor).toBeVisible();
    await editor.fill('Unsaved text');
    await browserExpect(
      user.getByRole('button', { name: 'Save changes', exact: true }),
    ).toBeEnabled();
    const cancelled = user.waitForEvent('dialog');
    user.once('dialog', (dialog) => dialog.dismiss());
    await tabs.getByRole('link', { name: 'Console', exact: true }).click();
    await cancelled;
    await browserExpect(user).toHaveURL(base);
    await browserExpect(editor).toHaveText('Unsaved text');
    await browserExpect(user.getByRole('navigation', { name: 'File location' })).toContainText(
      'world',
    );
    user.once('dialog', (dialog) => dialog.accept());
    await tabs.getByRole('link', { name: 'Console', exact: true }).click();
    await browserExpect(user).toHaveURL(base.replace(/\/files$/, '/console'));
    await tabs.getByRole('link', { name: 'Files', exact: true }).click();
    await browserExpect(entry('world')).toBeVisible();
  });

  it('shows the saved listing during reload and reconciles changed entries without replacing unchanged rows', async () => {
    const remote = await provider.files();
    remote.set('world/cache-keep.txt', Buffer.from('Unchanged'));
    remote.set('world/cache-remove.txt', Buffer.from('Removed later'));
    remote.set('world/cache-change.txt', Buffer.from('Old'));
    await open();
    await entry('world').getByRole('button', { name: 'world', exact: true }).click();
    await browserExpect(entry('cache-keep.txt')).toBeVisible();
    const oldSize = await entry('cache-change.txt').locator('.fm-size').textContent();
    remote.delete('world/cache-remove.txt');
    remote.set('world/cache-new.txt', Buffer.from('Added later'));
    remote.set('world/cache-change.txt', Buffer.alloc(2048, 'x'));
    let requested = false;
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await user.route(isListing, async (route) => {
      requested = true;
      await pending;
      await route.continue().catch(() => {});
    });
    try {
      await user.reload();
      await browserExpect.poll(() => requested).toBe(true);
      await browserExpect(entry('cache-keep.txt')).toBeVisible();
      await browserExpect(entry('cache-remove.txt')).toBeVisible();
      await browserExpect(entry('cache-new.txt')).toHaveCount(0);
      await browserExpect(entry('cache-change.txt').locator('.fm-size')).toHaveText(oldSize ?? '');
      await browserExpect(user.locator('.fm-loading')).toHaveCount(0);
      const unchangedRow = await entry('cache-keep.txt').elementHandle();
      expect(unchangedRow).not.toBeNull();
      release();
      await browserExpect(entry('cache-new.txt')).toBeVisible();
      await browserExpect(entry('cache-remove.txt')).toHaveCount(0);
      await browserExpect(entry('cache-change.txt').locator('.fm-size')).not.toHaveText(
        oldSize ?? '',
      );
      expect(await unchangedRow?.evaluate((row) => row.isConnected)).toBe(true);
    } finally {
      release();
    }
  });

  it('finishes 49 parallel uploads while one listing is held and follows it with a fresh final listing', async () => {
    await open();
    const files = batch('coalesced', 49);
    const listing = await holdFirstListing();
    try {
      await choose(files);
      await browserExpect.poll(listing.ready).toBe(true);
      await completed(files);
      await browserExpect(queue()).toHaveCount(0);
      expect(uploads).toHaveLength(49);
      // No second listing starts while the first is in flight, and writes continue.
      expect(listings).toEqual(['']);
      // Completed rows disappear, but a stale listing must not bypass replacement consent.
      await choose(files.slice(0, 1));
      await browserExpect(user.getByRole('dialog')).toContainText('Existing content will be lost');
      await user.keyboard.press('Escape');
      expect(uploads).toHaveLength(49);
      await listing.release();
      await browserExpect(entry('coalesced-49.txt')).toHaveCount(1);
      expect(listings).toEqual(['', '']);
      await browserExpect(queue().getByText('Failed', { exact: true })).toHaveCount(0);
      const remote = await provider.files();
      for (const file of files) expect(remote.get(file.name)).toEqual(file.buffer);
      expect(uploads.every((request) => request.overwrite === null)).toBe(true);
    } finally {
      await listing.release();
    }
  });

  it('keeps confirmed uploads complete when display listings fail and recovers through the list retry', async () => {
    await open();
    const files = batch('display-error', 6);
    await user.route(isListing, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 503, json: { error: { code: 'integration_unavailable' } } })
        : route.continue(),
    );
    await choose(files);
    await completed(files);
    await browserExpect(queue()).toHaveCount(0);
    await browserExpect(queue().getByText('Failed', { exact: true })).toHaveCount(0);
    await browserExpect(user.locator('.fm-list-error').getByRole('alert')).toBeVisible();
    expect(uploads).toHaveLength(6);
    expect(listings.length).toBeLessThan(6);
    await user.unroute(isListing);
    await user
      .locator('.fm-list-error')
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await browserExpect(entry('display-error-06.txt')).toHaveCount(1);
    expect(uploads).toHaveLength(6);
    const remote = await provider.files();
    for (const file of files) expect(remote.get(file.name)).toEqual(file.buffer);
  });

  it('discards a held display response across folder navigation and refreshes the upload folder when returning', async () => {
    (await provider.files()).set('world/inside.txt', Buffer.from('Inside world'));
    await open();
    const listing = await holdFirstListing();
    const files = batch('navigation', 4);
    try {
      await choose(files);
      await browserExpect.poll(listing.ready).toBe(true);
      await completed(files);
      await browserExpect(queue()).toHaveCount(0);
      await entry('world').getByRole('button', { name: 'world', exact: true }).click();
      await browserExpect(entry('inside.txt')).toHaveCount(1);
      await listing.release();
      await browserExpect(entry('inside.txt')).toHaveCount(1);
      await browserExpect(entry('navigation-04.txt')).toHaveCount(0);
      await user
        .locator('.fm-breadcrumb')
        .getByRole('button', { name: 'root', exact: true })
        .click();
      await browserExpect(entry('navigation-04.txt')).toHaveCount(1);
      await browserExpect(entry('inside.txt')).toHaveCount(0);
      expect(uploads).toHaveLength(4);
      expect(listings.filter((path) => path === '')).toHaveLength(2);
      // A destination read already in flight gets at most one fresh follow-up.
      expect(listings.filter((path) => path === 'world').length).toBeGreaterThanOrEqual(1);
      expect(listings.filter((path) => path === 'world').length).toBeLessThanOrEqual(2);
    } finally {
      await listing.release();
    }
  });

  it('cancels a held listing on workspace unmount without a late follow-up and remounts with current files', async () => {
    await open();
    const listing = await holdFirstListing();
    const files = batch('unmounted', 3);
    try {
      await choose(files);
      await browserExpect.poll(listing.ready).toBe(true);
      await completed(files);
      await browserExpect(queue()).toHaveCount(0);
      await user.getByRole('link', { name: 'Servers', exact: true }).first().click();
      await browserExpect(
        user.getByRole('heading', { name: 'Servers', exact: true }),
      ).toBeVisible();
      await listing.release();
      expect(listings).toEqual(['']);
      // Browser Back remounts the workspace with the same QueryClient/cache.
      await user.goBack();
      await browserExpect(entry('unmounted-03.txt')).toHaveCount(1);
      expect(listings.length).toBeLessThanOrEqual(3);
      expect(listings.every((path) => path === '')).toBe(true);
      expect(uploads).toHaveLength(3);
    } finally {
      await listing.release();
    }
  });

  it('follows a destination listing started before the last folder upload with a fresh final read', async () => {
    await open();
    const folder = 'destination-pack';
    const local = resolve(stage, folder);
    await mkdir(local, { recursive: true });
    await writeFile(resolve(local, 'first.txt'), 'first');
    await writeFile(resolve(local, 'last.txt'), 'last');
    const uploadFile = provider.adapter.uploadFile;
    let releaseUpload = () => {};
    let entered = false;
    const pendingUpload = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    provider.adapter.uploadFile = async (...args) => {
      if (args[1] === `${folder}/last.txt`) {
        entered = true;
        await pendingUpload;
      }
      return uploadFile(...args);
    };
    let held: { route: Route; body: unknown } | undefined;
    await user.route(isListing, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('path') !== folder || held) return route.continue();
      const response = await route.fetch();
      held = { route, body: await response.json() };
    });
    try {
      await user.locator('input[webkitdirectory]').setInputFiles(local);
      await browserExpect.poll(() => entered).toBe(true);
      await browserExpect(entry(folder)).toHaveCount(1);
      await entry(folder).getByRole('button', { name: folder, exact: true }).click();
      await browserExpect.poll(() => Boolean(held)).toBe(true);
      releaseUpload();
      await completed(
        [
          { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('first') },
          { name: 'last.txt', mimeType: 'text/plain', buffer: Buffer.from('last') },
        ],
        `${folder}/`,
      );
      await browserExpect(queue()).toHaveCount(0);
      await held?.route.fulfill({ json: held.body });
      await browserExpect(entry('last.txt')).toHaveCount(1);
      expect(listings.filter((path) => path === folder)).toHaveLength(2);
      expect(uploads).toHaveLength(2);
    } finally {
      releaseUpload();
      await held?.route.fulfill({ json: held.body }).catch(() => {});
      provider.adapter.uploadFile = uploadFile;
    }
  });

  it('sends exclusive folder uploads without per-file browser listings and preserves a case-insensitive collision', async () => {
    await open();
    const folder = 'exclusive-pack';
    const local = resolve(stage, folder);
    await mkdir(local, { recursive: true });
    await writeFile(resolve(local, 'case.txt'), 'must not overwrite');
    const files = batch('folder', 7);
    for (const file of files) await writeFile(resolve(local, file.name), file.buffer);
    const createDirectory = provider.adapter.createDirectory;
    provider.adapter.createDirectory = async (...args) => {
      await createDirectory(...args);
      if (args[2] === folder)
        (await provider.files()).set(`${folder}/Case.txt`, Buffer.from('Keep existing bytes'));
    };
    try {
      await user.locator('input[webkitdirectory]').setInputFiles(local);
      await completed(files, `${folder}/`);
      await browserExpect(queue().locator('li')).toHaveCount(1);
      await browserExpect(queue().getByText('Failed', { exact: true })).toHaveCount(1);
      await browserExpect(queue().getByRole('alert')).toContainText('already exists');
      expect(uploads).toHaveLength(7);
      expect(uploads.every((request) => request.overwrite === 'false')).toBe(true);
      expect(listings.every((path) => path === '')).toBe(true);
      const remote = await provider.files();
      expect(remote.get(`${folder}/Case.txt`)?.toString()).toBe('Keep existing bytes');
      expect(remote.has(`${folder}/case.txt`)).toBe(false);
      for (const file of files) expect(remote.get(`${folder}/${file.name}`)).toEqual(file.buffer);
      await browserExpect(entry(folder)).toHaveCount(1);
    } finally {
      provider.adapter.createDirectory = createDirectory;
    }
  });
});
