import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

type RenameRequest = {
  action: 'rename';
  root: string;
  files: Array<{ from: string; to: string }>;
  overwrite?: string[];
};

describe('M5 file move tree and conflict decisions with isolated real API handlers', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let base: string;
  let endpoint: string;
  const errors: string[] = [];
  const mutations: RenameRequest[] = [];
  const listings: string[] = [];
  const stage = `./mountdata/test-assets/file-move-browser-${randomUUID()}`;
  const summaryNames = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'selected-folder'];

  beforeAll(async () => {
    harness = await browserHarness();
    harness.env.NH_FILE_OPERATIONS_ROOT = stage;
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
      if (url.pathname !== endpoint) return;
      if (request.method() === 'GET') listings.push(url.searchParams.get('path') ?? '');
      if (request.method() === 'POST' && request.postDataJSON()?.action === 'rename')
        mutations.push(request.postDataJSON());
    });
    for (const directory of [
      'archive',
      'archive/deep',
      'archive/deep/leaf',
      'source',
      'source/selected-folder',
      'source/selected-folder/descendant',
    ])
      await mkdir(directory);
    const remote = await provider.files();
    for (const name of summaryNames.slice(0, 4)) remote.set(`source/${name}`, Buffer.from(name));
    remote.set('root-note.txt', Buffer.from('Root file'));
    const listFiles = provider.adapter.listFiles;
    provider.adapter.listFiles = async (...args) => {
      const entries = await listFiles(...args);
      if (!args[1]) {
        const folder = entries.find((entry) => !entry.is_file);
        if (folder) entries.push({ ...folder, name: 'linked-folder', is_symlink: true });
      }
      return entries;
    };
  });

  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
    await rm(stage, { recursive: true, force: true });
  });

  const row = (name: string) =>
    user.locator('.fm-entry').filter({ has: user.getByRole('button', { name, exact: true }) });
  const dialog = () => user.getByRole('dialog');
  const node = (name: string) => dialog().getByRole('treeitem', { name, exact: true });
  async function mkdir(path: string) {
    const parts = path.split('/');
    const name = parts.pop();
    await journeyRequest(harness, user, endpoint, { action: 'mkdir', root: parts.join('/'), name });
  }
  async function locale(value: 'en' | 'it') {
    await journeyRequest(harness, user, '/api/auth/update-user', { locale: value });
    await user.setViewportSize(
      value === 'it' ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
  }
  async function openMove(names: string[], source = '', italian = false) {
    await user.goto(base);
    for (const part of source.split('/').filter(Boolean))
      await row(part).getByRole('button', { name: part, exact: true }).click();
    for (const name of names)
      await user
        .getByRole('checkbox', { name: `${italian ? 'Seleziona' : 'Select'} ${name}`, exact: true })
        .check();
    await user
      .getByRole('region', { name: italian ? 'File selezionati' : 'Selected files', exact: true })
      .getByRole('button', { name: italian ? 'Sposta' : 'Move', exact: true })
      .click();
    await browserExpect(dialog().getByRole('tree')).toBeVisible();
  }
  async function choose(name: string) {
    await node(name).locator(':scope > .file-destination-row').click();
    await browserExpect(node(name)).toHaveAttribute('aria-selected', 'true');
  }
  async function audit() {
    const result = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((n) => n.target) })),
    ).toEqual([]);
    expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(await dialog().evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  }
  async function beginConflict(names: string[], destination: string, italian = false) {
    await openMove(names, '', italian);
    await choose(destination);
    await dialog()
      .getByRole('button', { name: italian ? 'Sposta' : 'Move', exact: true })
      .click();
    await browserExpect(dialog().locator('.fm-conflict-file')).toHaveText(names[0] ?? '');
  }

  it('summarizes the first three names and navigates valid destinations without selecting source, self, descendants or links', async () => {
    await openMove(summaryNames, 'source');
    await browserExpect(dialog().locator('.fm-selection-summary')).toHaveText(
      'a.txt, b.txt, c.txt and 2 other items',
    );
    await browserExpect(dialog().locator('output')).toHaveText('/source');
    await browserExpect(dialog().getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
    await browserExpect(node('source')).toHaveAttribute('aria-disabled', 'true');
    await browserExpect(node('root')).toHaveAttribute('aria-disabled', 'false');
    await browserExpect(node('selected-folder')).toHaveAttribute('aria-disabled', 'true');
    await browserExpect(node('linked-folder')).toHaveCount(0);
    await browserExpect(node('root-note.txt')).toHaveCount(0);
    expect(listings).not.toContain('archive');
    expect(listings).not.toContain('archive/deep');
    // Disabled selection must still allow expanding the source and selected folders.
    await browserExpect(
      dialog().getByRole('button', { name: 'Collapse source', exact: true }),
    ).toBeEnabled();
    await dialog().getByRole('button', { name: 'Collapse source', exact: true }).click();
    await browserExpect(node('selected-folder')).toHaveCount(0);
    await dialog().getByRole('button', { name: 'Expand source', exact: true }).click();
    await node('selected-folder').focus();
    await user.keyboard.press('ArrowRight');
    await browserExpect(node('descendant')).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard.press('ArrowRight');
    await browserExpect(node('descendant')).toBeFocused();
    await user.keyboard.press('Enter');
    await user.keyboard.press('Space');
    await browserExpect(dialog().locator('output')).toHaveText('/source');
    await user.keyboard.press('Home');
    await browserExpect(node('root')).toBeFocused();
    await user.keyboard.press('Enter');
    await browserExpect(dialog().locator('output')).toHaveText('/');
    await browserExpect(dialog().getByRole('button', { name: 'Move', exact: true })).toBeEnabled();
    await user.keyboard.press('ArrowDown');
    await browserExpect(node('archive')).toBeFocused();
    await browserExpect(dialog().locator('output')).toHaveText('/');
    await user.keyboard.press('Space');
    await browserExpect(dialog().locator('output')).toHaveText('/archive');
    await user.keyboard.press('ArrowRight');
    await browserExpect(node('deep')).toBeVisible();
    expect(listings).toContain('archive');
    expect(listings).not.toContain('archive/deep');
    await user.keyboard.press('ArrowRight');
    await browserExpect(node('deep')).toBeFocused();
    await user.keyboard.press('ArrowRight');
    await browserExpect(node('leaf')).toBeVisible();
    await user.keyboard.press('ArrowRight');
    await browserExpect(node('leaf')).toBeFocused();
    await user.keyboard.press('ArrowLeft');
    await browserExpect(node('deep')).toBeFocused();
    await user.keyboard.press('ArrowLeft');
    await browserExpect(node('leaf')).toHaveCount(0);
    await user.keyboard.press('ArrowUp');
    await browserExpect(node('archive')).toBeFocused();
    await user.keyboard.press('End');
    await browserExpect(node('world')).toBeFocused();
    await user.keyboard.press('Home');
    await browserExpect(node('root')).toBeFocused();
    await browserExpect(dialog().locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
    await audit();
    await harness.screenshot(user, 'file-move-tree-desktop-en');
    await dialog().getByRole('button', { name: 'Close', exact: true }).click();
    expect(mutations).toHaveLength(0);

    await locale('it');
    await openMove(summaryNames, 'source', true);
    await browserExpect(dialog().locator('.fm-selection-summary')).toHaveText(
      'a.txt, b.txt, c.txt e altri 2 elementi',
    );
    await choose('archive');
    await browserExpect(dialog().locator('output')).toHaveText('/archive');
    await audit();
    await harness.screenshot(user, 'file-move-tree-mobile-it');
    await dialog().getByRole('button', { name: 'Chiudi', exact: true }).click();
    await locale('en');
    await openMove(['root-note.txt']);
    await browserExpect(node('root')).toHaveAttribute('aria-disabled', 'true');
    await browserExpect(dialog().getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
    await dialog().getByRole('button', { name: 'Close', exact: true }).click();
    expect(mutations).toHaveLength(0);
  });

  it('loads expanded branches only and preserves the bounded panel through skeleton, failure and retry', async () => {
    await locale('en');
    await mkdir('deferred');
    await mkdir('deferred/child');
    await mkdir('deferred/child/grandchild');
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const routePattern = `**${endpoint}?*`;
    await user.route(routePattern, async (route) => {
      if (new URL(route.request().url()).searchParams.get('path') !== 'deferred')
        return route.continue();
      attempts++;
      if (attempts === 1) {
        await waiting;
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'integration_unavailable',
              messageKey: 'errors.integration_unavailable',
            },
          },
        });
      }
      return route.continue();
    });
    try {
      await openMove(['root-note.txt']);
      expect(attempts).toBe(0);
      const tree = dialog().getByRole('tree');
      const height = (await tree.boundingBox())?.height;
      await dialog().getByRole('button', { name: 'Expand deferred', exact: true }).click();
      await browserExpect(node('deferred').locator('.file-destination-skeleton')).toHaveCount(3);
      await browserExpect(node('deferred').getByRole('status')).toHaveText('Loading…');
      expect((await tree.boundingBox())?.height).toBe(height);
      expect(listings).not.toContain('deferred/child');
      release();
      await browserExpect(node('deferred').getByRole('alert')).toContainText(
        'Could not load this folder.',
      );
      expect((await tree.boundingBox())?.height).toBe(height);
      await node('deferred').getByRole('button', { name: 'Try again', exact: true }).click();
      await browserExpect(node('child')).toBeVisible();
      await browserExpect(node('deferred')).toBeFocused();
      await browserExpect(node('deferred').getByRole('alert')).toHaveCount(0);
      expect(attempts).toBe(2);
      expect(listings).not.toContain('deferred/child');
      expect((await tree.boundingBox())?.height).toBe(height);
      await dialog().getByRole('button', { name: 'Close', exact: true }).click();
    } finally {
      release();
      await user.unroute(routePattern);
    }
  });

  it('restores a removed tree tab stop to its surviving ancestor without stealing focus outside the tree', async () => {
    for (const path of ['recovery', 'recovery/branch', 'recovery/branch/gone', 'recovery/second'])
      await mkdir(path);
    const listFiles = provider.adapter.listFiles;
    let removed = '';
    provider.adapter.listFiles = async (...args) => {
      const entries = await listFiles(...args);
      return entries.filter((entry) => `${args[1]}/${entry.name}` !== removed);
    };
    const refreshUntilGone = async (name: string) => {
      // Refocus revalidates naturally once the shared five-second cache becomes stale.
      await browserExpect
        .poll(
          async () => {
            await user.evaluate(() =>
              document.dispatchEvent(new Event('visibilitychange', { bubbles: true })),
            );
            return node(name).count();
          },
          { timeout: 12000 },
        )
        .toBe(0);
    };
    try {
      await user.bringToFront();
      await openMove(['root-note.txt']);
      await dialog().getByRole('button', { name: 'Expand recovery', exact: true }).click();
      await dialog().getByRole('button', { name: 'Expand branch', exact: true }).click();
      await node('gone').focus();
      removed = 'recovery/branch/gone';
      await refreshUntilGone('gone');
      await browserExpect(node('branch')).toBeFocused();
      await browserExpect(node('branch')).toHaveAttribute('tabindex', '0');
      await browserExpect(dialog().locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
      await node('second').focus();
      const close = dialog().getByRole('button', { name: 'Close', exact: true });
      await close.focus();
      removed = 'recovery/second';
      await refreshUntilGone('second');
      await browserExpect(close).toBeFocused();
      await browserExpect(node('recovery')).toHaveAttribute('tabindex', '0');
      await browserExpect(dialog().locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
      await close.click();
    } finally {
      provider.adapter.listFiles = listFiles;
    }
  });

  it('submits one real move with exact overwrite consent while retaining skipped sources and destination contents', async () => {
    await mkdir('mixed-target');
    const remote = await provider.files();
    for (const name of ['mixed-a.txt', 'mixed-b.txt', 'mixed-c.txt'])
      remote.set(name, Buffer.from(`new ${name}`));
    remote.set('mixed-target/mixed-a.txt', Buffer.from('old a'));
    remote.set('mixed-target/mixed-b.txt', Buffer.from('old b'));
    const before = mutations.length;
    await beginConflict(['mixed-a.txt', 'mixed-b.txt', 'mixed-c.txt'], 'mixed-target');
    await browserExpect(dialog().getByRole('button', { name: 'Skip', exact: true })).toBeFocused();
    await dialog().getByRole('button', { name: 'Overwrite', exact: true }).click();
    await browserExpect(dialog().locator('.fm-conflict-file')).toHaveText('mixed-b.txt');
    expect(mutations).toHaveLength(before);
    await dialog().getByRole('button', { name: 'Skip', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect(mutations.slice(before)).toEqual([
      {
        action: 'rename',
        root: '',
        files: [
          { from: 'mixed-a.txt', to: 'mixed-target/mixed-a.txt' },
          { from: 'mixed-c.txt', to: 'mixed-target/mixed-c.txt' },
        ],
        overwrite: ['mixed-target/mixed-a.txt'],
      },
    ]);
    expect(remote.has('mixed-a.txt')).toBe(false);
    expect(remote.has('mixed-c.txt')).toBe(false);
    expect(remote.get('mixed-b.txt')?.toString()).toBe('new mixed-b.txt');
    expect(remote.get('mixed-target/mixed-a.txt')?.toString()).toBe('new mixed-a.txt');
    expect(remote.get('mixed-target/mixed-b.txt')?.toString()).toBe('old b');
    expect(remote.get('mixed-target/mixed-c.txt')?.toString()).toBe('new mixed-c.txt');
  });

  it('limits overwrite-all to reviewed conflicts and asks separately about a newly appeared filename', async () => {
    await mkdir('overwrite-target');
    const remote = await provider.files();
    const names = ['overwrite-a.txt', 'overwrite-b.txt', 'overwrite-late.txt'];
    for (const name of names) remote.set(name, Buffer.from(`new ${name}`));
    for (const name of names.slice(0, 2))
      remote.set(`overwrite-target/${name}`, Buffer.from(`old ${name}`));
    const before = mutations.length;
    await beginConflict(names, 'overwrite-target');
    remote.set('overwrite-target/overwrite-late.txt', Buffer.from('late destination'));
    await dialog().getByRole('button', { name: 'Overwrite all', exact: true }).click();
    await browserExpect(dialog().locator('.fm-conflict-file')).toHaveText('overwrite-late.txt');
    expect(mutations).toHaveLength(before);
    expect(remote.get('overwrite-target/overwrite-a.txt')?.toString()).toBe('old overwrite-a.txt');
    await dialog().getByRole('button', { name: 'Skip', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect(mutations.slice(before)).toEqual([
      {
        action: 'rename',
        root: '',
        files: names.slice(0, 2).map((name) => ({ from: name, to: `overwrite-target/${name}` })),
        overwrite: names.slice(0, 2).map((name) => `overwrite-target/${name}`),
      },
    ]);
    expect(remote.has('overwrite-a.txt')).toBe(false);
    expect(remote.has('overwrite-b.txt')).toBe(false);
    expect(remote.has('overwrite-late.txt')).toBe(true);
    expect(remote.get('overwrite-target/overwrite-late.txt')?.toString()).toBe('late destination');
  });

  it('supports Italian mobile conflict choices and skip-all without sending a mutation when every file is skipped', async () => {
    await mkdir('skip-target');
    const remote = await provider.files();
    const names = ['skip-a.txt', 'skip-b.txt'];
    for (const name of names) {
      remote.set(name, Buffer.from(`new ${name}`));
      remote.set(`skip-target/${name}`, Buffer.from(`old ${name}`));
    }
    await locale('it');
    const before = mutations.length;
    await beginConflict(names, 'skip-target', true);
    await browserExpect(dialog()).toHaveAccessibleName(
      'File con lo stesso nome presente in skip-target',
    );
    await browserExpect(dialog().getByRole('button', { name: 'Salta', exact: true })).toBeFocused();
    for (const label of ['Salta', 'Sovrascrivi', 'Salta tutti', 'Sovrascrivi tutti']) {
      await browserExpect(dialog().getByRole('button', { name: label, exact: true })).toBeVisible();
      expect(
        (await dialog().getByRole('button', { name: label, exact: true }).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(48);
    }
    await audit();
    await harness.screenshot(user, 'file-move-conflict-mobile-it');
    await dialog().getByRole('button', { name: 'Salta tutti', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect(mutations).toHaveLength(before);
    for (const name of names) {
      expect(remote.get(name)?.toString()).toBe(`new ${name}`);
      expect(remote.get(`skip-target/${name}`)?.toString()).toBe(`old ${name}`);
    }
    await locale('en');
    // Skipping every conflict still moves non-conflicting files in that batch.
    remote.set('skip-free.txt', Buffer.from('No collision'));
    await beginConflict([...names, 'skip-free.txt'], 'skip-target');
    await dialog().getByRole('button', { name: 'Skip all', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect(mutations.slice(before)).toEqual([
      {
        action: 'rename',
        root: '',
        files: [{ from: 'skip-free.txt', to: 'skip-target/skip-free.txt' }],
      },
    ]);
    expect(remote.get('skip-target/skip-free.txt')?.toString()).toBe('No collision');
    expect(remote.has('skip-free.txt')).toBe(false);
    expect(errors).toEqual([]);
  });
});
