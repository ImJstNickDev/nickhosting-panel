import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

/** Native playback and the actual thumbnail worker share this isolated HTTP Range fixture.
 * motion-colors.webm.base64 is original test artwork: 60 seconds, VP9, 320×180, two frames/s,
 * a moving gold circle, four background colours and a visible second counter. No external media.
 */
describe('M5 Motion video viewer', () => {
  const browser = process.env.NH_BROWSER === 'firefox' ? 'firefox' : 'chromium';
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let base: string;
  let endpoint: string;
  let body: Buffer;
  let hold = false;
  let holdThumbnail = false;
  let reject = false;
  const pending = new Set<ServerResponse>();
  const requests: { destination: string; range: string | undefined; path: string }[] = [];
  const errors: string[] = [];

  function serve(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    if (!endpoint || !url.pathname.startsWith(`${endpoint}/`)) return false;
    if (url.pathname.endsWith('/capabilities') || url.pathname.endsWith('/preferences')) {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(
        JSON.stringify(
          url.pathname.endsWith('/capabilities') ? { available: true } : { preferences: [] },
        ),
      );
      return true;
    }
    if (!url.pathname.endsWith('/content')) return false;
    requests.push({
      destination: String(request.headers['sec-fetch-dest'] ?? ''),
      range: request.headers.range,
      path: url.searchParams.get('path') ?? '',
    });
    if (hold || (holdThumbnail && request.headers['sec-fetch-dest'] !== 'video')) {
      pending.add(response);
      response.once('close', () => pending.delete(response));
      return true;
    }
    if (reject) {
      response.writeHead(503, { 'Content-Type': 'text/plain' });
      response.end('Isolated video fixture unavailable');
      return true;
    }
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = Math.min(range?.[2] ? Number(range[2]) : body.length - 1, body.length - 1);
    if (start > end) {
      response.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
      response.end();
      return true;
    }
    response.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/webm',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}),
    });
    response.end(body.subarray(start, end + 1));
    return true;
  }

  beforeAll(async () => {
    body = Buffer.from(
      await readFile(new URL('./fixtures/motion-colors.webm.base64', import.meta.url), 'utf8'),
      'base64',
    );
    harness = await browserHarness({ browser, handleFixtureRequest: serve });
    const identities = await prepareJourneyIdentities(harness);
    page = identities.user;
    provider = await installBrowserFixtures(
      harness.database,
      identities.ownerId,
      identities.userId,
      harness.env,
      harness.codec,
    );
    harness.setManagement(provider.management);
    endpoint = `/v1/servers/${provider.ids.serverId}/files/viewer`;
    base = `${harness.origin}/servers/${provider.ids.serverId}/files`;
    const remote = await provider.files();
    for (const name of ['motion.webm', 'motion-loading.webm', 'motion-error.webm'])
      remote.set(name, body);
    page.on('pageerror', (error) => errors.push(error.message));
  });
  afterAll(async () => {
    for (const response of pending) response.destroy();
    provider?.dispose();
    await harness?.close();
  });
  async function screenshot(name: string) {
    await harness.screenshot(page, browser === 'firefox' ? `${name}-firefox` : name);
  }
  async function open(name = 'motion.webm') {
    const back = page.getByRole('button', { name: /^(Back to files|Torna ai file)$/ });
    // Explicitly exit the preceding viewer before navigation, avoiding restored-session races.
    if (await back.isVisible()) await back.click();
    await page.goto(base);
    const file = page.locator('.fm-filename').getByText(name, { exact: true });
    await browserExpect
      .poll(async () => (await file.isVisible()) || (await back.isVisible()))
      .toBe(true);
    if (await back.isVisible()) await back.click();
    await file.click();
    await browserExpect(page.locator('.motion-player')).toBeVisible();
  }
  async function ready() {
    const video = page.locator('.motion-player video');
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
      .toBeGreaterThanOrEqual(2);
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.duration))
      .toBeCloseTo(60, 1);
  }
  async function time() {
    return page
      .locator('.motion-player video')
      .evaluate((element: HTMLVideoElement) => element.currentTime);
  }
  async function seek(seconds: number) {
    await page.locator('.motion-player video').evaluate((element: HTMLVideoElement, value) => {
      element.currentTime = value;
    }, seconds);
    await browserExpect.poll(time).toBeCloseTo(seconds, 1);
  }

  it('plays actual video, routes transport shortcuts and drag seeks, and exposes buffered time', async () => {
    await open();
    await ready();
    const player = page.locator('.motion-player');
    const video = player.locator('video');
    expect(
      await video.evaluate((element: HTMLVideoElement) => ({
        controls: element.controls,
        paused: element.paused,
        autoplay: element.autoplay,
        source: element.currentSrc,
      })),
    ).toEqual({
      controls: false,
      paused: true,
      autoplay: false,
      source: expect.stringContaining(`${endpoint}/content?`),
    });
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await browserExpect.poll(time).toBeGreaterThan(0.2);
    await player.getByRole('button', { name: 'Pause', exact: true }).click();
    await seek(20);
    await player.getByRole('button', { name: 'Forward 10 seconds', exact: true }).click();
    await browserExpect.poll(time).toBeCloseTo(30, 1);
    await player.getByRole('button', { name: 'Back 10 seconds', exact: true }).click();
    await browserExpect.poll(time).toBeCloseTo(20, 1);
    await page.keyboard.press('ArrowDown');
    expect(await video.evaluate((element: HTMLVideoElement) => element.volume)).toBe(0.95);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    expect(await video.evaluate((element: HTMLVideoElement) => element.volume)).toBe(1);
    await video.evaluate((element: HTMLVideoElement) => {
      element.muted = true;
    });
    await page.keyboard.press('ArrowUp');
    expect(
      await video.evaluate((element: HTMLVideoElement) => ({
        volume: element.volume,
        muted: element.muted,
      })),
    ).toEqual({ volume: 0.05, muted: false });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect(
      await video.evaluate((element: HTMLVideoElement) => ({
        volume: element.volume,
        muted: element.muted,
      })),
    ).toEqual({ volume: 0, muted: true });
    await page.keyboard.press('ArrowRight');
    await browserExpect.poll(time).toBeCloseTo(25, 1);
    await page.keyboard.press('Shift+ArrowLeft');
    await browserExpect.poll(time).toBeCloseTo(15, 1);
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowRight');
    await page.keyboard.up('ArrowRight');
    await browserExpect.poll(time).toBeCloseTo(30, 1);
    await page.keyboard.press('Space');
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
      .toBe(false);
    await page.keyboard.press('Space');
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
      .toBe(true);
    const timeline = player.locator('.motion-seek-input');
    const bounds = await timeline.boundingBox();
    if (!bounds) throw new Error('Missing Motion seek input');
    await page.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await browserExpect.poll(time).toBeGreaterThan(43);
    await browserExpect.poll(time).toBeLessThan(47);
    expect(
      await video.evaluate((element: HTMLVideoElement) => element.buffered.length),
    ).toBeGreaterThan(0);
    await browserExpect(player.locator('.motion-buffered').first()).toBeVisible();
    expect(requests.some((request) => request.destination === 'video' && request.range)).toBe(true);
  });

  it('fits native video proportions into the available page height without scroll feedback', async () => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await open();
    await ready();
    const player = page.locator('.motion-player');
    const geometry = () =>
      player.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const video = element.querySelector('video');
        const controls = element.querySelector('.motion-controls');
        if (!video || !controls || !element.parentElement)
          throw new Error('Missing player geometry');
        return {
          width: bounds.width,
          height: bounds.height,
          top: bounds.top + window.scrollY,
          viewport: window.visualViewport?.height ?? window.innerHeight,
          ratio: video.videoWidth / video.videoHeight,
          minimum: Math.max(160, (controls as HTMLElement).offsetHeight + 24),
          wrapperHeight: element.parentElement.getBoundingClientRect().height,
          fit: getComputedStyle(video).objectFit,
        };
      });
    const expectFit = async () => {
      await browserExpect
        .poll(async () => {
          const g = await geometry();
          const desired = Math.max(g.minimum, Math.min(g.width / g.ratio, g.viewport - g.top - 16));
          return Math.abs(g.height - desired);
        })
        .toBeLessThanOrEqual(1);
      const g = await geometry();
      expect(g.wrapperHeight - g.height).toBeLessThanOrEqual(2);
      expect(g.fit).toBe('contain');
      return g;
    };
    try {
      const large = await expectFit();
      expect(large.height).toBeGreaterThan(650); // Former 65vh ceiling at this viewport.
      expect(large.top + large.height).toBeLessThanOrEqual(985);
      await screenshot('file-viewer-motion-fit-desktop-en');
      await page.setViewportSize({ width: 1280, height: 1000 });
      const fitting = await expectFit();
      expect(Math.abs(fitting.width / fitting.ratio - fitting.height)).toBeLessThanOrEqual(1);
      // Geometry-only metadata event: no claim of decoding a second media format.
      const video = player.locator('video');
      await video.evaluate((element: HTMLVideoElement) => {
        Object.defineProperty(element, 'videoHeight', { configurable: true, value: 240 });
        element.dispatchEvent(new Event('resize'));
      });
      await expectFit();
      await video.evaluate((element) => {
        Reflect.deleteProperty(element, 'videoHeight');
        element.dispatchEvent(new Event('resize'));
      });
      await page.setViewportSize({ width: 840, height: 400 });
      const short = await expectFit();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      // Exercise a scheduled resize while scrolled, not just the lack of a scroll listener.
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await expectFit();
      expect((await geometry()).height).toBe(short.height);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
      await open();
      await ready();
      const mobile = await expectFit();
      expect(Math.abs(mobile.width / mobile.ratio - mobile.height)).toBeLessThanOrEqual(1);
      await screenshot('file-viewer-motion-fit-mobile-it');
      expect(
        (await new AxeBuilder({ page }).include('.motion-player').analyze()).violations,
      ).toEqual([]);
    } finally {
      await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'en' });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    expect(errors).toEqual([]);
  });

  it('uses three stage zones, temporary 2x holds, and F/M without stealing input keys', async () => {
    await open();
    await ready();
    const player = page.locator('.motion-player');
    const video = player.locator('video');
    const stage = player.locator('.motion-stage-toggle');
    const bounds = await stage.boundingBox();
    if (!bounds) throw new Error('Missing Motion stage');
    const x = (fraction: number) => bounds.x + bounds.width * fraction;
    const y = bounds.y + bounds.height * 0.3;
    const rate = () => video.evaluate((element: HTMLVideoElement) => element.playbackRate);
    const paused = () => video.evaluate((element: HTMLVideoElement) => element.paused);
    await page.mouse.click(x(0.5), y);
    await browserExpect.poll(paused).toBe(false);
    await player.getByRole('combobox', { name: /^Playback speed/ }).click();
    await page.getByRole('option', { name: '1.5×', exact: true }).click();
    await page.mouse.move(x(0.1), y);
    await page.mouse.down();
    await browserExpect.poll(rate).toBe(2);
    await page.mouse.move(x(0.8), y);
    await page.mouse.up();
    await browserExpect.poll(rate).toBe(1.5);
    expect(await paused()).toBe(false);
    await page.keyboard.down('Space');
    await page.waitForTimeout(320);
    await browserExpect.poll(rate).toBe(2);
    await page.keyboard.up('Space');
    await browserExpect.poll(rate).toBe(1.5);
    expect(await paused()).toBe(false);
    await page.keyboard.press('Space');
    await browserExpect.poll(paused).toBe(true);
    await page.mouse.click(x(0.9), y);
    await browserExpect(player).toHaveAttribute('data-controls', 'hidden');
    expect(await paused()).toBe(true);
    await page.mouse.click(x(0.5), y);
    await browserExpect.poll(paused).toBe(false);
    await page.keyboard.press('m');
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.muted))
      .toBe(true);
    await page.keyboard.press('m');
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.muted))
      .toBe(false);
    await page.keyboard.press('f');
    await browserExpect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
      .toBe(true);
    await page.keyboard.press('f');
    await browserExpect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
      .toBe(false);
    // Losing the window must restore the rate even when no keyup reaches it.
    await page.keyboard.down('Space');
    await page.waitForTimeout(320);
    await browserExpect.poll(rate).toBe(2);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await browserExpect.poll(rate).toBe(1.5);
    await page.keyboard.up('Space');
    expect(await paused()).toBe(false);
    // Cancellation of a captured pointer also restores the selected speed.
    await stage.evaluate((element) => {
      element.addEventListener(
        'pointerdown',
        (event) => {
          element.setAttribute('data-test-pointer', String((event as PointerEvent).pointerId));
        },
        { once: true },
      );
    });
    await page.mouse.move(x(0.1), y);
    await page.mouse.down();
    await browserExpect.poll(rate).toBe(2);
    await stage.dispatchEvent('pointercancel', {
      pointerId: Number(await stage.getAttribute('data-test-pointer')),
    });
    await browserExpect.poll(rate).toBe(1.5);
    await page.mouse.up();
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'motion-shortcut-input';
      document.body.append(input);
      input.focus();
    });
    await page.keyboard.type('fm ');
    await browserExpect(page.locator('#motion-shortcut-input')).toHaveValue('fm ');
    expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(false);
    expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    await page.locator('#motion-shortcut-input').evaluate((element) => element.remove());
    await page.mouse.click(x(0.5), y);
    await browserExpect.poll(paused).toBe(true);
    await page.keyboard.down('Space');
    await page.waitForTimeout(320);
    await page.keyboard.up('Space');
    expect(await paused()).toBe(true);
    expect(await rate()).toBe(1.5);
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'outside-motion';
      button.textContent = 'Outside player fixture';
      document.body.append(button);
      button.focus();
    });
    await page.keyboard.press('f');
    await page.keyboard.press('m');
    expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(false);
    expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    await page.locator('#outside-motion').evaluate((element) => element.remove());
  });

  it('keeps manually hidden controls inside the click circle and clears it on exit or keyboard focus', async () => {
    await open();
    await ready();
    const player = page.locator('.motion-player');
    const bounds = await player.locator('.motion-stage-toggle').boundingBox();
    if (!bounds) throw new Error('Missing Motion stage');
    const x = bounds.x + bounds.width * 0.9;
    const y = bounds.y + bounds.height * 0.3;
    await page.mouse.click(x, y);
    await browserExpect(player).toHaveAttribute('data-controls', 'hidden');
    // Distance is measured from the click, not accumulated per mouse event.
    for (const [dx, dy] of [
      [3, 4],
      [-20, 0],
      [-25, 25],
    ] as const) {
      await page.mouse.move(x + dx, y + dy);
      await browserExpect(player).toHaveAttribute('data-controls', 'hidden');
    }
    if (browser === 'chromium') await screenshot('file-viewer-motion-hidden-en');
    await page.mouse.move(x - 27, y + 27);
    await browserExpect(player).toHaveAttribute('data-controls', 'visible');

    // Exiting the player must not reveal controls; reentry discards the old circle.
    const edge = bounds.x + bounds.width - 4;
    await page.mouse.click(edge, y);
    await page.mouse.move(edge + 45, y);
    await browserExpect(player).toHaveAttribute('data-controls', 'hidden');
    await page.mouse.move(edge, y);
    await browserExpect(player).toHaveAttribute('data-controls', 'visible');
    // The same applies when a click near the edge leaves only a few pixels to travel.
    await page.mouse.click(edge, y);
    await page.mouse.move(edge + 8, y);
    await browserExpect(player).toHaveAttribute('data-controls', 'hidden');
    await page.mouse.move(edge, y);
    await browserExpect(player).toHaveAttribute('data-controls', 'visible');

    // Captured drags still dispatch moves to the player after crossing its boundary.
    await page.mouse.click(edge, y);
    await page.mouse.down();
    await page.mouse.move(edge + 45, y);
    await browserExpect(player).toHaveAttribute('data-controls', 'hidden');
    await page.mouse.move(edge + 55, y);
    await browserExpect(player).toHaveAttribute('data-controls', 'hidden');
    await page.mouse.up();
    await page.mouse.move(edge, y);
    await browserExpect(player).toHaveAttribute('data-controls', 'visible');

    await page.mouse.click(x, y);
    await page.keyboard.press('Tab');
    await browserExpect(player).toHaveAttribute('data-controls', 'visible');
    expect(await player.locator('.motion-controls :focus').count()).toBe(1);
    expect(await player.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(
      true,
    );
  });

  it('decodes real hover thumbnails without seeking the playing video and renders desktop English controls', async () => {
    await open();
    await ready();
    const player = page.locator('.motion-player');
    const bounds = await player.locator('.motion-timeline').boundingBox();
    if (!bounds) throw new Error('Missing Motion timeline');
    await seek(12);
    await page.mouse.move(bounds.x + bounds.width * 0.25, bounds.y + bounds.height / 2);
    const preview = player.locator('.motion-preview img');
    if (!(await page.evaluate(() => 'VideoDecoder' in window))) {
      // Firefox without WebCodecs keeps truthful time-only hover feedback and native playback.
      await browserExpect(player.locator('.motion-preview')).toBeVisible();
      await page.waitForTimeout(1000);
      await browserExpect(preview).toHaveCount(0);
      expect(await time()).toBeCloseTo(12, 1);
      await screenshot('file-viewer-motion-preview-desktop-en');
      return;
    }
    await browserExpect(preview).toBeVisible({ timeout: 15000 });
    await browserExpect
      .poll(() => preview.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
    const first = await preview.getAttribute('src');
    expect(await time()).toBeCloseTo(12, 1);
    await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height / 2);
    await browserExpect.poll(() => preview.getAttribute('src')).not.toBe(first);
    expect(await time()).toBeCloseTo(12, 1);
    // A sampled pixel verifies these are decoded coloured frames, not black placeholders.
    const rgb = await preview.evaluate((element: HTMLImageElement) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Missing canvas');
      context.drawImage(element, 0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    });
    expect(Math.max(...rgb.slice(0, 3))).toBeGreaterThan(30);
    expect(requests.some((request) => request.destination !== 'video' && request.range)).toBe(true);
    await screenshot('file-viewer-motion-preview-desktop-en');
    expect((await new AxeBuilder({ page }).include('.motion-player').analyze()).violations).toEqual(
      [],
    );
  });

  it('cancels an actual pending thumbnail HTTP request when the pointer leaves', async () => {
    await open();
    await ready();
    // Hold only future hover requests; optional track discovery also uses Range reads.
    holdThumbnail = true;
    try {
      const bounds = await page.locator('.motion-timeline').boundingBox();
      if (!bounds) throw new Error('Missing Motion timeline');
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await browserExpect.poll(() => pending.size).toBeGreaterThan(0);
      await page.mouse.move(0, 0);
      await browserExpect.poll(() => pending.size).toBe(0);
      await browserExpect(page.locator('.motion-preview')).toHaveCount(0);
      // Native media remains usable after aborting the worker's independent fetch.
      await page
        .locator('.motion-player')
        .getByRole('button', { name: 'Play', exact: true })
        .click();
      await browserExpect.poll(time).toBeGreaterThan(0.2);
      await page
        .locator('.motion-player')
        .getByRole('button', { name: 'Pause', exact: true })
        .click();
    } finally {
      holdThumbnail = false;
      for (const response of pending) response.destroy();
    }
  });

  it('does not resume the interpolated playhead after seeked or visibility while still waiting', async () => {
    await open();
    await ready();
    const result = await page.locator('.motion-player').evaluate(async (element) => {
      const video = element.querySelector('video');
      const position = element.querySelector<HTMLInputElement>('.motion-seek-input');
      if (!video || !position) throw new Error('Missing Motion timeline');
      // A deterministic native-event trace models a stalled media clock, not decoded progress.
      Object.defineProperties(video, {
        currentTime: { configurable: true, value: 12 },
        paused: { configurable: true, value: false },
        readyState: { configurable: true, value: 4 },
      });
      try {
        video.dispatchEvent(new Event('playing'));
        video.dispatchEvent(new Event('waiting'));
        video.dispatchEvent(new Event('seeked'));
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise((resolve) => setTimeout(resolve, 400));
        return Number(position.value);
      } finally {
        for (const name of ['currentTime', 'paused', 'readyState'])
          Reflect.deleteProperty(video, name);
        video.dispatchEvent(new Event('pause'));
      }
    });
    expect(result).toBeCloseTo(12, 2);
  });

  it('controls volume, repeat, speed, endpoint replay and fullscreen dropdowns', async () => {
    await open();
    await ready();
    const player = page.locator('.motion-player');
    const video = player.locator('video');
    await player.getByRole('button', { name: 'Mute', exact: true }).click();
    expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(true);
    await player.getByRole('button', { name: 'Unmute', exact: true }).click();
    expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(false);
    const volume = player.getByRole('slider', { name: 'Volume', exact: true });
    await volume.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    expect(await video.evaluate((element: HTMLVideoElement) => element.volume)).toBeLessThan(0.2);
    await player.getByRole('button', { name: 'Repeat', exact: true }).click();
    expect(await video.evaluate((element: HTMLVideoElement) => element.loop)).toBe(true);
    await player.getByRole('button', { name: 'Repeat', exact: true }).click();
    await player.getByRole('combobox', { name: /^Playback speed/ }).click();
    await page.getByRole('option', { name: '1.5×', exact: true }).click();
    expect(await video.evaluate((element: HTMLVideoElement) => element.playbackRate)).toBe(1.5);
    await seek(60);
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await browserExpect.poll(time).toBeLessThan(3);
    await player.getByRole('button', { name: 'Pause', exact: true }).click();
    await player.getByRole('button', { name: 'Enter full screen', exact: true }).click();
    await browserExpect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
      .toBe(true);
    await player.getByRole('combobox', { name: /^Playback speed/ }).click();
    const option = page.getByRole('option', { name: '1×', exact: true });
    await browserExpect(option).toBeVisible();
    expect(await option.evaluate((element) => document.fullscreenElement?.contains(element))).toBe(
      true,
    );
    await option.click();
    await screenshot('file-viewer-motion-fullscreen-en');
    // Browser-owned Escape must not close the file viewer. Some headless platforms retain fullscreen.
    await page.keyboard.press('Escape');
    await browserExpect(player).toBeVisible();
    if (await page.evaluate(() => Boolean(document.fullscreenElement))) {
      await page.evaluate(() => document.exitFullscreen());
    }
    await browserExpect(player).toBeVisible();
    await browserExpect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
      .toBe(false);
    const pip = player.getByRole('button', { name: 'Picture in picture', exact: true });
    const supported = await video.evaluate((element: HTMLVideoElement) =>
      Boolean(document.pictureInPictureEnabled && element.requestPictureInPicture),
    );
    expect(await pip.count()).toBe(supported ? 1 : 0);
    if (supported) {
      await pip.click();
      await browserExpect
        .poll(async () => {
          return (
            (await page.evaluate(() => Boolean(document.pictureInPictureElement))) ||
            (await player
              .getByText('Could not change the video display mode. Try again.', { exact: true })
              .isVisible())
          );
        })
        .toBe(true);
      if (await page.evaluate(() => Boolean(document.pictureInPictureElement))) {
        await player.getByRole('button', { name: 'Exit picture in picture', exact: true }).click();
        await browserExpect
          .poll(() => page.evaluate(() => Boolean(document.pictureInPictureElement)))
          .toBe(false);
      }
    }
  });

  it('hides controls during playback, keeps keyboard focus visible, and reports rejected display/play requests', async () => {
    await open();
    await ready();
    const player = page.locator('.motion-player');
    const video = player.locator('video');
    const stage = player.locator('.motion-stage-toggle');
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await browserExpect.poll(time).toBeGreaterThan(0.1);
    const bounds = await stage.boundingBox();
    if (!bounds) throw new Error('Missing video stage');
    await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + 100);
    await browserExpect(player).toHaveAttribute('data-controls', 'hidden', { timeout: 5000 });
    await page.mouse.down();
    await page.mouse.up();
    await browserExpect(player).toHaveAttribute('data-controls', 'visible');
    await page.mouse.click(bounds.x + bounds.width * 0.9, bounds.y + 100);
    await browserExpect(player).toHaveAttribute('data-controls', 'hidden');
    await page.keyboard.press('Tab');
    await browserExpect(player).toHaveAttribute('data-controls', 'visible');
    await browserExpect
      .poll(() =>
        player
          .locator('.motion-controls')
          .evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
    // Centre click above paused playback; the right-zone hide did not resume it.
    expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
    // Failure injection exercises rejected browser promises without claiming real platform rejection.
    await video.evaluate((element: HTMLVideoElement) => {
      element.play = () =>
        Promise.reject(new DOMException('Isolated blocked playback', 'NotAllowedError'));
    });
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await browserExpect(
      player.getByText('Playback could not start. Press Play to try again.', { exact: true }),
    ).toBeVisible();
    expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
    await video.evaluate((element) => {
      Reflect.deleteProperty(element, 'play');
    });
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
      .toBe(false);
    await player.getByRole('button', { name: 'Pause', exact: true }).click();
    await player.evaluate((element: HTMLElement) => {
      element.requestFullscreen = () =>
        Promise.reject(new DOMException('Isolated denied fullscreen', 'NotAllowedError'));
    });
    await player.getByRole('button', { name: 'Enter full screen', exact: true }).click();
    await browserExpect(
      player.getByText('Could not change the video display mode. Try again.', { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    await browserExpect(
      player.getByRole('button', { name: 'Enter full screen', exact: true }),
    ).toBeEnabled();
    await player.evaluate((element) => {
      Reflect.deleteProperty(element, 'requestFullscreen');
    });
  });

  it('shows loading and errors truthfully, retries, and releases native playback on exit', async () => {
    hold = true;
    try {
      await open('motion-loading.webm');
      await browserExpect(page.getByText('Loading video…', { exact: true })).toBeVisible();
      await screenshot('file-viewer-motion-loading-en');
      await page.getByRole('button', { name: 'Back to files', exact: true }).click();
      await browserExpect.poll(() => pending.size).toBe(0);
    } finally {
      hold = false;
      for (const response of pending) response.destroy();
    }
    reject = true;
    try {
      await open('motion-error.webm');
      await browserExpect(
        page.locator('.motion-player').getByRole('button', { name: 'Retry', exact: true }),
      ).toBeVisible();
      await screenshot('file-viewer-motion-error-en');
      expect(
        (await new AxeBuilder({ page }).include('.motion-player').analyze()).violations,
      ).toEqual([]);
      reject = false;
      await page
        .locator('.motion-player')
        .getByRole('button', { name: 'Retry', exact: true })
        .click();
      await ready();
    } finally {
      reject = false;
    }
    const detached = await page.locator('.motion-player video').elementHandle();
    if (!detached) throw new Error('Missing native video');
    await page.locator('.motion-player').getByRole('button', { name: 'Play', exact: true }).click();
    await browserExpect.poll(time).toBeGreaterThan(0.1);
    await page.getByRole('button', { name: 'Back to files', exact: true }).click();
    expect(
      await detached.evaluate((element: HTMLVideoElement) => ({
        connected: element.isConnected,
        paused: element.paused,
        source: element.getAttribute('src'),
      })),
    ).toEqual({ connected: false, paused: true, source: null });
    expect(errors).toEqual([]);
  });

  it('keeps Italian controls reachable at 390px and 320px without overflow', async () => {
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await ready();
    const player = page.locator('.motion-player');
    await browserExpect(
      player.getByRole('button', { name: 'Riproduci', exact: true }),
    ).toBeEnabled();
    await browserExpect(
      player.getByRole('slider', { name: 'Posizione di riproduzione', exact: true }),
    ).toBeVisible();
    await seek(14);
    await screenshot('file-viewer-motion-mobile-it');
    await page.setViewportSize({ width: 320, height: 740 });
    await player.getByRole('combobox', { name: /^Velocità di riproduzione/ }).click();
    await page.getByRole('option', { name: '1,25×', exact: true }).click();
    expect(
      await player.locator('video').evaluate((element: HTMLVideoElement) => element.playbackRate),
    ).toBe(1.25);
    const overflow = await player.evaluate((element) => ({
      width: element.clientWidth,
      content: element.scrollWidth,
    }));
    expect(overflow.content).toBeLessThanOrEqual(overflow.width + 1);
    await screenshot('file-viewer-motion-320-it');
    await page.setViewportSize({ width: 430, height: 740 });
    await player.getByRole('button', { name: 'Schermo intero', exact: true }).click();
    await browserExpect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
      .toBe(true);
    const controlsFit = await player.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return Array.from(
        element.querySelectorAll('.motion-controls button, .motion-controls input'),
      ).every((control) => {
        const box = control.getBoundingClientRect();
        return box.left >= bounds.left && box.right <= bounds.right && box.bottom <= bounds.bottom;
      });
    });
    expect(controlsFit).toBe(true);
    await screenshot('file-viewer-motion-fullscreen-430-it');
    await player.getByRole('button', { name: 'Esci da schermo intero', exact: true }).click();
    await browserExpect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
      .toBe(false);

    expect((await new AxeBuilder({ page }).include('.motion-player').analyze()).violations).toEqual(
      [],
    );
    expect(errors).toEqual([]);
  });
});
