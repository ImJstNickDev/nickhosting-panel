import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { DomainError } from '@nickhosting/core';
import type { ConsoleRelayOptions } from '@nickhosting/pterodactyl-adapter';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness, browserPassword } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

describe('M5 browser files, backups, console and automation', () => {
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let identities: Awaited<ReturnType<typeof prepareJourneyIdentities>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let user: Page;
  let base: string;
  const errors: string[] = [];
  beforeAll(async () => {
    harness = await browserHarness();
    identities = await prepareJourneyIdentities(harness);
    user = identities.user;
    user.on('pageerror', (error) => errors.push(error.message));
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    base = `${harness.origin}/servers/${provider.ids.serverId}`;
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  function row(name: string) {
    return user
      .locator('.fm-entry')
      .filter({ has: user.getByRole('button', { name, exact: true }) });
  }
  it('creates, edits, renames and deletes files with explicit consequences and restores keyboard focus', async () => {
    await user.goto(`${base}/files`);
    await user.getByRole('button', { name: 'New text file', exact: true }).click();
    const dialog = user.getByRole('dialog');
    const editor = user.getByRole('region', { name: 'Text editor', exact: true });
    await editor.getByLabel('Name', { exact: true }).fill('notes.txt');
    await editor.getByLabel('Contents', { exact: true }).fill('Original world notes');
    await user.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(editor.getByRole('status')).toHaveText('No unsaved changes');
    await browserExpect(editor.getByLabel('Contents', { exact: true })).toBeFocused();
    await user.keyboard.press('Control+f');
    await browserExpect(user.locator('.fm-search-panel input[name="search"]')).toBeFocused();
    await user.keyboard.press('Escape');
    await user.getByRole('button', { name: 'Back to files', exact: true }).click();
    await browserExpect(row('notes.txt')).toBeVisible();
    expect((await provider.files()).get('notes.txt')?.toString()).toBe('Original world notes');
    await row('notes.txt').getByRole('button', { name: 'notes.txt', exact: true }).click();
    await editor.getByLabel('Contents', { exact: true }).fill('Updated notes');
    user.once('dialog', (confirmation) => confirmation.dismiss());
    await user.getByRole('button', { name: 'Back to files', exact: true }).click();
    await browserExpect(editor.getByLabel('Contents', { exact: true })).toHaveText('Updated notes');
    await user.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(editor.getByRole('status')).toHaveText('No unsaved changes');
    await user.getByRole('button', { name: 'Back to files', exact: true }).click();
    expect((await provider.files()).get('notes.txt')?.toString()).toBe('Updated notes');
    await row('notes.txt')
      .getByRole('button', { name: 'Actions for notes.txt', exact: true })
      .click();
    await user.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('readme.txt');
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(row('readme.txt')).toBeVisible();
    await row('readme.txt')
      .getByRole('button', { name: 'Actions for readme.txt', exact: true })
      .click();
    await user.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await browserExpect(dialog).toContainText('readme.txt');
    await user.keyboard.press('Escape');
    await browserExpect(dialog).not.toBeVisible();
    await browserExpect(
      row('readme.txt').getByRole('button', { name: 'Actions for readme.txt', exact: true }),
    ).toBeFocused();
    await harness.screenshot(user, 'files-desktop-en');
    const audit = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(audit.violations.map((v) => v.id)).toEqual([]);
  });
  it('streams a 12 MiB binary upload/download through actual handlers with identical bytes', async () => {
    await user.goto(`${base}/files`);
    const bytes = Buffer.alloc(12 * 1024 ** 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    await user.getByLabel('Choose file', { exact: true }).setInputFiles({
      name: 'world-export.bin',
      mimeType: 'application/octet-stream',
      buffer: bytes,
    });
    await browserExpect
      .poll(async () => (await provider.files()).get('world-export.bin')?.equals(bytes))
      .toBe(true);
    await browserExpect(user.locator('.fm-uploads')).toHaveCount(0);
    expect(
      createHash('sha256')
        .update((await provider.files()).get('world-export.bin')!)
        .digest('hex'),
    ).toBe(createHash('sha256').update(bytes).digest('hex'));
    const waiting = user.waitForEvent('download');
    await row('world-export.bin')
      .getByRole('button', { name: 'Actions for world-export.bin', exact: true })
      .click();
    await user.getByRole('menuitem', { name: 'Download', exact: true }).click();
    const result = await waiting;
    expect(result.url()).toContain('/v1/servers/');
    expect(result.suggestedFilename()).toBe('world-export.bin');
    const file = await result.path();
    expect(file).toBeTruthy();
    expect(
      createHash('sha256')
        .update(await readFile(file!))
        .digest('hex'),
    ).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await user.context().cookies()).every((c) => !c.name.includes('pterodactyl'))).toBe(
      true,
    );
  });
  it('does not replace a second editor with a late first-file response', async () => {
    const files = await provider.files();
    files.set('first.txt', Buffer.from('First file'));
    files.set('second.txt', Buffer.from('Second file'));
    const original = provider.adapter.readFile;
    let release: () => void = () => {};
    let started: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    provider.adapter.readFile = async (id, name, input) => {
      if (name === 'first.txt') {
        started();
        await pending;
      }
      return original(id, name, input);
    };
    try {
      await user.reload();
      await row('first.txt').getByRole('button', { name: 'first.txt', exact: true }).click();
      await began;
      await user.getByRole('button', { name: 'Back to files', exact: true }).click();
      await row('second.txt').getByRole('button', { name: 'second.txt', exact: true }).click();
      await browserExpect(
        user
          .getByRole('region', { name: 'Text editor', exact: true })
          .getByLabel('Contents', { exact: true }),
      ).toHaveText('Second file');
      release();
      await browserExpect(
        user
          .getByRole('region', { name: 'Text editor', exact: true })
          .getByLabel('Contents', { exact: true }),
      ).toHaveText('Second file');
      await user.getByRole('button', { name: 'Back to files', exact: true }).click();
    } finally {
      release();
      provider.adapter.readFile = original;
    }
  });
  it('shows mediated console output, sends commands and presents actual telemetry units', async () => {
    await user.goto(`${base}/console`);
    await user.getByLabel('Command', { exact: true }).fill('list');
    await user.getByLabel('Command', { exact: true }).press('Enter');
    await browserExpect(user.locator('.console pre')).toContainText(
      'There are 0 of a max of 20 players online',
    );
    await browserExpect(
      user.getByRole('heading', { name: 'Resource usage', exact: true }),
    ).toBeVisible();
    await browserExpect(user.locator('figure.metric-chart')).toHaveCount(3);
    // SPA navigation retains the tab-scoped buffer; no provider log replay duplicates.
    await user.getByRole('link', { name: 'Files', exact: true }).click();
    await user.getByRole('link', { name: 'Console', exact: true }).click();
    await browserExpect(user.locator('.console pre')).toContainText(
      'There are 0 of a max of 20 players online',
    );
    await browserExpect(
      user.getByText('Output retained in this tab.', { exact: false }),
    ).toHaveCount(0);
    const contents = await user.locator('.console pre').innerText();
    expect(contents.match(/There are 0 of a max of 20 players online/g)).toHaveLength(1);
    const audit = await new AxeBuilder({ page: user })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(audit.violations.map((v) => v.id)).toEqual([]);
  });
  it('shares network chart scales and keeps localized tooltips accessible on desktop and mobile', async () => {
    const original = provider.adapter.getResources;
    const observedAt = Date.now();
    const timestamps = [90, 60, 30].map((seconds) => new Date(observedAt - seconds * 1000));
    await harness.database.db
      .insertInto('server_metrics')
      .values(
        timestamps.map((time, index) => ({
          server_id: provider.ids.serverId,
          observed_at: time,
          memory_bytes: String((64 + index * 8) * 1024 ** 2),
          cpu_percent: 2 + index,
          disk_bytes: '1024',
          network_rx_bytes: String((index + 1) * 4 * 1024 ** 2),
          network_tx_bytes: String((index + 1) * 2 * 1024 ** 2),
        })),
      )
      .execute();
    provider.adapter.getResources = async (id) => {
      const resource = await original(id);
      return {
        ...resource,
        resources: {
          ...resource.resources,
          memory_bytes: 80 * 1024 ** 2,
          cpu_absolute: 4,
          network_rx_bytes: 16 * 1024 ** 2,
          network_tx_bytes: 8 * 1024 ** 2,
        },
      };
    };
    try {
      for (const locale of ['en', 'it'] as const) {
        await journeyRequest(harness, user, '/api/auth/update-user', { locale });
        const viewport =
          locale === 'en' ? { width: 1440, height: 1000 } : { width: 390, height: 844 };
        await user.setViewportSize(viewport);
        await user.goto(`${base}/console`);
        await browserExpect(user.locator('figure.metric-chart')).toHaveCount(3);
        await browserExpect(user.getByRole('combobox')).toHaveCount(0);
        if (locale === 'en') {
          const positions = await user.locator('figure.metric-chart').evaluateAll((charts) =>
            charts.map((chart) => ({
              heading: chart.querySelector('h3')?.getBoundingClientRect().y,
              graph: chart.querySelector(':scope > svg')?.getBoundingClientRect().y,
              axis: chart.querySelector(':scope > svg text')?.getBoundingClientRect().y,
              time: chart.querySelector(':scope > svg text:last-child')?.getBoundingClientRect().y,
            })),
          );
          for (const key of ['heading', 'graph', 'axis', 'time'] as const) {
            const first = positions[0]?.[key];
            if (first === undefined) throw new Error(`Missing chart ${key}`);
            for (const position of positions) expect(position[key]).toBeCloseTo(first, 0);
          }
        }
        const chart = user.locator('figure.network-chart');
        await browserExpect(chart).toBeVisible();
        await browserExpect(chart.locator('svg[role="img"]')).toHaveCount(1);
        const lines = chart.locator('polyline');
        await browserExpect(lines).toHaveCount(2);
        const points = await lines.evaluateAll((elements) =>
          [...elements].reverse().map((element) =>
            (element.getAttribute('points') ?? '')
              .trim()
              .split(/\s+/)
              .map((point) => point.split(',').map(Number)),
          ),
        );
        const [inbound = [], outbound = []] = points;
        expect(inbound.length).toBeGreaterThanOrEqual(4);
        expect(inbound.map((point) => point[0])).toEqual(outbound.map((point) => point[0]));
        // Historical 8 MiB received and current 8 MiB sent occupy the same vertical position.
        const sentLatest = outbound.at(-1)?.[1];
        if (sentLatest === undefined) throw new Error('Missing outbound chart point');
        expect(inbound.some((point) => Math.abs((point[1] ?? Infinity) - sentLatest) < 0.005)).toBe(
          true,
        );
        expect(inbound.at(-1)?.[1]).toBeLessThan(sentLatest);
        expect(await lines.nth(0).evaluate((line) => getComputedStyle(line).stroke)).not.toBe(
          await lines.nth(1).evaluate((line) => getComputedStyle(line).stroke),
        );
        await browserExpect(lines.nth(0)).toHaveAttribute('data-series', 'outbound');
        await browserExpect(lines.nth(1)).toHaveAttribute('data-series', 'inbound');
        for (const line of await lines.all()) {
          await browserExpect(line).toHaveCSS('stroke-dasharray', 'none');
        }
        const received = chart.getByRole('button', {
          name: locale === 'en' ? 'Network received' : 'Traffico ricevuto',
          exact: true,
        });
        const sent = chart.getByRole('button', {
          name: locale === 'en' ? 'Network sent' : 'Traffico inviato',
          exact: true,
        });
        const tooltip = user.getByRole('tooltip');
        for (const [trigger, label, value] of [
          [received, locale === 'en' ? 'Network received' : 'Traffico ricevuto', '16 MiB'],
          [sent, locale === 'en' ? 'Network sent' : 'Traffico inviato', '8 MiB'],
        ] as const) {
          await browserExpect(trigger).not.toHaveAttribute('title');
          await trigger.hover();
          await browserExpect(tooltip).toContainText(label);
          await browserExpect(tooltip).toContainText(value);
          await browserExpect(trigger).toHaveAttribute(
            'aria-describedby',
            (await tooltip.getAttribute('id')) ?? '',
          );
          await tooltip.hover();
          await browserExpect(tooltip).toBeVisible();
          await user.keyboard.press('Escape');
          await browserExpect(tooltip).toHaveCount(0);
          await user.mouse.move(0, 0);
          await trigger.focus();
          await browserExpect(tooltip).toContainText(value);
          await user.keyboard.press('Escape');
          await browserExpect(tooltip).toHaveCount(0);
          await browserExpect(trigger).toBeFocused();
          await trigger.blur();
        }
        await sent.hover();
        await browserExpect(tooltip).toBeVisible();
        const box = await tooltip.boundingBox();
        if (!box) throw new Error('Tooltip has no visible bounds');
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
        expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        const audit = await new AxeBuilder({ page: user })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(audit.violations.map((violation) => violation.id)).toEqual([]);
        await sent.focus();
        await browserExpect(sent).toBeFocused();
        await browserExpect(tooltip).toBeVisible();
        await user.screenshot({
          path: resolve(
            'docs/screenshots/m5',
            `network-chart-${locale === 'en' ? 'desktop-en' : 'mobile-it'}.png`,
          ),
          // Capture the scrolled mobile viewport to avoid full-page fixed-position artifacts.
          fullPage: locale === 'en',
        });
        await user.keyboard.press('Escape');
      }
    } finally {
      provider.adapter.getResources = original;
      await harness.database.db
        .deleteFrom('server_metrics')
        .where('server_id', '=', provider.ids.serverId)
        .where('observed_at', 'in', timestamps)
        .execute();
      await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'en' });
      await user.setViewportSize({ width: 1440, height: 1000 });
      await user.goto(`${base}/files`);
    }
    expect(errors).toEqual([]);
  });
  it('opens network tooltips by touch and dismisses them outside the trigger', async () => {
    const context = await harness.browser.newContext({
      storageState: await user.context().storageState(),
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      reducedMotion: 'reduce',
    });
    try {
      const touch = await context.newPage();
      await touch.goto(`${base}/console`);
      const trigger = touch.locator('.network-legend button').first();
      const tooltip = touch.getByRole('tooltip');
      await trigger.tap();
      await browserExpect(tooltip).toBeVisible();
      await browserExpect(tooltip).toContainText('MiB');
      await trigger.tap();
      await browserExpect(tooltip).toHaveCount(0);
      await trigger.tap();
      await browserExpect(tooltip).toBeVisible();
      await touch.evaluate(() => window.scrollBy(0, -40));
      await browserExpect(tooltip).toBeVisible();
      await touch.setViewportSize({ width: 320, height: 844 });
      await browserExpect(tooltip).toBeVisible();
      const box = await tooltip.boundingBox();
      if (!box) throw new Error('Touch tooltip has no visible bounds');
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(320);
      expect(await touch.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await touch.locator('.network-chart h3').tap();
      await browserExpect(tooltip).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
  it('submits the integrated terminal prompt with Enter, retains failed drafts and prevents duplicate requests', async () => {
    const original = provider.adapter.sendCommand;
    let calls = 0;
    let fail = true;
    let release: () => void = () => {};
    const pending = new Promise<void>((done) => {
      release = done;
    });
    provider.adapter.sendCommand = async (id, command) => {
      calls++;
      if (fail) throw new DomainError('integration_unavailable');
      await pending;
      return original(id, command);
    };
    try {
      await user.goto(`${base}/console`);
      const prompt = user.getByRole('textbox', { name: 'Command', exact: true });
      await browserExpect(user.locator('.console-terminal .console-prompt')).toContainText('»');
      await browserExpect(prompt).toHaveAttribute('placeholder', 'Type a command...');
      await browserExpect(user.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
      await browserExpect(user.getByRole('checkbox')).toHaveCount(0);
      await prompt.fill('list');
      await prompt.press('Enter');
      await browserExpect(user.getByRole('alert')).toBeVisible();
      await browserExpect(prompt).toHaveValue('list');
      await browserExpect(prompt).toBeFocused();
      expect(calls).toBe(1);
      fail = false;
      await prompt.press('Enter');
      await browserExpect.poll(() => calls).toBe(2);
      // A held Enter key must not submit a second command while the provider is pending.
      await user.keyboard.press('Enter');
      await user.keyboard.press('Enter');
      await browserExpect(prompt).toHaveValue('list');
      release();
      await browserExpect(prompt).toHaveValue('');
      await browserExpect(prompt).toBeFocused();
      await browserExpect(user.getByRole('alert')).toHaveCount(0);
      await browserExpect(user.locator('.console pre')).toContainText(
        'There are 0 of a max of 20 players online',
      );
      expect(calls).toBe(2);
      await prompt.press('Enter');
      expect(calls).toBe(2);
    } finally {
      release();
      provider.adapter.sendCommand = original;
      await user.goto(`${base}/files`);
    }
  });
  it('follows terminal output only at the bottom and resumes after keyboard scrolling back', async () => {
    const original = provider.adapter.relayConsole;
    const streams = new Set<ConsoleRelayOptions>();
    provider.adapter.relayConsole = async (id, input) => {
      const relay = await original(id, input);
      if (!input.signal?.aborted) {
        streams.add(input);
        input.signal?.addEventListener('abort', () => streams.delete(input), { once: true });
      }
      return relay;
    };
    const emit = (data: string) => {
      expect(streams.size).toBeGreaterThan(0);
      for (const stream of streams)
        if (!stream.signal?.aborted) stream.onEvent({ type: 'console', data });
    };
    const output = user.locator('.console');
    const bottomGap = () =>
      output.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
    try {
      await user.goto(`${base}/console`);
      await browserExpect.poll(() => streams.size).toBeGreaterThanOrEqual(1);
      for (let index = 0; index < 100; index++) {
        emit(`Terminal scrolling fixture ${index}`);
        if (index % 20 === 19)
          await browserExpect(output).toContainText(`Terminal scrolling fixture ${index}`);
      }
      await browserExpect.poll(bottomGap).toBeLessThanOrEqual(2);
      await output.focus();
      await user.keyboard.press('Control+Home');
      await browserExpect.poll(() => output.evaluate((element) => element.scrollTop)).toBe(0);
      emit('Output received while reading earlier lines');
      await browserExpect(output).toContainText('Output received while reading earlier lines');
      expect(await output.evaluate((element) => element.scrollTop)).toBe(0);
      expect(await bottomGap()).toBeGreaterThan(200);
      const prompt = user.getByRole('textbox', { name: 'Command', exact: true });
      await user.keyboard.press('Tab');
      await browserExpect(prompt).toBeFocused();
      await prompt.fill('draft while reading');
      expect(await output.evaluate((element) => element.scrollTop)).toBe(0);
      await user.keyboard.press('Shift+Tab');
      await browserExpect(output).toBeFocused();
      await user.keyboard.press('Control+End');
      await browserExpect.poll(bottomGap).toBeLessThanOrEqual(2);
      emit('Output received after returning to bottom');
      await browserExpect(output).toContainText('Output received after returning to bottom');
      await browserExpect.poll(bottomGap).toBeLessThanOrEqual(2);
    } finally {
      await user.goto(`${base}/files`);
      provider.adapter.relayConsole = original;
    }
  });
  it('hides the terminal command prompt without manage permission while retaining readable output', async () => {
    const endpoint = `**/v1/platform/servers/${provider.ids.serverId}`;
    await user.route(endpoint, async (route) => {
      const response = await route.fetch();
      const server = await response.json();
      server.permissions.manage = false;
      await route.fulfill({ response, json: server });
    });
    try {
      await user.goto(`${base}/console`);
      await browserExpect(user.locator('.console pre')).toContainText(
        'Browser provider fixture attached',
      );
      await browserExpect(user.getByRole('textbox', { name: 'Command', exact: true })).toHaveCount(
        0,
      );
      await browserExpect(user.locator('.console-prompt')).toHaveCount(0);
      await user.locator('.console').focus();
      await browserExpect(user.locator('.console')).toBeFocused();
    } finally {
      await user.unroute(endpoint);
      await user.goto(`${base}/files`);
    }
  });
  it('keeps the terminal prompt accessible and contained in English desktop and Italian mobile', async () => {
    try {
      for (const locale of ['en', 'it'] as const) {
        await journeyRequest(harness, user, '/api/auth/update-user', { locale });
        await user.setViewportSize(
          locale === 'en' ? { width: 1440, height: 1000 } : { width: 390, height: 844 },
        );
        await user.goto(`${base}/console`);
        const prompt = user.getByRole('textbox', {
          name: locale === 'en' ? 'Command' : 'Comando',
          exact: true,
        });
        await browserExpect(prompt).toHaveAttribute(
          'placeholder',
          locale === 'en' ? 'Type a command...' : 'Digita un comando...',
        );
        await prompt.fill('list');
        await prompt.press('Enter');
        await browserExpect(prompt).toHaveValue('');
        await browserExpect(prompt).toBeFocused();
        await browserExpect(user.locator('.console pre')).toContainText(
          'There are 0 of a max of 20 players online',
        );
        await browserExpect(user.locator('figure.metric-chart')).toHaveCount(3);
        expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        const audit = await new AxeBuilder({ page: user })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(audit.violations.map((violation) => violation.id)).toEqual([]);
        await user.screenshot({
          path: resolve(
            'docs/screenshots/m5',
            `terminal-${locale === 'en' ? 'desktop-en' : 'mobile-it'}.png`,
          ),
          fullPage: true,
        });
      }
    } finally {
      await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'en' });
      await user.setViewportSize({ width: 1440, height: 1000 });
    }
    expect(errors).toEqual([]);
  });
  it('exposes connection indicator states and reconnects by pointer and keyboard in both locales', async () => {
    for (const locale of ['en', 'it'] as const) {
      await user.goto(`${base}/files`);
      await journeyRequest(harness, user, '/api/auth/update-user', { locale });
      await user.setViewportSize(
        locale === 'en' ? { width: 1440, height: 1000 } : { width: 390, height: 844 },
      );
      let attempts = 0;
      let denyConnection = false;
      let powerRequests = 0;
      let release: () => void = () => {};
      const pending = new Promise<void>((done) => {
        release = done;
      });
      const onRequest = (request: import('@playwright/test').Request) => {
        if (request.method() === 'POST' && request.url().endsWith('/operations')) powerRequests++;
      };
      user.on('request', onRequest);
      await user.route('**/v1/servers/*/console*', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        attempts++;
        await pending;
        if (denyConnection)
          return route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: '{"error":{"code":"forbidden","messageKey":"errors.forbidden"}}',
          });
        return route.continue();
      });
      const indicator = user.locator('.console-connection');
      const states = {
        connecting: locale === 'en' ? 'Connecting… — Reconnect' : 'Connessione… — Riconnetti',
        connected: locale === 'en' ? 'Connected — Reconnect' : 'Connesso — Riconnetti',
        disconnected: locale === 'en' ? 'Disconnected — Reconnect' : 'Disconnesso — Riconnetti',
      };
      const colors = {
        connecting: 'rgb(184, 135, 0)',
        connected: 'rgb(22, 128, 60)',
        disconnected: 'rgb(180, 35, 24)',
      };
      const checkState = async (state: keyof typeof states) => {
        await browserExpect(indicator).toHaveAttribute('data-state', state);
        await browserExpect(indicator).toHaveAccessibleName(states[state]);
        await browserExpect(indicator).not.toHaveAttribute('title');
        await browserExpect(indicator.locator('span')).toHaveCSS('background-color', colors[state]);
      };
      try {
        await user.goto(`${base}/console`);
        await checkState('connecting');
        await indicator.hover();
        await browserExpect(user.getByRole('tooltip')).toHaveText(states.connecting);
        release();
        await checkState('connected');
        await browserExpect(user.getByRole('tooltip')).toHaveText(states.connected);
        await user.keyboard.press('Escape');
        await browserExpect(user.getByRole('tooltip')).toHaveCount(0);
        await user.mouse.move(0, 0);
        await browserExpect(indicator).toHaveText('');
        const target = await indicator.boundingBox();
        expect(target?.width).toBeGreaterThanOrEqual(40);
        expect(target?.height).toBeGreaterThanOrEqual(40);
        await browserExpect(indicator.locator('span')).toHaveCSS('width', '12px');
        await browserExpect(indicator.locator('span')).toHaveCSS('height', '12px');
        let previousAttempts = attempts;
        denyConnection = true;
        await indicator.click();
        await checkState('disconnected');
        expect(attempts).toBeGreaterThan(previousAttempts);
        await indicator.focus();
        await user.keyboard.press('Tab');
        await user.keyboard.press('Shift+Tab');
        await browserExpect(indicator).toBeFocused();
        await browserExpect(user.getByRole('tooltip')).toHaveText(states.disconnected);
        await user.keyboard.press('Escape');
        await browserExpect(user.getByRole('tooltip')).toHaveCount(0);
        await browserExpect(indicator).toBeFocused();
        expect(
          await indicator.evaluate((element) => getComputedStyle(element).outlineStyle),
        ).not.toBe('none');
        denyConnection = false;
        previousAttempts = attempts;
        await user.keyboard.press('Enter');
        await checkState('connected');
        expect(attempts).toBeGreaterThan(previousAttempts);
        await browserExpect(indicator).toBeFocused();
        previousAttempts = attempts;
        await user.keyboard.press('Space');
        await browserExpect.poll(() => attempts).toBeGreaterThan(previousAttempts);
        await checkState('connected');
        expect(powerRequests).toBe(0);
        const audit = await new AxeBuilder({ page: user })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(audit.violations.map((violation) => violation.id)).toEqual([]);
        expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await user.screenshot({
          path: resolve(
            'docs/screenshots/m5',
            `console-indicator-${locale === 'en' ? 'desktop-en' : 'mobile-it'}.png`,
          ),
          fullPage: true,
        });
      } finally {
        release();
        user.off('request', onRequest);
        await user.goto(`${base}/files`);
        await user.unrouteAll({ behavior: 'wait' });
      }
    }
    await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'en' });
    await user.setViewportSize({ width: 1440, height: 1000 });
    expect(errors).toEqual([]);
  });
  it('records status transitions once across repeated snapshots, reconnects and retained navigation', async () => {
    const original = provider.adapter.relayConsole;
    const streams = new Set<ConsoleRelayOptions>();
    let connections = 0;
    provider.adapter.relayConsole = async (id, input) => {
      const relay = await original(id, input);
      if (!input.signal?.aborted) {
        streams.add(input);
        input.signal?.addEventListener('abort', () => streams.delete(input), { once: true });
        connections++;
      }
      return { ...relay, requestLogs: async () => {} };
    };
    const emit = (type: 'console' | 'status', data: string) => {
      if (!streams.size) throw new Error('Fixture console was not attached');
      for (const stream of streams)
        if (!stream.signal?.aborted)
          stream.onEvent({ type, data } as Parameters<ConsoleRelayOptions['onEvent']>[0]);
    };
    const offlineCount = async () =>
      (await user.locator('.console pre').innerText()).match(/Server stopped\./g)?.length ?? 0;
    try {
      await user.goto(`${base}/console`);
      await browserExpect.poll(() => connections).toBeGreaterThanOrEqual(1);
      const connected = () =>
        browserExpect(
          user.getByRole('button', { name: 'Connected — Reconnect', exact: true }),
        ).toHaveAttribute('data-state', 'connected');
      await connected();
      let previousConnections = connections;
      emit('status', 'offline');
      emit('console', 'A real log between status snapshots');
      emit('status', 'offline');
      await browserExpect.poll(offlineCount).toBe(1);
      await user.getByRole('button', { name: 'Connected — Reconnect', exact: true }).click();
      await browserExpect.poll(() => connections).toBeGreaterThan(previousConnections);
      await connected();
      previousConnections = connections;
      emit('status', 'offline');
      emit('console', 'Reconnected marker');
      await browserExpect(user.locator('.console pre')).toContainText('Reconnected marker');
      expect(await offlineCount()).toBe(1);
      await user.getByRole('link', { name: 'Files', exact: true }).click();
      await user.getByRole('link', { name: 'Console', exact: true }).click();
      await browserExpect.poll(() => connections).toBeGreaterThan(previousConnections);
      await connected();
      previousConnections = connections;
      emit('status', 'offline');
      emit('console', 'Navigation marker');
      await browserExpect(user.locator('.console pre')).toContainText('Navigation marker');
      expect(await offlineCount()).toBe(1);
      // The last observed state survives eviction of its original line from the bounded buffer.
      for (let index = 0; index < 305; index++) {
        emit('console', `Fixture log ${index}`);
        // Let the real bounded SSE writer drain; this is history eviction, not flood testing.
        if (index % 20 === 19)
          await browserExpect(user.locator('.console pre')).toContainText(`Fixture log ${index}`);
      }
      await browserExpect(user.locator('.console pre')).toContainText('Fixture log 304');
      expect(await offlineCount()).toBe(0);
      await user.getByRole('button', { name: 'Connected — Reconnect', exact: true }).click();
      await browserExpect.poll(() => connections).toBeGreaterThan(previousConnections);
      await connected();
      emit('status', 'offline');
      emit('console', 'Still stopped');
      await browserExpect(user.locator('.console pre')).toContainText('Still stopped');
      expect(await offlineCount()).toBe(0);
      emit('status', 'running');
      emit('status', 'offline');
      await browserExpect(user.locator('.console pre')).toContainText('Server process running.');
      await browserExpect.poll(offlineCount).toBe(1);
    } finally {
      await user.goto(`${base}/files`);
      provider.adapter.relayConsole = original;
    }
  });
  it('reconnects a failed console stream, but clears retained output and stops on authorization denial', async () => {
    let attempts = 0;
    await user.route('**/v1/servers/*/console*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      attempts++;
      if (attempts === 1)
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: 'event: error\ndata: {"code":"integration_unavailable"}\n\n',
        });
      if (attempts === 2)
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: 'event: console\ndata: {"type":"console","data":"reconnected fixture"}\n\n',
        });
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: '{"error":{"code":"forbidden","messageKey":"errors.forbidden"}}',
      });
    });
    await user.goto(`${base}/console`);
    await browserExpect(user.locator('.console pre')).toContainText('reconnected fixture');
    await browserExpect(user.getByRole('alert')).toContainText('You do not have permission');
    await browserExpect(user.locator('.console pre')).not.toContainText('reconnected fixture');
    const deniedAttempts = attempts;
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(attempts).toBe(deniedAttempts);
    await user.unroute('**/v1/servers/*/console*');
  });
  it('retries transient telemetry failures without reporting the integration disabled', async () => {
    let failures = 0;
    await user.route('**/v1/servers/*/resources', async (route) => {
      failures++;
      if (failures <= 2)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":{"code":"integration_unavailable","messageKey":"errors.integration_unavailable"}}',
        });
      return route.continue();
    });
    await user.goto(`${base}/console`);
    await browserExpect(user.locator('figure.metric-chart')).toHaveCount(3);
    await browserExpect.poll(() => failures).toBeGreaterThanOrEqual(3);
    await browserExpect(
      user.getByText('This integration is unavailable.', { exact: true }),
    ).not.toBeVisible();
    await user.unroute('**/v1/servers/*/resources');
  });
  it('erases console buffers when signing out and back into the same account', async () => {
    await user.goto(`${base}/console`);
    await user.getByLabel('Command', { exact: true }).fill('private-session-marker');
    await user.getByLabel('Command', { exact: true }).press('Enter');
    await browserExpect(user.locator('.console pre')).toContainText('private-session-marker');
    await user.getByRole('link', { name: 'Settings', exact: true }).first().click();
    await user.getByRole('button', { name: 'Sign out', exact: true }).click();
    await browserExpect(user).toHaveURL(`${harness.origin}/login`);
    await user.waitForLoadState('networkidle');
    // Isolated fixture setup has already authenticated three accounts in the same minute.
    await harness.database.db.deleteFrom('rateLimit').execute();
    await user.getByLabel('Email', { exact: true }).fill('alex@journey.example.test');
    await user.getByLabel('Password', { exact: true }).fill(browserPassword);
    const signedIn = user.waitForResponse((response) =>
      response.url().endsWith('/api/auth/sign-in/email'),
    );
    await user.getByRole('button', { name: 'Sign in', exact: true }).click();
    const response = await signedIn;
    expect(await response.json()).not.toHaveProperty('error');
    expect(response.status()).toBe(200);
    await user.getByRole('link', { name: 'Servers', exact: true }).first().click();
    await user.getByRole('link', { name: 'Survival', exact: true }).click();
    await user.getByRole('link', { name: 'Console', exact: true }).click();
    await browserExpect(user.locator('.console pre')).toContainText(
      'Browser provider fixture attached',
    );
    await browserExpect(user.locator('.console pre')).not.toContainText('private-session-marker');
  });
  it('creates a durable backup, confirms replacement and restores original file contents', async () => {
    const files = await provider.files();
    files.set('restore-proof.txt', Buffer.from('Before backup'));
    await user.goto(`${base}/backups`);
    const accepted = user.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/operations'),
    );
    await user.getByRole('button', { name: 'Create backup', exact: true }).click();
    expect((await accepted).status()).toBe(202);
    await browserExpect(user.getByText('Operation requested', { exact: false })).toHaveCount(0);
    const progress = await provider.processPending();
    expect(
      progress.every((p) => p.result !== 'failed'),
      JSON.stringify(progress),
    ).toBe(true);
    files.set('restore-proof.txt', Buffer.from('After backup'));
    await user.reload();
    await user.getByRole('button', { name: 'Restore backup', exact: true }).click();
    const dialog = user.getByRole('dialog');
    await dialog.getByLabel('Confirm', { exact: true }).check();
    await dialog.getByRole('button', { name: 'Restore backup', exact: true }).click();
    await browserExpect(dialog).not.toBeVisible();
    const results = await provider.processPending();
    expect(
      results.every((p) => p.result !== 'failed'),
      JSON.stringify(results),
    ).toBe(true);
    expect((await provider.files()).get('restore-proof.txt')?.toString()).toBe('Before backup');
    await user.reload();
    await browserExpect(
      user.getByRole('button', { name: 'Restore backup', exact: true }),
    ).toBeVisible();
    await harness.screenshot(user, 'backups-desktop-en');
  });
  it('issues, rotates and revokes scoped SFTP credentials without claiming retained transport revocation', async () => {
    await user.goto(`${base}/sftp`);
    await user.getByRole('button', { name: 'Create SFTP credential', exact: true }).click();
    await browserExpect(user.getByLabel('Password', { exact: true })).not.toHaveValue('');
    await user.getByRole('button', { name: 'Close', exact: true }).click();
    const active = user
      .getByRole('row')
      .filter({ has: user.getByRole('button', { name: 'Rotate password', exact: true }) });
    await active.getByRole('checkbox').first().check();
    await active.getByRole('button', { name: 'Rotate password', exact: true }).click();
    await browserExpect(user.getByLabel('Password', { exact: true })).not.toHaveValue('');
    await user.getByRole('button', { name: 'Close', exact: true }).click();
    await active.getByLabel('Confirm', { exact: true }).check();
    await active.getByRole('button', { name: 'Revoke', exact: true }).click();
    await browserExpect(user.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
    await harness.screenshot(user, 'sftp-desktop-en');
  });
  it('persists schedules and explicit automation consent, and presents configured direct routing truthfully', async () => {
    await user.goto(`${base}/automation`);
    await user.getByRole('button', { name: 'Add schedule', exact: true }).click();
    const dialog = user.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('Daily backup');
    await dialog.getByLabel('Repeat', { exact: true }).selectOption('interval');
    await dialog.getByLabel('Interval (minutes)', { exact: true }).fill('1440');
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await browserExpect(user.getByText('Daily backup', { exact: true })).toBeVisible();
    await harness.screenshot(user, 'automation-desktop-en');
    await user.goto(`${base}/network`);
    await browserExpect(
      user.getByRole('cell', { name: `${provider.ids.nodeId}.example.test`, exact: false }).first(),
    ).toBeVisible();
    await browserExpect(
      user.getByRole('cell', { name: 'Configured', exact: true }).first(),
    ).toBeVisible();
    await browserExpect(
      user.getByText(
        'Direct connection. This address is configured by the Owner; external reachability has not been verified.',
        { exact: true },
      ),
    ).toBeVisible();
    await browserExpect(user.getByText('games.example.test', { exact: false })).toHaveCount(0);
    await harness.screenshot(user, 'network-direct-desktop-en');
    provider.setProviderAvailable(false);
    await user.goto(`${base}/files`);
    await browserExpect(user.getByRole('alert').first()).toBeVisible();
    await harness.screenshot(user, 'files-provider-unavailable-desktop-en');
    provider.setProviderAvailable(true);
    expect(errors).toEqual([]);
  });
  it('shows partial reconciliation failures without claiming all providers were checked', async () => {
    const factory = provider.management.externalOptions.sftpFactory!;
    provider.management.externalOptions.sftpFactory = (...args) => ({
      ...factory(...args),
      ensureCredential: async () => {
        throw new Error('Isolated external provider outage');
      },
    });
    const failed = await user.request.post(
      `${harness.origin}/v1/servers/${provider.ids.serverId}/sftp`,
      { headers: { Origin: harness.origin }, data: { credentialId: randomUUID() } },
    );
    expect(failed.ok()).toBe(false);
    const original = provider.adapter.getApplicationServer;
    provider.adapter.getApplicationServer = async () => {
      throw new Error('Isolated provider observation unavailable');
    };
    try {
      const owner = identities.owner;
      await owner.goto(`${harness.origin}/owner/operations`);
      await owner.getByRole('button', { name: 'Check managed servers', exact: true }).click();
      await browserExpect(
        owner.getByText('These servers could not be checked:', { exact: true }),
      ).toBeVisible();
      await browserExpect(
        owner.getByText('External operations: 0 recovered, 1 failed.', { exact: true }),
      ).toBeVisible();
      await browserExpect(owner.getByText('Some checks failed.', { exact: false })).toBeVisible();
      await harness.screenshot(owner, 'owner-partial-reconciliation-desktop-en');
    } finally {
      provider.adapter.getApplicationServer = original;
      provider.management.externalOptions.sftpFactory = factory;
    }
  });

  it('keeps files, backups and telemetry usable in Italian mobile and pseudolocalized layouts', async () => {
    await journeyRequest(harness, user, '/api/auth/update-user', { locale: 'it' });
    await user.setViewportSize({ width: 390, height: 844 });
    for (const [tab, label] of [
      ['files', 'Cerca in questa cartella'],
      ['backups', 'Crea backup'],
      ['console', 'Comando'],
    ] as const) {
      await user.goto(`${base}/${tab}`);
      if (tab === 'backups')
        await browserExpect(user.getByRole('button', { name: label, exact: true })).toBeVisible();
      else await browserExpect(user.getByLabel(label, { exact: true })).toBeVisible();
      expect(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const axe = await new AxeBuilder({ page: user })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(axe.violations.map((v) => v.id)).toEqual([]);
      await harness.screenshot(user, `${tab}-mobile-it`);
    }
    const pseudo = await harness.page('pseudo', true);
    await pseudo.context().addCookies(await user.context().cookies());
    await pseudo.goto(`${base}/files`);
    await browserExpect(pseudo.locator('.file-manager')).toBeVisible();
    await browserExpect(pseudo.locator('main')).toContainText('［');
    await browserExpect(pseudo.locator('.fm-filterbar input[type="search"]')).toBeVisible();
    await pseudo.setViewportSize({ width: 320, height: 800 });
    expect(
      await pseudo
        .locator('.fm-entry')
        .first()
        .evaluate((row) => row.getBoundingClientRect().height),
    ).toBeLessThan(110);
    expect(await pseudo.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await harness.screenshot(pseudo, 'files-mobile-pseudo');
    await pseudo.context().close();
  });
});
