import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { motionTimingInput } from '../../api/src/viewer-timing.js';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

/** Original 12s VP9/Opus media, single audio and real indexed Matroska subtitle blocks.
 * SRT / ASS / SSA / WebVTT windows are 1–4s and 6–9s. Unsupported PGS is metadata-only.
 * Rebuild with fixtures/generate-motion-subtitles.mjs. Renderer/decoder code is not mocked.
 */
describe('M5 Motion embedded subtitles', () => {
  const browser = process.env.NH_BROWSER === 'firefox' ? 'firefox' : 'chromium';
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let endpoint: string;
  let base: string;
  const media = new Map<string, Buffer>();
  const errors: string[] = [];
  const requests: { path: string; range: string | undefined }[] = [];
  let debugTiming = false;
  const timingBatches: unknown[] = [];

  function serve(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    if (!endpoint || !url.pathname.startsWith(`${endpoint}/`)) return false;
    if (url.pathname.endsWith('/motion-timing') && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        timingBatches.push(JSON.parse(body));
        response.writeHead(204);
        response.end();
      });
      return true;
    }
    if (url.pathname.endsWith('/capabilities') || url.pathname.endsWith('/preferences')) {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(
        JSON.stringify(
          url.pathname.endsWith('/capabilities')
            ? { available: true, ...(debugTiming ? { debugTiming: true } : {}) }
            : { preferences: [] },
        ),
      );
      return true;
    }
    if (!url.pathname.endsWith('/content')) return false;
    const path = (url.searchParams.get('path') ?? '').replace(/^\//, '');
    const body = media.get(path);
    if (!body) return false;
    requests.push({ path, range: request.headers.range });
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = Math.min(range?.[2] ? Number(range[2]) : body.length - 1, body.length - 1);
    if (start > end) {
      response.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
      response.end();
      return true;
    }
    response.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/x-matroska',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}),
    });
    response.end(body.subarray(start, end + 1));
    return true;
  }
  beforeAll(async () => {
    for (const name of ['motion-subtitles.mkv', 'motion-subtitles-single.mkv'])
      media.set(
        name,
        Buffer.from(
          await readFile(new URL(`./fixtures/${name}.base64`, import.meta.url), 'utf8'),
          'base64',
        ),
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
    for (const [name, bytes] of media) remote.set(name, bytes);
    page.on('pageerror', (error) => errors.push(error.message));
  });
  afterAll(async () => {
    provider?.dispose();
    await harness?.close();
  });
  async function open(name = 'motion-subtitles.mkv') {
    const back = page.getByRole('button', { name: /^(Back to files|Torna ai file)$/ });
    if (await back.isVisible()) await back.click();
    await page.goto(base);
    const file = page.locator('.fm-filename').getByText(name, { exact: true });
    await browserExpect
      .poll(async () => (await file.isVisible()) || (await back.isVisible()))
      .toBe(true);
    if (await back.isVisible()) await back.click();
    await file.click();
    const video = page.locator('.motion-player video');
    await browserExpect(video).toBeVisible();
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), {
        timeout: 15000,
      })
      .toBeGreaterThanOrEqual(2);
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.duration))
      .toBeCloseTo(12, 0);
    await browserExpect(
      page
        .locator('.motion-player')
        .getByRole('combobox', { name: /^(Audio track|Traccia audio)/ }),
    ).toHaveCount(0);
  }
  async function seek(seconds: number) {
    const video = page.locator('.motion-player video');
    await video.evaluate((element: HTMLVideoElement, value) => {
      element.currentTime = value;
    }, seconds);
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
      .toBeCloseTo(seconds, 1);
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.seeking))
      .toBe(false);
  }
  async function choose(name: RegExp) {
    await page
      .locator('.motion-player')
      .getByRole('combobox', { name: /^(Subtitle track|Traccia sottotitoli)/ })
      .click();
    await page.getByRole('option', { name }).click();
  }
  async function yellowCaptionPixels() {
    const overlay = page.locator('.motion-subtitles');
    const image = (await overlay.screenshot()).toString('base64');
    return page.evaluate(async (png) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Missing screenshot decoder');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let yellow = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (
          (pixels[i] ?? 0) > 160 &&
          (pixels[i + 1] ?? 0) > 150 &&
          (pixels[i + 2] ?? 255) < 100 &&
          (pixels[i + 3] ?? 0) > 128
        )
          yellow++;
      return yellow;
    }, image);
  }

  it('renders timed SRT/WebVTT from the native video clock, switches off, and treats unsupported tracks honestly', async () => {
    await open();
    const player = page.locator('.motion-player');
    const original = await player.locator('video').elementHandle();
    if (!original) throw new Error('Missing native video');
    const originalSource = await original.evaluate(
      (element: HTMLVideoElement) => element.currentSrc,
    );
    // Actual native playback must cross cue boundaries at the video's chosen speed;
    // paused seek tests alone cannot establish that frame-driven rendering advances.
    await seek(0.75);
    await original.evaluate((element: HTMLVideoElement) => {
      element.playbackRate = 2;
    });
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await browserExpect(player.locator('.motion-subtitles')).toContainText('English first caption');
    await original.evaluate((element: HTMLVideoElement) => {
      element.currentTime = 3.6;
    });
    await browserExpect
      .poll(() => original.evaluate((element: HTMLVideoElement) => element.currentTime))
      .toBeGreaterThan(4.2);
    await browserExpect(player.locator('.motion-subtitles')).not.toContainText(
      'English first caption',
    );
    await player.getByRole('button', { name: 'Pause', exact: true }).click();
    await original.evaluate((element: HTMLVideoElement) => {
      element.playbackRate = 1;
    });
    await seek(2.25);
    await browserExpect(player.locator('.motion-subtitles')).toContainText('English first caption');
    await choose(/WebVTT italiano/);
    await browserExpect(player.locator('.motion-subtitles')).toContainText('Prima didascalia');
    await seek(4.5);
    await browserExpect(player.locator('.motion-subtitles')).not.toContainText('Prima didascalia');
    await seek(7.25);
    await browserExpect(player.locator('.motion-subtitles')).toContainText('Seconda didascalia');
    await choose(/English text/);
    await browserExpect(player.locator('.motion-subtitles')).toContainText(
      'English second caption',
    );
    await browserExpect(
      player.locator('.motion-subtitles img, .motion-subtitles script'),
    ).toHaveCount(0);
    await choose(/^Off$/);
    await browserExpect(player.locator('.motion-subtitles')).not.toContainText(
      'English second caption',
    );
    await player.getByRole('combobox', { name: /^Subtitle track/ }).click();
    await browserExpect(page.getByRole('option', { name: /Bitmap PGS/ })).toBeDisabled();
    await page.keyboard.press('Escape');
    expect(
      await original.evaluate(
        (element) => element === document.querySelector('.motion-player video'),
      ),
    ).toBe(true);
    expect(await original.evaluate((element: HTMLVideoElement) => element.currentSrc)).toBe(
      originalSource,
    );
    expect(
      await original.evaluate((element: HTMLVideoElement) => ({
        time: element.currentTime,
        paused: element.paused,
      })),
    ).toEqual({ time: 7.25, paused: true });
    expect(requests.some((request) => request.range)).toBe(true);
    expect(errors).toEqual([]);
  });

  it('renders ASS and SSA with the real JASSUB worker and removes old cues after seeks', async () => {
    await open();
    await seek(2.25);
    for (const track of [/Styled ASS/, /Legacy SSA/]) {
      await choose(track);
      await browserExpect(page.locator('.motion-subtitles canvas')).toBeVisible({ timeout: 20000 });
      await browserExpect
        .poll(yellowCaptionPixels, { timeout: 20000, intervals: [200, 500] })
        .toBeGreaterThan(50);
      await seek(4.5);
      await browserExpect.poll(yellowCaptionPixels, { timeout: 10000 }).toBe(0);
      await seek(7.25);
      await browserExpect.poll(yellowCaptionPixels, { timeout: 10000 }).toBeGreaterThan(50);
      await seek(2.25);
    }
    await choose(/Styled ASS/);
    await browserExpect.poll(yellowCaptionPixels, { timeout: 15000 }).toBeGreaterThan(50);
    await harness.screenshot(page, `file-viewer-motion-subtitles-desktop-en-${browser}`);
    const canvas = await page.locator('.motion-subtitles canvas').elementHandle();
    if (!canvas) throw new Error('Missing libass canvas');
    await choose(/^Off$/);
    await browserExpect(page.locator('.motion-subtitles canvas')).toHaveCount(0);
    expect(await canvas.evaluate((element) => element.isConnected)).toBe(false);
    expect(errors).toEqual([]);
  });

  it('hides single audio/subtitle selectors and keeps the lone caption toggle in settings', async () => {
    await open('motion-subtitles-single.mkv');
    const player = page.locator('.motion-player');
    await seek(2.25);
    await browserExpect(player.locator('.motion-subtitles')).toContainText('English first caption');
    await browserExpect(player.getByRole('combobox', { name: /^Subtitle track/ })).toHaveCount(0);
    await player.getByRole('combobox', { name: /^Playback settings/ }).click();
    await page.getByRole('option', { name: 'Subtitles off', exact: true }).click();
    await browserExpect(player.locator('.motion-subtitles')).not.toContainText(
      'English first caption',
    );
    await player.getByRole('combobox', { name: /^Playback settings/ }).click();
    await page.getByRole('option', { name: 'Subtitles on', exact: true }).click();
    await browserExpect(player.locator('.motion-subtitles')).toContainText('English first caption');
    expect((await new AxeBuilder({ page }).include('.motion-player').analyze()).violations).toEqual(
      [],
    );
  });

  it('keeps Italian mobile controls accessible and clears subtitle media when leaving Motion', async () => {
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await seek(2.25);
    await choose(/WebVTT italiano/);
    await browserExpect(page.locator('.motion-subtitles')).toContainText('Prima didascalia');
    await page
      .locator('.motion-player')
      .getByRole('combobox', { name: /^Traccia sottotitoli/ })
      .click();
    await browserExpect(
      page.getByRole('option', { name: 'Disattivati', exact: true }),
    ).toBeVisible();
    await harness.screenshot(page, `file-viewer-motion-subtitles-mobile-it-${browser}`);
    await page.keyboard.press('Escape');
    expect((await new AxeBuilder({ page }).include('.motion-player').analyze()).violations).toEqual(
      [],
    );
    await page.setViewportSize({ width: 320, height: 740 });
    const dimensions = await page
      .locator('.motion-player')
      .evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
    await browserExpect(page.locator('.motion-caption-cue')).toContainText('Seconda riga');
    await browserExpect
      .poll(() =>
        page.locator('.motion-player').evaluate((element) => {
          const caption = element.querySelector('.motion-caption-cue')?.getBoundingClientRect();
          const controls = element.querySelector('.motion-controls')?.getBoundingClientRect();
          const player = element.getBoundingClientRect();
          return caption && controls
            ? Math.min(caption.top - player.top, controls.top - caption.bottom)
            : Number.NEGATIVE_INFINITY;
        }),
      )
      .toBeGreaterThanOrEqual(-1);
    const video = await page.locator('.motion-player video').elementHandle();
    if (!video) throw new Error('Missing native video');
    await page.getByRole('button', { name: 'Torna ai file', exact: true }).click();
    expect(
      await video.evaluate((element: HTMLVideoElement) => ({
        connected: element.isConnected,
        paused: element.paused,
        source: element.getAttribute('src'),
      })),
    ).toEqual({ connected: false, paused: true, source: null });
    await browserExpect(page.locator('.motion-subtitles')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
  it('records bounded debug milestones without resetting playback and is silent when disabled', async () => {
    expect(timingBatches).toEqual([]);
    debugTiming = true;
    await open();
    const video = page.locator('.motion-player video');
    await browserExpect.poll(() => timingBatches.length).toBeGreaterThan(0);
    await browserExpect
      .poll(() =>
        timingBatches
          .flatMap((batch) => motionTimingInput.parse(batch).events)
          .some((event) => event.phase === 'video.discovery' && event.outcome === 'succeeded'),
      )
      .toBe(true);
    const src = await video.getAttribute('src');
    expect(src).toContain('motionTrace=');
    // A paused buffering interval must not count time spent deliberately paused.
    await video.evaluate((element) => {
      element.dispatchEvent(new Event('waiting'));
      element.dispatchEvent(new Event('pause'));
    });
    await browserExpect
      .poll(() =>
        timingBatches
          .flatMap((batch) => motionTimingInput.parse(batch).events)
          .some((event) => event.phase === 'native.waiting' && event.outcome === 'cancelled'),
      )
      .toBe(true);
    await seek(2);
    await browserExpect(page.locator('.motion-subtitles')).toContainText('English first caption');
    expect(await video.getAttribute('src')).toBe(src);
    await browserExpect
      .poll(() =>
        timingBatches
          .flatMap((batch) => motionTimingInput.parse(batch).events)
          .some((event) => event.phase === 'native.seek' && event.outcome === 'succeeded'),
      )
      .toBe(true);
    const batches = timingBatches.map((batch) => motionTimingInput.parse(batch));
    expect(new Set(batches.map((batch) => batch.traceId)).size).toBe(1);
    expect(
      batches.flatMap((batch) => batch.events).filter((event) => event.phase === 'viewer.mounted'),
    ).toHaveLength(1);
    expect(JSON.stringify(batches)).not.toContain('motion-subtitles.mkv');
    expect(errors).toEqual([]);
    await page.getByRole('button', { name: /^(Back to files|Torna ai file)$/ }).click();
    debugTiming = false;
  });
});
