import { AxeBuilder } from '@axe-core/playwright';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { expect as browserExpect, type Page, type Route } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 parallel file upload batches', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let owner: Page;
  let base: string;
  let endpoint: string;
  const requests: string[] = [],
    errors: string[] = [];
  const holds = new Set<string>();
  const pending = new Map<string, { release(): void; fail(): void }>();
  let active = 0,
    maximumActive = 0;
  beforeAll(async () => {
    harness = await browserHarness();
    const bootstrapFailures: unknown[] = [];
    const claimOwner = harness.identity.claimOwner;
    harness.identity.claimOwner = async (input) => {
      try {
        return await claimOwner(input);
      } catch (failure) {
        bootstrapFailures.push({
          name: failure instanceof Error ? failure.name : typeof failure,
          code:
            failure && typeof failure === 'object' && 'code' in failure ? failure.code : undefined,
          frames:
            failure instanceof Error
              ? failure.stack
                  ?.split('\n')
                  .filter((line) => /^\s+at /.test(line))
                  .slice(0, 5)
              : undefined,
        });
        throw failure;
      }
    };
    const identities = await prepareJourneyIdentities(harness).catch((failure) => {
      throw new Error(
        `Isolated browser bootstrap diagnostics: ${JSON.stringify(bootstrapFailures)}`,
        { cause: failure },
      );
    });
    user = identities.user;
    owner = identities.owner;
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
        requests.push(url.searchParams.get('path') ?? '');
    });
    const uploadFile = provider.adapter.uploadFile;
    provider.adapter.uploadFile = async (id, path, input) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (holds.has(path)) {
          await new Promise<void>((resolve, reject) => {
            const fail = () => reject(new PterodactylError('unavailable', 'client', 'unknown'));
            pending.set(path, { release: resolve, fail });
            if (input.signal?.aborted) fail();
            else input.signal?.addEventListener('abort', fail, { once: true });
          });
        }
        return await uploadFile(id, path, input);
      } finally {
        active--;
      }
    };
  });
  afterEach(async () => {
    for (const entry of pending.values()) entry.release();
    pending.clear();
    holds.clear();
    await user.unrouteAll({ behavior: 'ignoreErrors' });
    await user.goto(`${harness.origin}/servers`);
    await browserExpect.poll(() => active).toBe(0);
    if (!harness.database.schema.startsWith('nh_test_'))
      throw new Error('Isolated schema required');
    await harness.database.db
      .deleteFrom('upload_ingestion_claims')
      .where('server_id', '=', provider.ids.serverId)
      .execute();
    delete harness.env.NH_UPLOAD_CONCURRENCY;
    expect(errors).toEqual([]);
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  const queue = () => user.locator('.fm-uploads');
  const row = (name: string) =>
    queue()
      .locator('li')
      .filter({ has: user.getByText(name, { exact: true }) });
  const batch = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      name: `${prefix}-${String(index + 1).padStart(2, '0')}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(`contents ${index + 1}`),
    }));
  async function choose(files: ReturnType<typeof batch>) {
    await user.goto(base);
    await browserExpect(user.getByRole('button', { name: 'Upload', exact: true })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    requests.length = 0;
    maximumActive = 0;
    await user.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(files);
  }
  it('refills the second slot through 49 files while the first remains active', async () => {
    const files = batch('parallel-refill', 49),
      first = files[0]?.name ?? '';
    holds.add(first);
    await choose(files);
    await browserExpect.poll(() => pending.has(first)).toBe(true);
    await browserExpect(queue().getByText('Completed', { exact: true })).toHaveCount(48, {
      timeout: 30000,
    });
    expect(maximumActive).toBe(2);
    expect(requests).toEqual(files.map((file) => file.name));
    pending.get(first)?.release();
    await browserExpect(queue().getByText('Completed', { exact: true })).toHaveCount(49);
    const remote = await provider.files();
    for (const file of files) expect(remote.get(file.name)).toEqual(file.buffer);
    await harness.screenshot(user, 'file-upload-parallel-complete-en-desktop');
  });
  it('starts the large transfer first and drains small files without waiting for it', async () => {
    const small = batch('mixed-small', 3),
      large = {
        name: 'mixed-large.bin',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(16 * 1024 ** 2),
      };
    holds.add(large.name);
    await choose([...small, large]);
    await browserExpect.poll(() => pending.has(large.name)).toBe(true);
    await browserExpect(queue().getByText('Completed', { exact: true })).toHaveCount(3);
    expect(requests[0]).toBe(large.name);
    expect(maximumActive).toBe(2);
    pending.get(large.name)?.release();
    await browserExpect(queue().getByText('Completed', { exact: true })).toHaveCount(4);
  });
  it('respects configured concurrency and cancels a queued file independently', async () => {
    await owner.goto(`${harness.origin}/owner/settings`);
    const setting = owner
      .locator('details')
      .filter({ has: owner.locator('summary').filter({ hasText: 'Simultaneous uploads' }) });
    await setting.locator('summary').click();
    await setting.getByRole('spinbutton', { name: 'Simultaneous uploads' }).fill('3');
    await setting.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(setting.locator('summary')).toContainText('Saved setting');
    await setting.locator('summary').click();
    await browserExpect(
      setting.getByRole('spinbutton', { name: 'Simultaneous uploads' }),
    ).toHaveValue('3');
    await harness.screenshot(owner, 'file-upload-concurrency-owner-en-desktop');
    const files = batch('three-slots', 5);
    for (const file of files.slice(0, 3)) holds.add(file.name);
    await choose(files);
    await browserExpect.poll(() => pending.size).toBe(3);
    const cancelled = files[3]?.name ?? '';
    await row(cancelled)
      .getByRole('button', { name: `Cancel upload of ${cancelled}` })
      .click();
    expect(maximumActive).toBe(3);
    expect(requests).toEqual(files.slice(0, 3).map((file) => file.name));
    for (const entry of pending.values()) entry.release();
    await browserExpect(queue().getByText('Completed', { exact: true })).toHaveCount(4);
    expect(requests).not.toContain(cancelled);
    expect((await provider.files()).has(cancelled)).toBe(false);
    await journeyRequest(
      harness,
      owner,
      '/v1/owner/settings/uploadConcurrency',
      undefined,
      'DELETE',
    );
  });
  it('keeps a cancelled provider outcome isolated while every untouched sibling completes', async () => {
    const files = batch('parallel-cancel', 8),
      cancelled = files[0]?.name ?? '';
    holds.add(cancelled);
    await choose(files);
    await browserExpect.poll(() => pending.has(cancelled)).toBe(true);
    await row(cancelled)
      .getByRole('button', { name: `Cancel upload of ${cancelled}` })
      .click();
    await browserExpect(row(cancelled)).toContainText('Cancelled');
    await browserExpect(queue().getByText('Completed', { exact: true })).toHaveCount(7);
    expect(requests.filter((path) => path === cancelled)).toHaveLength(1);
    expect((await provider.files()).has(cancelled)).toBe(false);
    await browserExpect(queue().getByRole('button', { name: 'Check and resume' })).toHaveCount(0);
  });
  it('does not retry an uncertain file or cancel its siblings', async () => {
    const files = batch('parallel-failed', 7),
      failed = files[0]?.name ?? '';
    holds.add(failed);
    await choose(files);
    await browserExpect.poll(() => pending.has(failed)).toBe(true);
    pending.get(failed)?.fail();
    await browserExpect(row(failed)).toContainText('Failed');
    await browserExpect(queue().getByText('Completed', { exact: true })).toHaveCount(6);
    expect(requests.filter((path) => path === failed)).toHaveLength(1);
    const remote = await provider.files();
    for (const file of files.slice(1)) expect(remote.get(file.name)).toEqual(file.buffer);
  });
  it('retries only explicit pre-effect busy replies without duplicating the manifest identity', async () => {
    const ids: string[] = [];
    let calls = 0;
    await user.route(`**${endpoint}/upload-batches`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      ids.push(route.request().postDataJSON().id);
      if (++calls <= 2)
        return route.fulfill({
          status: 409,
          json: { error: { code: 'operation_busy', messageKey: 'errors.operation_busy' } },
        });
      await route.continue();
    });
    const files = batch('parallel-busy', 3);
    await choose(files);
    await browserExpect(queue().getByText('Completed', { exact: true })).toHaveCount(3);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(requests).toEqual(files.map((file) => file.name));
  });
  it('closes a prepared batch after unmount without submitting any file', async () => {
    let held: { route: Route; body: unknown } | undefined;
    const closed: string[] = [];
    await user.route(`**${endpoint}/upload-batches*`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      held = { route, body: await response.json() };
    });
    user.on('request', (request) => {
      if (request.method() === 'DELETE' && request.url().includes('/upload-batches/'))
        closed.push(request.url());
    });
    try {
      await choose(batch('unmounted-batch', 3));
      await browserExpect.poll(() => Boolean(held)).toBe(true);
      await user.getByRole('link', { name: 'Servers', exact: true }).first().click();
      await browserExpect(
        user.getByRole('heading', { name: 'Servers', exact: true }),
      ).toBeVisible();
      await held?.route.fulfill({ json: held.body });
      await browserExpect.poll(() => closed.length).toBe(1);
      expect(requests).toEqual([]);
    } finally {
      await held?.route.fulfill({ json: held.body }).catch(() => {});
    }
  });
  it('recovers a lost preparation response with the same identity before sending bytes', async () => {
    const ids: string[] = [];
    let lost = false;
    await user.route(`**${endpoint}/upload-batches`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      ids.push(route.request().postDataJSON().id);
      if (lost) return route.continue();
      lost = true;
      await route.fetch();
      await route.fulfill({
        status: 503,
        json: {
          error: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
        },
      });
    });
    await choose(batch('lost-preparation', 3));
    await browserExpect(queue().getByRole('button', { name: 'Check and resume' })).toBeVisible();
    expect(requests).toEqual([]);
    await queue().getByRole('button', { name: 'Check and resume' }).click();
    await browserExpect(queue().getByText('Completed', { exact: true })).toHaveCount(3);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(new Set(requests).size).toBe(3);
  });
  it('allows cancelling a file waiting on an explicit busy rejection without cancelling siblings', async () => {
    harness.env.NH_UPLOAD_CONCURRENCY = '1';
    const files = batch('cancel-waiting', 3),
      cancelled = files[0]?.name ?? '';
    await user.route(`**${endpoint}/upload?**`, async (route) => {
      if (new URL(route.request().url()).searchParams.get('path') !== cancelled)
        return route.continue();
      await route.fulfill({
        status: 409,
        json: { error: { code: 'operation_busy', messageKey: 'errors.operation_busy' } },
      });
    });
    await choose(files);
    await browserExpect(row(cancelled)).toContainText('Waiting for server');
    await row(cancelled)
      .getByRole('button', { name: `Cancel upload of ${cancelled}` })
      .click();
    const attempts = requests.filter((path) => path === cancelled).length;
    await browserExpect(queue().getByText('Completed', { exact: true })).toHaveCount(2);
    expect(requests.filter((path) => path === cancelled)).toHaveLength(attempts);
    expect((await provider.files()).has(cancelled)).toBe(false);
  });
  it('closes an unused reservation when every queued file is cancelled after a lost preparation response', async () => {
    await user.route(`**${endpoint}/upload-batches`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      await route.fulfill({
        status: 503,
        json: {
          error: { code: 'integration_unavailable', messageKey: 'errors.integration_unavailable' },
        },
      });
    });
    const files = batch('cancel-lost-prepare', 3);
    await choose(files);
    await browserExpect(queue().getByRole('button', { name: 'Check and resume' })).toBeVisible();
    for (const file of files)
      await row(file.name)
        .getByRole('button', { name: `Cancel upload of ${file.name}` })
        .click();
    await browserExpect
      .poll(
        async () =>
          (
            await harness.database.db
              .selectFrom('upload_ingestion_claims')
              .select('id')
              .where('server_id', '=', provider.ids.serverId)
              .execute()
          ).length,
      )
      .toBe(0);
    expect(requests).toEqual([]);
    await browserExpect(user.getByRole('button', { name: 'Upload', exact: true })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });
  it('retains unsubmitted files when busy retries are exhausted, then resumes without repeating successes', async () => {
    harness.env.NH_UPLOAD_CONCURRENCY = '1';
    const files = batch('busy-exhausted', 3),
      waiting = files[0]?.name ?? '';
    let reject = true;
    await user.route(`**${endpoint}/upload?**`, async (route) => {
      if (!reject || new URL(route.request().url()).searchParams.get('path') !== waiting)
        return route.continue();
      await route.fulfill({
        status: 409,
        json: { error: { code: 'operation_busy', messageKey: 'errors.operation_busy' } },
      });
    });
    await choose(files);
    await browserExpect(queue().getByRole('status')).toContainText('The server is busy.', {
      timeout: 10000,
    });
    await browserExpect(queue().getByText('Queued', { exact: true })).toHaveCount(3);
    expect(requests).toEqual(Array<string>(5).fill(waiting));
    reject = false;
    await queue().getByRole('button', { name: 'Check and resume' }).click();
    await browserExpect(queue().getByText('Completed', { exact: true })).toHaveCount(3);
    expect(requests.slice(5)).toEqual(files.map((file) => file.name));
  });
  it('renders independent progress and cancellation accessibly in Italian on mobile', async () => {
    await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'it' });
    await user.setViewportSize({ width: 390, height: 844 });
    const files = batch('italian-parallel', 3);
    for (const file of files.slice(0, 2)) holds.add(file.name);
    await user.goto(base);
    await browserExpect(user.getByRole('button', { name: 'Carica', exact: true })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    await user.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(files);
    await browserExpect.poll(() => pending.size).toBe(2);
    await queue()
      .getByRole('button', { name: `Annulla caricamento di ${files[0]?.name}` })
      .focus();
    await harness.screenshot(user, 'file-upload-parallel-it-mobile');
    const audit = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(audit.violations.map(({ id }) => id)).toEqual([]);
    expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (const entry of pending.values()) entry.release();
    await browserExpect(queue().getByText('Completato', { exact: true })).toHaveCount(3);
  });
});
