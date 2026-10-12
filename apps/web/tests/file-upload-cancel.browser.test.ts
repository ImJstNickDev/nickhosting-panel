import { AxeBuilder } from '@axe-core/playwright';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { expect as browserExpect, type Page, type Route } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 upload cancellation preserves unattempted files', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let base: string;
  let endpoint: string;
  const requests: string[] = [];
  const errors: string[] = [];
  const holds = new Set<string>();
  const pending = new Map<string, { release: () => void; fail: () => void }>();
  const claims = new Set<string>();

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
      if (url.pathname === `${endpoint}/upload` && request.method() === 'PUT')
        requests.push(`PUT:${url.searchParams.get('path')}`);
      if (url.pathname === `${endpoint}/capabilities`) requests.push('GET:capabilities');
      if (url.pathname.endsWith(`/${provider.ids.serverId}/transfers`))
        requests.push('GET:transfers');
    });
    const uploadFile = provider.adapter.uploadFile;
    provider.adapter.uploadFile = async (id, name, input) => {
      if (holds.has(name)) {
        const claim = await harness.database.db
          .selectFrom('upload_ingestion_claims')
          .select('id')
          .where('server_id', '=', provider.ids.serverId)
          .executeTakeFirstOrThrow();
        claims.add(claim.id);
        // The external provider is the only fake: actual API upload admission
        // creates and retains this claim when the provider outcome is unknown.
        await new Promise<void>((resolve, reject) => {
          const fail = () => reject(new PterodactylError('unavailable', 'client', 'unknown'));
          pending.set(name, {
            release: () => {
              input.signal?.removeEventListener('abort', fail);
              resolve();
            },
            fail,
          });
          if (input.signal?.aborted) fail();
          else input.signal?.addEventListener('abort', fail, { once: true });
        });
      }
      return uploadFile(id, name, input);
    };
  });

  async function clearFixtureClaims() {
    if (!harness.database.schema.startsWith('nh_test_'))
      throw new Error('Upload fixtures require a disposable test schema');
    // Simulate resolution of only the claims captured by this isolated provider.
    for (const id of claims)
      await harness.database.db
        .deleteFrom('upload_ingestion_claims')
        .where('id', '=', id)
        .where('server_id', '=', provider.ids.serverId)
        .execute();
    claims.clear();
  }
  afterEach(async () => {
    for (const item of pending.values()) item.release();
    pending.clear();
    holds.clear();
    await user.goto(`${harness.origin}/servers`);
    await clearFixtureClaims();
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });

  function uploads() {
    return user.locator('.fm-uploads');
  }
  function row(name: string) {
    return uploads()
      .locator('li')
      .filter({ has: user.getByText(name, { exact: true }) });
  }
  function batch(prefix: string, count: number) {
    return Array.from({ length: count }, (_, index) => ({
      name: `${prefix}-${String(index + 1).padStart(2, '0')}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(`file ${index + 1}`),
    }));
  }
  function fileName(files: ReturnType<typeof batch>, index: number) {
    const file = files[index];
    if (!file) throw new Error(`Missing fixture file ${index}`);
    return file.name;
  }
  function held(name: string) {
    const item = pending.get(name);
    if (!item) throw new Error(`Fixture upload has not started: ${name}`);
    return item;
  }
  async function choose(files: ReturnType<typeof batch>, italian = false) {
    await user.goto(base);
    await browserExpect(
      user.getByRole('button', { name: italian ? 'Carica' : 'Upload', exact: true }),
    ).toHaveAttribute('aria-disabled', 'false');
    requests.length = 0;
    await user.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(files);
  }
  const puts = () => requests.filter((entry) => entry.startsWith('PUT:'));

  it('cancels file 11 of 49, waits for fresh admission, then completes the other 48 without replay', async () => {
    const files = batch('cancel-active', 49);
    const cancelled = fileName(files, 10);
    holds.add(cancelled);
    await choose(files);
    await browserExpect.poll(() => pending.has(cancelled)).toBe(true);
    await browserExpect(uploads().getByText('Completed', { exact: true })).toHaveCount(10);
    const checkpoint = requests.length;
    await row(cancelled)
      .getByRole('button', { name: `Cancel upload of ${cancelled}` })
      .click();
    await browserExpect(uploads().getByRole('status')).toContainText('Uploads paused.');
    await browserExpect(uploads().getByText('Queued', { exact: true })).toHaveCount(38);
    await browserExpect(uploads().getByText('Failed', { exact: true })).toHaveCount(0);
    expect(puts()).toHaveLength(11);
    expect(requests.slice(checkpoint)).toEqual(
      expect.arrayContaining(['GET:transfers', 'GET:capabilities']),
    );
    await uploads().getByRole('button', { name: 'Check and resume', exact: true }).focus();
    await user.evaluate(() => window.scrollTo(0, 0));
    await harness.screenshot(user, 'file-upload-cancel-49-paused-en-desktop');
    await clearFixtureClaims();
    const resume = requests.length;
    await uploads().getByRole('button', { name: 'Check and resume', exact: true }).click();
    await browserExpect(uploads().getByText('Completed', { exact: true })).toHaveCount(48, {
      timeout: 30000,
    });
    expect(puts()).toHaveLength(49);
    expect(puts().filter((entry) => entry === `PUT:${cancelled}`)).toHaveLength(1);
    const nextPut = requests.slice(resume).findIndex((entry) => entry.startsWith('PUT:'));
    expect(requests.slice(resume, resume + nextPut)).toEqual(
      expect.arrayContaining(['GET:transfers', 'GET:capabilities']),
    );
    const remote = await provider.files();
    expect(remote.has(cancelled)).toBe(false);
    for (const file of files.filter((file) => file.name !== cancelled))
      expect(remote.get(file.name)).toEqual(file.buffer);
  });

  it('cancels a queued file without aborting the active upload or skipping other queued files', async () => {
    const files = batch('cancel-queued', 4);
    const active = fileName(files, 0);
    const cancelled = fileName(files, 2);
    holds.add(active);
    await choose(files);
    await browserExpect.poll(() => pending.has(active)).toBe(true);
    await row(cancelled)
      .getByRole('button', { name: `Cancel upload of ${cancelled}` })
      .click();
    expect(puts()).toEqual([`PUT:${active}`]);
    await browserExpect(row(active)).toContainText('Confirming upload');
    await browserExpect(uploads().getByRole('status')).toHaveCount(0);
    held(active).release();
    await browserExpect(uploads().getByText('Completed', { exact: true })).toHaveCount(3);
    expect(puts()).toEqual(
      files.filter((file) => file.name !== cancelled).map((file) => `PUT:${file.name}`),
    );
    const remote = await provider.files();
    expect(remote.has(cancelled)).toBe(false);
    for (const file of files.filter((file) => file.name !== cancelled))
      expect(remote.get(file.name)).toEqual(file.buffer);
  });

  it('continues untouched files automatically after cancellation when fresh admission is available', async () => {
    const files = batch('cancel-before-admission', 3);
    const cancelled = fileName(files, 0);
    const routePattern = `**/files/upload?path=${cancelled}`;
    let intercepted: Route | undefined;
    await user.route(routePattern, (route) => {
      intercepted = route;
    });
    try {
      await choose(files);
      await browserExpect.poll(() => Boolean(intercepted)).toBe(true);
      const checkpoint = requests.length;
      await row(cancelled)
        .getByRole('button', { name: `Cancel upload of ${cancelled}` })
        .click();
      await intercepted?.abort();
      await browserExpect(uploads().getByText('Completed', { exact: true })).toHaveCount(2);
      const nextPut = requests.slice(checkpoint).findIndex((entry) => entry.startsWith('PUT:'));
      expect(requests.slice(checkpoint, checkpoint + nextPut)).toEqual(
        expect.arrayContaining(['GET:transfers', 'GET:capabilities']),
      );
      expect(puts()).toEqual(files.map((file) => `PUT:${file.name}`));
      await browserExpect(uploads().getByRole('button', { name: 'Check and resume' })).toHaveCount(
        0,
      );
      const remote = await provider.files();
      expect(remote.has(cancelled)).toBe(false);
      for (const file of files.slice(1)) expect(remote.get(file.name)).toEqual(file.buffer);
    } finally {
      await user.unroute(routePattern);
    }
  });

  it('pauses after one conflicting submission while an earlier preflight holds the lock without a claim', async () => {
    const files = batch('cancel-preflight', 8);
    const cancelled = fileName(files, 0);
    const failed = fileName(files, 1);
    const getResources = provider.adapter.getResources;
    let entered = false;
    let released = false;
    let release = () => {};
    const preflight = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.adapter.getResources = async (id) => {
      if (!entered) {
        entered = true;
        await preflight;
        released = true;
        // The fixture preflight ends before claim creation or provider dispatch.
        throw new PterodactylError('unavailable', 'client', 'rejected');
      }
      return getResources(id);
    };
    try {
      await choose(files);
      await browserExpect.poll(() => entered).toBe(true);
      await browserExpect(row(cancelled)).toContainText('Confirming upload');
      const conflictResponse = user.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          new URL(response.url()).searchParams.get('path') === failed,
      );
      await row(cancelled)
        .getByRole('button', { name: `Cancel upload of ${cancelled}` })
        .click();
      expect((await conflictResponse).status()).toBe(409);
      await browserExpect(uploads().getByRole('status')).toContainText('Uploads paused.');
      await browserExpect(row(failed)).toContainText('Failed');
      await browserExpect(uploads().getByText('Queued', { exact: true })).toHaveCount(6);
      expect(puts()).toEqual([`PUT:${cancelled}`, `PUT:${failed}`]);
      expect(released).toBe(false);
      expect(
        await harness.database.db
          .selectFrom('upload_ingestion_claims')
          .select('id')
          .where('server_id', '=', provider.ids.serverId)
          .execute(),
      ).toEqual([]);
      expect(
        await journeyRequest(
          harness,
          user,
          `/v1/platform/servers/${provider.ids.serverId}/transfers`,
        ),
      ).toMatchObject({ upload: { available: true } });
      await browserExpect(
        uploads().getByRole('button', { name: 'Check and resume' }),
      ).toBeEnabled();
      expect(puts()).toHaveLength(2);
      release();
      await browserExpect.poll(() => released).toBe(true);
      await uploads().getByRole('button', { name: 'Check and resume', exact: true }).click();
      await browserExpect(uploads().getByText('Completed', { exact: true })).toHaveCount(6);
      expect(puts()).toEqual(files.map((file) => `PUT:${file.name}`));
      const remote = await provider.files();
      expect(remote.has(cancelled)).toBe(false);
      expect(remote.has(failed)).toBe(false);
      for (const file of files.slice(2)) expect(remote.get(file.name)).toEqual(file.buffer);
    } finally {
      release();
      provider.adapter.getResources = getResources;
    }
  });

  it('keeps queued files through repeated blocked recovery and lets the user cancel them, in Italian on mobile', async () => {
    await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'it' });
    await user.setViewportSize({ width: 390, height: 844 });
    const files = batch('blocked-failure', 4);
    const failed = fileName(files, 0);
    holds.add(failed);
    await choose(files, true);
    await browserExpect.poll(() => pending.has(failed)).toBe(true);
    held(failed).fail();
    await browserExpect(uploads().getByRole('status')).toContainText('Caricamenti in pausa.');
    await browserExpect(row(failed)).toContainText('Non riuscito');
    await browserExpect(uploads().getByText('In coda', { exact: true })).toHaveCount(3);
    for (let attempt = 0; attempt < 2; attempt++) {
      const previousReads = requests.filter((entry) => entry === 'GET:transfers').length;
      await uploads().getByRole('button', { name: 'Verifica e riprendi', exact: true }).click();
      await browserExpect(uploads().getByRole('status')).toContainText('Caricamenti in pausa.');
      expect(requests.filter((entry) => entry === 'GET:transfers').length).toBeGreaterThan(
        previousReads,
      );
      expect(puts()).toEqual([`PUT:${failed}`]);
      await browserExpect(uploads().getByText('In coda', { exact: true })).toHaveCount(3);
    }
    const cancelled = fileName(files, 2);
    await row(cancelled)
      .getByRole('button', { name: `Annulla caricamento di ${cancelled}` })
      .click();
    await browserExpect(uploads().getByText('In coda', { exact: true })).toHaveCount(2);
    await browserExpect(uploads().getByRole('status')).toContainText('chiedi all’Owner');
    expect(puts()).toEqual([`PUT:${failed}`]);
    await uploads().getByRole('button', { name: 'Verifica e riprendi', exact: true }).focus();
    await user.evaluate(() => window.scrollTo(0, 0));
    await harness.screenshot(user, 'file-upload-cancel-blocked-it-mobile');
    const audit = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(audit.violations.map(({ id, nodes }) => ({ id, nodes }))).toEqual([]);
    expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await clearFixtureClaims();
    await uploads().getByRole('button', { name: 'Verifica e riprendi', exact: true }).click();
    await browserExpect(uploads().getByText('Completato', { exact: true })).toHaveCount(2);
    expect(puts()).toEqual([
      `PUT:${failed}`,
      `PUT:${fileName(files, 1)}`,
      `PUT:${fileName(files, 3)}`,
    ]);
    expect((await provider.files()).has(failed)).toBe(false);
  });
});
