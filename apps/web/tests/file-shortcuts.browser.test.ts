import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { expect as browserExpect, type ConsoleMessage, type Page } from '@playwright/test';
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

  it('pastes a newly created extensionless file after folder navigation, lost focus and empty-space clicks', async () => {
    const destination = 'empty-paste-target';
    await journeyRequest(harness, user, endpoint, { action: 'mkdir', root: '', name: destination });
    await open();
    await user.getByRole('button', { name: 'New text file', exact: true }).click();
    await user.getByRole('textbox', { name: 'Name', exact: true }).fill('test');
    const editor = user.locator('.cm-content');
    await editor.fill('Created in the editor');
    // Saving must also work while focus is on the new file's name, not CodeMirror.
    await user.getByRole('textbox', { name: 'Name', exact: true }).press('Control+s');
    await browserExpect(
      user.getByRole('button', { name: 'Save changes', exact: true }),
    ).toBeDisabled();
    await browserExpect(user.locator('.fm-editor-state')).toHaveText('No unsaved changes');
    await user.getByRole('button', { name: 'Back to files', exact: true }).click();
    await checkbox('test').check();
    await user.keyboard.press('Control+x');
    await browserExpect(row('test')).toHaveClass(/fm-cut/);
    writes.length = 0;
    await nameButton(destination).click();
    await browserExpect(user.getByRole('button', { name: destination, exact: true })).toBeFocused();
    // Emulate the lost document focus reported across folder transitions, with no extra click.
    await user.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await user.keyboard.press('Control+v');
    await browserExpect(nameButton('test')).toBeVisible();
    expect(writes).toHaveLength(1);
    expect((await provider.files()).get(`${destination}/test`)?.toString()).toBe(
      'Created in the editor',
    );
    await select('test');
    await user.keyboard.press('Control+x');
    await root();
    await user.keyboard.press('Control+v');
    await browserExpect(nameButton('test')).toBeVisible();
    await select('test');
    await user.keyboard.press('Control+x');
    await nameButton(destination).click();
    const empty = user.locator('.file-manager .empty');
    await browserExpect(empty).toBeVisible();
    await empty.click();
    await browserExpect(user.locator('.file-manager')).toBeFocused();
    await harness.screenshot(user, 'files-empty-folder-paste-focus-en');
    // Text selected in the listing is not an editor/OS-clipboard paste destination.
    await user.locator('.fm-columns').evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await user.keyboard.press('Control+v');
    await browserExpect(nameButton('test')).toBeVisible();
    expect(writes).toHaveLength(3);
    expect((await provider.files()).has('test')).toBe(false);
    await user.evaluate(() => window.getSelection()?.removeAllRanges());
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

  it('reuses listed metadata and releases control before post-copy directory and transfer refreshes', async () => {
    const name = 'background-copy.txt';
    (await provider.files()).set(name, Buffer.from('Copy in background'));
    await open();
    await select(name);
    await user.keyboard.press('Control+c');
    await nameButton('target').click();
    const refresh = user.getByRole('button', { name: 'Refresh files', exact: true });
    await browserExpect(refresh).toBeEnabled();
    let acknowledged = false;
    const timings: Record<string, unknown>[] = [];
    const captureTiming = (message: ConsoleMessage) => {
      if (message.type() === 'debug' && message.text().startsWith('files.transfer_timing'))
        void message
          .args()[1]
          ?.jsonValue()
          .then((value) => timings.push(value));
    };
    user.on('console', captureTiming);
    const preliminaryReads: string[] = [];
    const heldReads: string[] = [];
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    await user.route('**/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname === `${endpoint}/copy`) {
        const response = await route.fetch();
        acknowledged = true;
        return route.fulfill({
          response,
          headers: {
            ...response.headers(),
            'server-timing': 'nh-file;dur=5',
            'x-request-id': 'fixture-paste-timing',
          },
        });
      }
      if (request.method() === 'GET' && url.pathname === endpoint && !acknowledged)
        preliminaryReads.push(url.searchParams.get('path') ?? '');
      if (
        request.method() === 'GET' &&
        acknowledged &&
        (url.pathname === endpoint || url.pathname.endsWith('/transfers'))
      ) {
        heldReads.push(url.pathname);
        await waiting;
      }
      return route.continue();
    });
    try {
      await user.keyboard.press('Control+v');
      await browserExpect.poll(() => acknowledged).toBe(true);
      await browserExpect.poll(() => heldReads.includes(endpoint)).toBe(true);
      await browserExpect(refresh).toBeDisabled();
      await browserExpect(
        user.getByRole('button', { name: 'New folder', exact: true }),
      ).toBeEnabled();
      await user.getByLabel('Search this folder', { exact: true }).fill('background');
      await user.getByRole('button', { name: 'New folder', exact: true }).click();
      await browserExpect(dialog()).toBeVisible();
      expect(timings).toEqual([]);
      expect(preliminaryReads).toEqual([]);
      expect(writes).toHaveLength(1);
      expect((await provider.files()).has(`target/${name}`)).toBe(true);
      await dialog().getByRole('button', { name: 'Close', exact: true }).click();
    } finally {
      release();
    }
    try {
      await browserExpect(nameButton(name)).toBeVisible();
      await browserExpect.poll(() => timings.length).toBe(1);
      expect(timings[0]).toMatchObject({
        requestId: 'fixture-paste-timing',
        action: 'copy',
        count: 1,
        outcome: 'succeeded',
        preflightMs: expect.any(Number),
        mutationMs: expect.any(Number),
        controlsReleasedAfterMs: expect.any(Number),
        directoryRefreshSettledMs: expect.any(Number),
      });
      expect(timings[0]?.directoryRefreshSettledMs).toBeGreaterThan(0);
      expect(JSON.stringify(timings)).not.toContain(name);
    } finally {
      user.off('console', captureTiming);
    }
  });

  it('requires new overwrite consent when a collision appears after the cached listing', async () => {
    const name = 'late-collision.txt';
    const remote = await provider.files();
    remote.set(name, Buffer.from('Source stays'));
    await open();
    await select(name);
    await user.keyboard.press('Control+c');
    await nameButton('target').click();
    await browserExpect(
      user.getByRole('button', { name: 'Refresh files', exact: true }),
    ).toBeEnabled();
    remote.set(`target/${name}`, Buffer.from('Unapproved external file'));
    await user.keyboard.press('Control+v');
    await browserExpect(dialog().getByRole('button', { name: 'Skip', exact: true })).toBeFocused();
    expect(writes).toHaveLength(1);
    expect(remote.get(`target/${name}`)?.toString()).toBe('Unapproved external file');
    await dialog().getByRole('button', { name: 'Skip', exact: true }).click();
    await browserExpect(dialog()).not.toBeVisible();
    expect(writes).toHaveLength(1);
  });

  it('refreshes temporary copy unavailability after the upload claim has settled', async () => {
    (await provider.files()).set('capability-copy.txt', Buffer.from('Claim polling'));
    await open();
    await select('capability-copy.txt');
    await user.keyboard.press('Control+c');
    await nameButton('target').click();
    let pending = false;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    await user.route(`**${endpoint}/copy`, async (route) => {
      pending = true;
      await waiting;
      const response = await route.fetch();
      pending = false;
      return route.fulfill({ response });
    });
    await user.route(`**${endpoint}/capabilities`, async (route) => {
      if (!pending) return route.continue();
      // An upload ingestion claim makes the real capability temporarily false.
      // Hold that response deterministically instead of waiting for a timer poll.
      return route.fulfill({
        json: { copy: false, extract: false, extractFormats: [], zipDownload: true },
      });
    });
    const readCopy = () =>
      user.evaluate(
        `import('/src/api/client.ts').then(({queryClient}) => queryClient.getQueryData(['file-capabilities', ${JSON.stringify(provider.ids.serverId)}])?.copy)`,
      );
    try {
      await user.keyboard.press('Control+v');
      await browserExpect.poll(() => pending).toBe(true);
      await user.evaluate(
        `import('/src/api/client.ts').then(({queryClient}) => queryClient.invalidateQueries({queryKey:['file-capabilities', ${JSON.stringify(provider.ids.serverId)}], exact:true}))`,
      );
      expect(await readCopy()).toBe(false);
    } finally {
      release();
    }
    await browserExpect.poll(readCopy, { timeout: 5000 }).toBe(true);
    await browserExpect(nameButton('capability-copy.txt')).toBeVisible();
    expect(writes).toHaveLength(1);
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
