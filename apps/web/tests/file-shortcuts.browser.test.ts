import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 file explorer selection and clipboard shortcuts', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let base: string;
  let endpoint: string;
  const stage = `./mountdata/test-assets/file-shortcuts-${randomUUID()}`;
  const errors: string[] = [];
  const writes: { path: string; body: Record<string, unknown> }[] = [];

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
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && (path === endpoint || path === `${endpoint}/copy`))
        writes.push({ path, body: request.postDataJSON() });
    });
    for (const directory of ['source-folder', 'target', 'second-target']) {
      await journeyRequest(harness, user, endpoint, { action: 'mkdir', root: '', name: directory });
    }
    const remote = await provider.files();
    for (const name of ['sel-a.txt', 'sel-b.txt', 'sel-c.txt', 'sel-d.txt', 'copy.txt', 'cut.txt'])
      remote.set(name, Buffer.from(name));
    remote.set('source-folder/nested.txt', Buffer.from('Nested contents'));
    writes.length = 0;
  });

  afterEach(async () => {
    await user.unrouteAll({ behavior: 'ignoreErrors' });
    await user.goto(`${harness.origin}/servers`);
    await user.evaluate(() => sessionStorage.clear());
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
    await rm(stage, { recursive: true, force: true });
  });

  const row = (name: string) =>
    user.locator('.fm-entry').filter({ has: user.getByRole('button', { name, exact: true }) });
  const nameButton = (name: string) => row(name).getByRole('button', { name, exact: true });
  const checkbox = (name: string) => row(name).getByRole('checkbox');
  const dialog = () => user.getByRole('dialog');
  async function open() {
    await user.goto(base);
    await browserExpect(nameButton('sel-a.txt')).toBeVisible();
    await browserExpect(
      user.getByRole('button', { name: 'New folder', exact: true }),
    ).toBeEnabled();
    writes.length = 0;
  }
  async function select(name: string, modifiers: ('Control' | 'Meta' | 'Shift')[] = ['Control']) {
    await nameButton(name).click({ modifiers });
  }
  async function root() {
    await user.getByRole('button', { name: 'root', exact: true }).click();
    await browserExpect(nameButton('sel-a.txt')).toBeVisible();
  }

  it('toggles names and folders with Ctrl/Cmd and supports replacement and additive ranges', async () => {
    await open();
    await select('source-folder');
    await select('sel-a.txt');
    await select('sel-c.txt', ['Meta']);
    for (const name of ['source-folder', 'sel-a.txt', 'sel-c.txt'])
      await browserExpect(checkbox(name)).toBeChecked();
    await browserExpect(user.getByRole('region', { name: 'Text editor', exact: true })).toHaveCount(
      0,
    );
    await select('sel-a.txt');
    await browserExpect(checkbox('sel-a.txt')).not.toBeChecked();
    await select('sel-b.txt', ['Shift']);
    for (const name of ['sel-a.txt', 'sel-b.txt'])
      await browserExpect(checkbox(name)).toBeChecked();
    for (const name of ['source-folder', 'sel-c.txt'])
      await browserExpect(checkbox(name)).not.toBeChecked();
    await select('sel-d.txt', ['Control', 'Shift']);
    for (const name of ['sel-a.txt', 'sel-b.txt', 'sel-c.txt', 'sel-d.txt'])
      await browserExpect(checkbox(name)).toBeChecked();
    await harness.screenshot(user, 'files-keyboard-selection-desktop-en');
    expect(writes).toEqual([]);
    await nameButton('source-folder').click();
    await browserExpect(nameButton('nested.txt')).toBeVisible();
  });

  it('copies without a picker and pastes into each current destination, preserving the source', async () => {
    await open();
    await select('copy.txt');
    await user.keyboard.press('Control+c');
    await browserExpect(dialog()).not.toBeVisible();
    expect(writes).toEqual([]);
    await nameButton('target').click();
    await user.keyboard.press('Control+v');
    await browserExpect(nameButton('copy.txt')).toBeVisible();
    await browserExpect(dialog()).not.toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      path: `${endpoint}/copy`,
      body: { root: '', files: ['copy.txt'], destination: 'target' },
    });
    const remote = await provider.files();
    expect(remote.get('copy.txt')).toEqual(remote.get('target/copy.txt'));
    await root();
    await nameButton('second-target').click();
    await user.keyboard.press('Meta+v');
    await browserExpect(nameButton('copy.txt')).toBeVisible();
    expect(writes).toHaveLength(2);
    expect(remote.get('second-target/copy.txt')).toEqual(remote.get('copy.txt'));
  });

  it('cuts files and folders without mutation until paste, and cannot replay a consumed cut', async () => {
    await open();
    await select('cut.txt');
    await select('source-folder');
    await user.keyboard.press('Control+x');
    await browserExpect(dialog()).not.toBeVisible();
    expect(writes).toEqual([]);
    const remote = await provider.files();
    expect(remote.has('cut.txt')).toBe(true);
    expect(remote.has('source-folder/nested.txt')).toBe(true);
    await nameButton('target').click();
    await user.keyboard.press('Control+v');
    await browserExpect(nameButton('cut.txt')).toBeVisible();
    await browserExpect(nameButton('source-folder')).toBeVisible();
    await browserExpect(dialog()).not.toBeVisible();
    expect(writes).toHaveLength(1);
    expect(remote.has('cut.txt')).toBe(false);
    expect(remote.has('source-folder/nested.txt')).toBe(false);
    expect(remote.get('target/cut.txt')?.toString()).toBe('cut.txt');
    expect(remote.get('target/source-folder/nested.txt')?.toString()).toBe('Nested contents');
    await user.keyboard.press('Control+v');
    await browserExpect(dialog()).not.toBeVisible();
    expect(writes).toHaveLength(1);
  });

  it('reuses overwrite consent on paste and does not apply file shortcuts inside text inputs', async () => {
    (await provider.files()).set('target/copy.txt', Buffer.from('Previous copy'));
    await open();
    await select('copy.txt');
    await user.keyboard.press('Control+c');
    await nameButton('target').click();
    await user.keyboard.press('Control+v');
    await browserExpect(dialog().getByRole('button', { name: 'Skip', exact: true })).toBeFocused();
    expect(writes).toEqual([]);
    await dialog().getByRole('button', { name: 'Overwrite', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body.overwrite).toEqual(['target/copy.txt']);
    const search = user.getByLabel('Search this folder', { exact: true });
    await search.fill('copy');
    await search.press('Control+a');
    await search.press('Delete');
    await browserExpect(search).toHaveValue('');
    await search.press('Control+v');
    await browserExpect(dialog()).not.toBeVisible();
    expect(writes).toHaveLength(1);
  });

  it('keeps a pending paste exclusive without showing a destination or checking dialog', async () => {
    const name = 'slow-copy.txt';
    (await provider.files()).set(name, Buffer.from('Slow copy'));
    await open();
    await select(name);
    await user.keyboard.press('Control+c');
    await nameButton('target').click();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let received!: () => void;
    const submitted = new Promise<void>((resolve) => {
      received = resolve;
    });
    await user.route(`**${endpoint}/copy`, async (route) => {
      received();
      await waiting;
      await route.continue();
    });
    try {
      await user.keyboard.press('Control+v');
      await submitted;
      await browserExpect(dialog()).not.toBeVisible();
      await browserExpect(
        user.getByRole('button', { name: 'New folder', exact: true }),
      ).toBeDisabled();
      await browserExpect(
        user.getByRole('button', { name: 'New text file', exact: true }),
      ).toBeDisabled();
      await user.keyboard.press('Control+v');
      await user.keyboard.press('Delete');
      await browserExpect(dialog()).not.toBeVisible();
      expect(writes).toHaveLength(1);
    } finally {
      release();
    }
    await browserExpect(nameButton(name)).toBeVisible();
    await browserExpect(
      user.getByRole('button', { name: 'New folder', exact: true }),
    ).toBeEnabled();
  });

  it('does not replay an uncertain cut and keeps file shortcuts out of the editor', async () => {
    const name = 'uncertain-cut.txt';
    (await provider.files()).set(name, Buffer.from('Do not replay'));
    await open();
    await select(name);
    await user.keyboard.press('Control+x');
    await nameButton('target').click();
    await user.route(`**${endpoint}`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'operation_uncertain', messageKey: 'errors.operation_uncertain' },
        }),
      });
    });
    await user.keyboard.press('Control+v');
    await browserExpect(dialog().getByRole('alert')).toBeVisible();
    expect(writes).toHaveLength(1);
    await dialog().getByRole('button', { name: 'Close', exact: true }).click();
    await user.getByRole('button', { name: 'target', exact: true }).focus();
    await user.keyboard.press('Control+v');
    await browserExpect(dialog()).not.toBeVisible();
    expect(writes).toHaveLength(1);
    await root();
    await nameButton('copy.txt').click();
    const editor = user.locator('.cm-content');
    await browserExpect(editor).toBeFocused();
    await editor.press('Control+a');
    await editor.press('Control+c');
    await editor.press('Delete');
    await browserExpect(editor).toHaveText('');
    await browserExpect(dialog()).not.toBeVisible();
    expect(writes).toHaveLength(1);
    await editor.press('Control+z');
    await browserExpect(editor).toHaveText('copy.txt');
  });

  it('keeps a cut available when its conflict is dismissed before any mutation', async () => {
    const name = 'cancel-cut.txt';
    const remote = await provider.files();
    remote.set(name, Buffer.from('Source'));
    remote.set(`target/${name}`, Buffer.from('Destination'));
    await open();
    await select(name);
    await user.keyboard.press('Control+x');
    await nameButton('target').click();
    await user.keyboard.press('Control+v');
    await browserExpect(dialog().getByRole('button', { name: 'Skip', exact: true })).toBeFocused();
    await user.keyboard.press('Escape');
    await browserExpect(dialog()).not.toBeVisible();
    expect(writes).toEqual([]);
    expect(remote.get(name)?.toString()).toBe('Source');
    expect(remote.get(`target/${name}`)?.toString()).toBe('Destination');
    await user.getByRole('button', { name: 'target', exact: true }).focus();
    await user.keyboard.press('Control+v');
    await browserExpect(dialog().getByRole('button', { name: 'Skip', exact: true })).toBeFocused();
    await dialog().getByRole('button', { name: 'Skip', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect(writes).toEqual([]);
  });

  it('defaults Delete confirmation to Cancel and supports arrow selection plus Enter in EN/IT', async () => {
    const remote = await provider.files();
    for (const locale of ['en', 'it'] as const) {
      const name = `delete-key-${locale}.txt`;
      remote.set(name, Buffer.from(name));
      await journeyRequest(harness, user, '/api/auth/update-user', { locale });
      await user.setViewportSize(
        locale === 'it' ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      );
      await user.goto(base);
      await select(name);
      const before = writes.length;
      await user.keyboard.press('Delete');
      const cancel = dialog().getByRole('button', {
        name: locale === 'it' ? 'Annulla' : 'Cancel',
        exact: true,
      });
      const remove = dialog().getByRole('button', {
        name: locale === 'it' ? 'Elimina' : 'Delete',
        exact: true,
      });
      await browserExpect(cancel).toBeFocused();
      await user.keyboard.press('Enter');
      await browserExpect(dialog()).not.toBeVisible();
      expect(remote.has(name)).toBe(true);
      expect(writes).toHaveLength(before);
      await nameButton(name).focus();
      await user.keyboard.press('Delete');
      await browserExpect(cancel).toBeFocused();
      await user.keyboard.press('ArrowRight');
      await browserExpect(remove).toBeFocused();
      await user.keyboard.press('ArrowLeft');
      await browserExpect(cancel).toBeFocused();
      await harness.screenshot(user, `files-delete-keyboard-${locale}`);
      await user.keyboard.press('ArrowRight');
      await user.keyboard.press('Enter');
      await browserExpect(dialog()).not.toBeVisible();
      expect(remote.has(name)).toBe(false);
      expect(writes).toHaveLength(before + 1);
    }
  });
});
