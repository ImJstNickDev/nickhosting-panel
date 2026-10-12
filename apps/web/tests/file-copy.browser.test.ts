import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pendingUploadFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

type CopyRequest = {
  root: string;
  files: string[];
  destination: string;
  overwrite?: string[];
};

describe('M5 copy tree and conflict decisions with isolated real API handlers', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let base: string;
  let endpoint: string;
  const errors: string[] = [];
  const copies: CopyRequest[] = [];
  const renames: unknown[] = [];
  const listings: string[] = [];
  const stage = `./mountdata/test-assets/file-copy-browser-${randomUUID()}`;
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
      if (url.pathname === endpoint && request.method() === 'GET')
        listings.push(url.searchParams.get('path') ?? '');
      if (url.pathname === `${endpoint}/copy` && request.method() === 'POST')
        copies.push(request.postDataJSON());
      if (
        url.pathname === endpoint &&
        request.method() === 'POST' &&
        request.postDataJSON()?.action === 'rename'
      )
        renames.push(request.postDataJSON());
    });
    for (const path of ['archive', 'archive/deep', 'source', 'source/selected-folder'])
      await mkdir(path);
    const remote = await provider.files();
    for (const name of summaryNames.slice(0, 4)) remote.set(`source/${name}`, Buffer.from(name));
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
  async function openCopy(names: string[], source = '', italian = false) {
    await user.goto(base);
    for (const part of source.split('/').filter(Boolean)) {
      try {
        await row(part).getByRole('button', { name: part, exact: true }).click();
      } catch (error) {
        await harness.screenshot(user, 'file-copy-navigation-failure');
        throw new Error(
          `Could not open fixture folder ${part} at ${user.url()}: ${await user.locator('main').innerText()}`,
          { cause: error },
        );
      }
    }
    for (const name of names)
      await user
        .getByRole('checkbox', { name: `${italian ? 'Seleziona' : 'Select'} ${name}`, exact: true })
        .check();
    await user
      .getByRole('region', { name: italian ? 'File selezionati' : 'Selected files', exact: true })
      .getByRole('button', { name: italian ? 'Copia' : 'Copy', exact: true })
      .click();
    await browserExpect(dialog()).toHaveAccessibleName(italian ? 'Copia' : 'Copy');
    await browserExpect(dialog().getByRole('tree')).toBeVisible();
  }
  async function choose(name: string) {
    await node(name).locator(':scope > .file-destination-row').click();
    await browserExpect(node(name)).toHaveAttribute('aria-selected', 'true');
  }
  async function beginConflict(names: string[], destination: string, source = '', italian = false) {
    await openCopy(names, source, italian);
    await choose(destination);
    await dialog()
      .getByRole('button', { name: italian ? 'Copia' : 'Copy', exact: true })
      .click();
    await browserExpect(dialog().locator('.fm-conflict-file')).toHaveText(names[0] ?? '');
  }
  async function audit() {
    const result = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(result.violations.map(({ id }) => id)).toEqual([]);
    expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(await dialog().evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  }
  async function observeCopyUnavailable() {
    await user.bringToFront();
    expect(
      await journeyRequest<{ copy: boolean }>(harness, user, `${endpoint}/capabilities`),
    ).toMatchObject({ copy: false });
    await browserExpect
      .poll(
        async () => {
          await user.evaluate(() =>
            document.dispatchEvent(new Event('visibilitychange', { bubbles: true })),
          );
          return user.locator('.fm-selection button[aria-label="Copy"]').isDisabled();
        },
        { timeout: 12000 },
      )
      .toBe(true);
  }

  it('uses the copy tree from the toolbar and row menu with compact summaries, live paths and no effects on close', async () => {
    const remote = await provider.files();
    const before = [...remote].map(([path, bytes]) => [path, bytes.toString('base64')]);
    await openCopy(summaryNames, 'source');
    await browserExpect(dialog().locator('.fm-selection-summary')).toHaveText(
      'a.txt, b.txt, c.txt and 2 other items',
    );
    await browserExpect(dialog().locator('output')).toHaveText('/source');
    await browserExpect(dialog().getByRole('button', { name: 'Copy', exact: true })).toBeDisabled();
    await browserExpect(node('source')).toHaveAttribute('aria-disabled', 'true');
    await browserExpect(node('selected-folder')).toHaveAttribute('aria-disabled', 'true');
    await browserExpect(node('root')).toHaveAttribute('aria-disabled', 'false');
    expect(listings).not.toContain('archive');
    await node('root').focus();
    await user.keyboard.press('Enter');
    await browserExpect(dialog().locator('output')).toHaveText('/');
    await user.keyboard.press('ArrowDown');
    await browserExpect(node('archive')).toBeFocused();
    await user.keyboard.press('ArrowRight');
    await browserExpect(node('deep')).toBeVisible();
    await user.keyboard.press('Space');
    await browserExpect(dialog().locator('output')).toHaveText('/archive');
    await browserExpect(dialog().getByRole('button', { name: 'Copy', exact: true })).toBeEnabled();
    await audit();
    await harness.screenshot(user, 'file-copy-tree-desktop-en');
    await dialog().getByRole('button', { name: 'Close', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();

    await locale('it');
    await openCopy(summaryNames, 'source', true);
    await browserExpect(dialog().locator('.fm-selection-summary')).toHaveText(
      'a.txt, b.txt, c.txt e altri 2 elementi',
    );
    await choose('archive');
    await browserExpect(dialog().locator('output')).toHaveText('/archive');
    await audit();
    await harness.screenshot(user, 'file-copy-tree-mobile-it');
    await dialog().getByRole('button', { name: 'Chiudi', exact: true }).click();
    await locale('en');
    await user.goto(base);
    await row('source').getByRole('button', { name: 'source', exact: true }).click();
    await row('a.txt').getByRole('button', { name: 'Actions for a.txt', exact: true }).click();
    await user.getByRole('menuitem', { name: 'Copy', exact: true }).click();
    await browserExpect(dialog()).toHaveAccessibleName('Copy');
    await browserExpect(dialog().getByRole('tree')).toBeVisible();
    await browserExpect(dialog().locator('.fm-selection-summary')).toHaveText('a.txt');
    await dialog().getByRole('button', { name: 'Close', exact: true }).click();
    expect(copies).toHaveLength(0);
    expect(renames).toHaveLength(0);
    expect([...remote].map(([path, bytes]) => [path, bytes.toString('base64')])).toEqual(before);
  });

  it('copies a nested-source batch once with exact overwrite consent and preserves every source and skipped destination', async () => {
    await mkdir('mixed-target');
    const remote = await provider.files();
    const names = ['mixed-a.txt', 'mixed-b.txt', 'mixed-free.txt'];
    for (const name of names) remote.set(`source/${name}`, Buffer.from(`source ${name}`));
    remote.set('mixed-target/mixed-a.txt', Buffer.from('old a'));
    remote.set('mixed-target/mixed-b.txt', Buffer.from('old b'));
    remote.set('mixed-target/unrelated.txt', Buffer.from('Keep unrelated bytes'));
    const before = copies.length;
    await beginConflict(names, 'mixed-target', 'source');
    await browserExpect(dialog().getByRole('button', { name: 'Skip', exact: true })).toBeFocused();
    await dialog().getByRole('button', { name: 'Overwrite', exact: true }).click();
    await browserExpect(dialog().locator('.fm-conflict-file')).toHaveText('mixed-b.txt');
    expect(copies).toHaveLength(before);
    await dialog().getByRole('button', { name: 'Skip', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect(copies.slice(before)).toEqual([
      {
        root: 'source',
        files: ['mixed-a.txt', 'mixed-free.txt'],
        destination: 'mixed-target',
        overwrite: ['mixed-target/mixed-a.txt'],
      },
    ]);
    for (const name of names)
      expect(remote.get(`source/${name}`)?.toString()).toBe(`source ${name}`);
    expect(remote.get('mixed-target/mixed-a.txt')?.toString()).toBe('source mixed-a.txt');
    expect(remote.get('mixed-target/mixed-free.txt')?.toString()).toBe('source mixed-free.txt');
    expect(remote.get('mixed-target/mixed-b.txt')?.toString()).toBe('old b');
    expect(remote.get('mixed-target/unrelated.txt')?.toString()).toBe('Keep unrelated bytes');
    expect(renames).toHaveLength(0);
  });

  it('applies overwrite-all only to reviewed filenames and requests fresh consent for a later collision', async () => {
    await mkdir('overwrite-target');
    const remote = await provider.files();
    const names = ['overwrite-a.txt', 'overwrite-b.txt', 'overwrite-late.txt'];
    for (const name of names) remote.set(name, Buffer.from(`source ${name}`));
    for (const name of names.slice(0, 2))
      remote.set(`overwrite-target/${name}`, Buffer.from(`old ${name}`));
    const before = copies.length;
    await beginConflict(names, 'overwrite-target');
    remote.set('overwrite-target/overwrite-late.txt', Buffer.from('Late destination'));
    await dialog().getByRole('button', { name: 'Overwrite all', exact: true }).click();
    await browserExpect(dialog().locator('.fm-conflict-file')).toHaveText('overwrite-late.txt');
    expect(copies).toHaveLength(before);
    expect(remote.get('overwrite-target/overwrite-a.txt')?.toString()).toBe('old overwrite-a.txt');
    await dialog().getByRole('button', { name: 'Skip', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect(copies.slice(before)).toEqual([
      {
        root: '',
        files: names.slice(0, 2),
        destination: 'overwrite-target',
        overwrite: names.slice(0, 2).map((name) => `overwrite-target/${name}`),
      },
    ]);
    for (const name of names) expect(remote.get(name)?.toString()).toBe(`source ${name}`);
    for (const name of names.slice(0, 2))
      expect(remote.get(`overwrite-target/${name}`)?.toString()).toBe(`source ${name}`);
    expect(remote.get('overwrite-target/overwrite-late.txt')?.toString()).toBe('Late destination');
  });

  it('supports Italian mobile skip-all with no POST when all files are skipped and still copies non-conflicting entries', async () => {
    await mkdir('skip-target');
    const remote = await provider.files();
    const names = ['skip-a.txt', 'skip-b.txt'];
    for (const name of names) {
      remote.set(name, Buffer.from(`source ${name}`));
      remote.set(`skip-target/${name}`, Buffer.from(`old ${name}`));
    }
    const before = copies.length;
    await locale('it');
    await beginConflict(names, 'skip-target', '', true);
    await browserExpect(dialog()).toHaveAccessibleName(
      'File con lo stesso nome presente in skip-target',
    );
    await browserExpect(dialog().getByRole('button', { name: 'Salta', exact: true })).toBeFocused();
    for (const name of ['Salta', 'Sovrascrivi', 'Salta tutti', 'Sovrascrivi tutti']) {
      await browserExpect(dialog().getByRole('button', { name, exact: true })).toBeVisible();
      expect(
        (await dialog().getByRole('button', { name, exact: true }).boundingBox())?.height,
      ).toBeGreaterThanOrEqual(48);
    }
    await audit();
    await harness.screenshot(user, 'file-copy-conflict-mobile-it');
    await dialog().getByRole('button', { name: 'Salta tutti', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect(copies).toHaveLength(before);
    for (const name of names) {
      expect(remote.get(name)?.toString()).toBe(`source ${name}`);
      expect(remote.get(`skip-target/${name}`)?.toString()).toBe(`old ${name}`);
    }
    await locale('en');
    remote.set('skip-free.txt', Buffer.from('Copy without conflict'));
    await beginConflict([...names, 'skip-free.txt'], 'skip-target');
    await dialog().getByRole('button', { name: 'Skip all', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect(copies.slice(before)).toEqual([
      {
        root: '',
        files: ['skip-free.txt'],
        destination: 'skip-target',
      },
    ]);
    expect(remote.get('skip-free.txt')?.toString()).toBe('Copy without conflict');
    expect(remote.get('skip-target/skip-free.txt')?.toString()).toBe('Copy without conflict');
  });

  it('keeps folder and case-ambiguous collisions unreplaceable without merging or changing their data', async () => {
    for (const path of ['blocked-target', 'blocked-folder', 'blocked-target/blocked-folder'])
      await mkdir(path);
    const remote = await provider.files();
    remote.set('blocked-folder/source.txt', Buffer.from('Folder source'));
    remote.set('blocked-target/blocked-folder/existing.txt', Buffer.from('Existing folder data'));
    remote.set('case-name.txt', Buffer.from('Lowercase source'));
    remote.set('blocked-target/CASE-NAME.txt', Buffer.from('Uppercase destination'));
    const before = copies.length;
    await beginConflict(['blocked-folder', 'case-name.txt'], 'blocked-target');
    await browserExpect(
      dialog().getByRole('button', { name: 'Overwrite', exact: true }),
    ).toBeDisabled();
    await browserExpect(
      dialog().getByRole('button', { name: 'Overwrite all', exact: true }),
    ).toBeDisabled();
    await dialog().getByRole('button', { name: 'Skip', exact: true }).click();
    await browserExpect(dialog().locator('.fm-conflict-file')).toHaveText('case-name.txt');
    await browserExpect(
      dialog().getByRole('button', { name: 'Overwrite', exact: true }),
    ).toBeDisabled();
    await dialog().getByRole('button', { name: 'Skip all', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect(copies).toHaveLength(before);
    expect(remote.get('blocked-folder/source.txt')?.toString()).toBe('Folder source');
    expect(remote.get('blocked-target/blocked-folder/existing.txt')?.toString()).toBe(
      'Existing folder data',
    );
    expect(remote.has('blocked-target/blocked-folder/source.txt')).toBe(false);
    expect(remote.get('case-name.txt')?.toString()).toBe('Lowercase source');
    expect(remote.get('blocked-target/CASE-NAME.txt')?.toString()).toBe('Uppercase destination');
  });

  it('rechecks copy availability after preflight and sends no POST when a pending claim disables it', async () => {
    const remote = await provider.files();
    remote.set('availability-copy.txt', Buffer.from('Keep source before admission'));
    const before = copies.length;
    await openCopy(['availability-copy.txt']);
    await choose('archive');
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    let claimId: string | undefined;
    const routePattern = `**${endpoint}?*`;
    await user.route(routePattern, async (route) => {
      if (new URL(route.request().url()).searchParams.get('path') === 'archive') {
        held = true;
        await waiting;
      }
      await route.continue();
    });
    try {
      await dialog().getByRole('button', { name: 'Copy', exact: true }).click();
      await browserExpect.poll(() => held).toBe(true);
      claimId = await pendingUploadFixture(harness.database.db, provider.ids.serverId);
      await observeCopyUnavailable();
      release();
      await browserExpect(dialog().getByRole('alert')).toBeVisible();
      expect(copies).toHaveLength(before);
      expect(remote.get('availability-copy.txt')?.toString()).toBe('Keep source before admission');
      expect(remote.has('archive/availability-copy.txt')).toBe(false);
      await dialog().getByRole('button', { name: 'Close', exact: true }).click();
    } finally {
      release();
      await user.unroute(routePattern);
      if (claimId)
        await harness.database.db
          .deleteFrom('upload_ingestion_claims')
          .where('id', '=', claimId)
          .execute();
    }
  });

  it('accepts its successful copy response when its own in-flight upload claim temporarily disables new copies', async () => {
    await mkdir('inflight-target');
    const remote = await provider.files();
    remote.set('inflight-copy.txt', Buffer.from('Keep source after successful copy'));
    const before = copies.length;
    const uploadFile = provider.adapter.uploadFile;
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    provider.adapter.uploadFile = async (...args) => {
      if (args[1] === 'inflight-target/inflight-copy.txt') {
        held = true;
        await waiting;
      }
      return uploadFile(...args);
    };
    try {
      await openCopy(['inflight-copy.txt']);
      await choose('inflight-target');
      await dialog().getByRole('button', { name: 'Copy', exact: true }).click();
      await browserExpect.poll(() => held).toBe(true);
      await observeCopyUnavailable();
      await browserExpect(dialog()).toBeVisible();
      await browserExpect(dialog().getByRole('alert')).toHaveCount(0);
      release();
      await browserExpect(dialog()).not.toBeVisible();
      expect(copies.slice(before)).toEqual([
        {
          root: '',
          files: ['inflight-copy.txt'],
          destination: 'inflight-target',
        },
      ]);
      expect(remote.get('inflight-copy.txt')?.toString()).toBe('Keep source after successful copy');
      expect(remote.get('inflight-target/inflight-copy.txt')?.toString()).toBe(
        'Keep source after successful copy',
      );
    } finally {
      release();
      provider.adapter.uploadFile = uploadFile;
    }
  });

  it('closes conflicts without effects and does not replay a held request after its actual copy effect becomes uncertain', async () => {
    await mkdir('uncertain-target');
    const remote = await provider.files();
    remote.set('cancel-copy.txt', Buffer.from('Retain source'));
    remote.set('uncertain-target/cancel-copy.txt', Buffer.from('Retain destination'));
    const before = copies.length;
    await beginConflict(['cancel-copy.txt'], 'uncertain-target');
    await dialog().getByRole('button', { name: 'Close', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect(copies).toHaveLength(before);
    expect(remote.get('cancel-copy.txt')?.toString()).toBe('Retain source');
    expect(remote.get('uncertain-target/cancel-copy.txt')?.toString()).toBe('Retain destination');

    remote.set('uncertain-copy.txt', Buffer.from('Copy accepted before response loss'));
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let actualStatus: number | undefined;
    const routePattern = `**${endpoint}/copy`;
    await user.route(routePattern, async (route) => {
      // Keep the real handler/provider effect and simulate loss of its successful response.
      const response = await route.fetch();
      actualStatus = response.status();
      await waiting;
      await route.fulfill({
        status: 503,
        json: {
          error: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
        },
      });
    });
    try {
      await openCopy(['uncertain-copy.txt']);
      await choose('uncertain-target');
      await dialog().getByRole('button', { name: 'Copy', exact: true }).click();
      await browserExpect.poll(() => actualStatus).toBe(200);
      await browserExpect(
        dialog().getByRole('button', { name: 'Close', exact: true }),
      ).toBeDisabled();
      await user.keyboard.press('Escape');
      await browserExpect(dialog()).toBeVisible();
      expect(copies).toHaveLength(before + 1);
      expect(remote.get('uncertain-target/uncertain-copy.txt')?.toString()).toBe(
        'Copy accepted before response loss',
      );
      release();
      await browserExpect(dialog().getByRole('alert')).toBeVisible();
      await browserExpect(
        dialog().getByRole('button', { name: 'Close', exact: true }),
      ).toBeEnabled();
      await browserExpect(dialog().getByRole('button', { name: 'Copy', exact: true })).toHaveCount(
        0,
      );
      await browserExpect(
        dialog().getByRole('button', { name: 'Try again', exact: true }),
      ).toHaveCount(0);
      await dialog().getByRole('button', { name: 'Close', exact: true }).click();
      await user.reload();
      await browserExpect(row('uncertain-copy.txt')).toBeVisible();
      expect(copies).toHaveLength(before + 1);
      expect(remote.get('uncertain-copy.txt')?.toString()).toBe(
        'Copy accepted before response loss',
      );
      expect(remote.get('uncertain-target/uncertain-copy.txt')?.toString()).toBe(
        'Copy accepted before response loss',
      );
      expect(renames).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally {
      release();
      await user.unroute(routePattern);
    }
  });
});
