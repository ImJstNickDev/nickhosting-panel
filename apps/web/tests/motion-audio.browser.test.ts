import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AxeBuilder } from '@axe-core/playwright';
import { expect as browserExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHarness } from './harness.js';
import { journeyRequest, prepareJourneyIdentities } from './journey-fixture.js';
import { installBrowserFixtures } from './provider-fixture.js';

/** Original fixture: 40s VP9 320×180 at 4fps, two mono 48kHz Opus tracks.
 * English tone (eng) is 440Hz; Tono italiano (ita) is 880Hz. Each integer second
 * starts a 250ms gold video flash and a 50ms audio amplitude pulse, on shared PTS.
 * Rebuild using fixtures/generate-motion-audio.mjs; no third-party media.
 * Browser FFT proves the selected decoded audio, not physical speaker/display synchronization.
 */
describe('M5 Motion multiple audio tracks', () => {
  const browser = process.env.NH_BROWSER === 'firefox' ? 'firefox' : 'chromium';
  let harness: Awaited<ReturnType<typeof browserHarness>>;
  let provider: Awaited<ReturnType<typeof installBrowserFixtures>>;
  let page: Page;
  let body: Buffer;
  let endpoint: string;
  let base: string;
  let hold = false;
  const pending = new Set<ServerResponse>();
  const requests: { range: string | undefined; destination: string }[] = [];
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
      range: request.headers.range,
      destination: String(request.headers['sec-fetch-dest'] ?? ''),
    });
    if (hold) {
      pending.add(response);
      response.once('close', () => pending.delete(response));
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
    body = Buffer.from(
      await readFile(new URL('./fixtures/motion-audio.mkv.base64', import.meta.url), 'utf8'),
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
    remote.set('motion-audio.mkv', body);
    remote.set('motion-held.mkv', body);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const types: string[] = [];
      Object.defineProperty(window, 'motionFixtureMseTypes', { configurable: true, value: types });
      const add = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (type) {
        types.push(type);
        return add.call(this, type);
      };
    });
  });
  afterAll(async () => {
    for (const response of pending) response.destroy();
    provider?.dispose();
    await harness?.close();
  });
  async function open(name = 'motion-audio.mkv') {
    const back = page.getByRole('button', { name: /^(Back to files|Torna ai file)$/ });
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
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), {
        timeout: 15000,
      })
      .toBeGreaterThanOrEqual(2);
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.duration))
      .toBeCloseTo(40, 0);
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentSrc))
      .toMatch(/^blob:/);
    await browserExpect(
      page
        .locator('.motion-player')
        .getByRole('combobox', { name: /^(Audio track|Traccia audio)/ }),
    ).toBeEnabled();
  }
  async function select(name: RegExp) {
    await page
      .locator('.motion-player')
      .getByRole('combobox', { name: /^(Audio track|Traccia audio)/ })
      .click();
    await page.getByRole('option', { name }).click();
  }
  async function time() {
    return page
      .locator('.motion-player video')
      .evaluate((element: HTMLVideoElement) => element.currentTime);
  }
  async function frequency() {
    return page.locator('.motion-player video').evaluate((element) => {
      const probe = (
        element as HTMLVideoElement & {
          fixtureProbe: { context: AudioContext; analyser: AnalyserNode };
        }
      ).fixtureProbe;
      const values = new Float32Array(probe.analyser.frequencyBinCount);
      probe.analyser.getFloatFrequencyData(values);
      let strongest = 1;
      for (let index = 2; index < values.length; index++)
        if ((values[index] ?? -Infinity) > (values[strongest] ?? -Infinity)) strongest = index;
      return (values[strongest] ?? -Infinity) > -65
        ? (strongest * probe.context.sampleRate) / probe.analyser.fftSize
        : 0;
    });
  }
  async function installProbe() {
    await page.locator('.motion-player video').evaluate(async (element: HTMLVideoElement) => {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 8192;
      analyser.smoothingTimeConstant = 0;
      analyser.connect(context.destination);
      Object.defineProperty(element, 'fixtureProbe', {
        configurable: true,
        value: { context, analyser },
      });
      const resume = () => {
        void context
          .resume()
          .then(() => context.createMediaElementSource(element).connect(analyser))
          .catch(() => {});
      };
      document.addEventListener('click', resume, { once: true, capture: true });
    });
  }
  async function canAnalyse() {
    const available = await page.locator('.motion-player video').evaluate(async (element) => {
      const { context } = (
        element as HTMLVideoElement & { fixtureProbe: { context: AudioContext } }
      ).fixtureProbe;
      if (context.state === 'running') return true;
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2500);
        context.addEventListener(
          'statechange',
          () => {
            if (context.state === 'running') {
              clearTimeout(timer);
              resolve(true);
            }
          },
          { once: true },
        );
      });
    });
    if (!available && browser === 'chromium')
      throw new Error('Chromium WebAudio analysis must run');
    if (!available)
      console.info(
        'Firefox headless AudioContext remains suspended, also reproduced with an independent oscillator; FFT unavailable. MSE selection, video progression and settings are still asserted.',
      );
    return available;
  }
  async function closeProbe() {
    await page.locator('.motion-player video').evaluate(async (element) => {
      const probe = (element as HTMLVideoElement & { fixtureProbe?: { context: AudioContext } })
        .fixtureProbe;
      if (probe)
        await Promise.race([
          probe.context.close(),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      Reflect.deleteProperty(element, 'fixtureProbe');
    });
  }

  it('selects real decoded Opus audio while retaining the video element and playback settings', async () => {
    await open();
    await ready();
    const player = page.locator('.motion-player');
    const video = player.locator('video');
    const original = await video.elementHandle();
    if (!original) throw new Error('Missing Motion media');
    await installProbe();
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    try {
      const analysis = await canAnalyse();
      if (analysis) {
        await browserExpect.poll(frequency, { timeout: 15000 }).toBeGreaterThan(420);
        expect(await frequency()).toBeLessThan(460);
      } else await browserExpect.poll(time).toBeGreaterThan(0.2);
      const before = await time();
      await select(/Tono italiano/);
      if (analysis) {
        await browserExpect.poll(frequency, { timeout: 15000 }).toBeGreaterThan(850);
        expect(await frequency()).toBeLessThan(910);
      }
      await ready();
      await player.getByRole('combobox', { name: /^Audio track/ }).click();
      await browserExpect(page.getByRole('option', { name: /Tono italiano/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await page.keyboard.press('Escape');
      await browserExpect.poll(time).toBeGreaterThan(before + 0.1);
      expect(
        await original.evaluate(
          (element) => element === document.querySelector('.motion-player video'),
        ),
      ).toBe(true);
      expect(await time()).toBeGreaterThanOrEqual(before - 0.2);
      expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
      await player.getByRole('button', { name: 'Pause', exact: true }).click();
      await player.getByRole('combobox', { name: /^Playback speed/ }).click();
      await page.getByRole('option', { name: '1.5×', exact: true }).click();
      await video.evaluate((element: HTMLVideoElement) => {
        element.volume = 0.35;
      });
      await player.getByRole('button', { name: 'Mute', exact: true }).click();
      const pausedAt = await time();
      await select(/English tone/);
      await ready();
      expect(
        await video.evaluate((element: HTMLVideoElement) => ({
          paused: element.paused,
          rate: element.playbackRate,
          muted: element.muted,
          volume: element.volume,
        })),
      ).toEqual({ paused: true, rate: 1.5, muted: true, volume: 0.35 });
      expect(await time()).toBeCloseTo(pausedAt, 1);
      const types = await page.evaluate(
        () => (window as unknown as { motionFixtureMseTypes: string[] }).motionFixtureMseTypes,
      );
      expect(types.length).toBeGreaterThan(0);
      expect(types.every((type) => type.includes('video/mp4'))).toBe(true);
      expect(requests.some((request) => request.destination !== 'video' && request.range)).toBe(
        true,
      );
      await video.evaluate((element: HTMLVideoElement) => {
        element.currentTime = 5;
      });
      await browserExpect.poll(time).toBeCloseTo(5, 1);
      await browserExpect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.seeking))
        .toBe(false);
      await player.getByRole('combobox', { name: /^Audio track/ }).click();
      await browserExpect(page.getByRole('option', { name: /English tone/ })).toBeVisible();
      await browserExpect(page.getByRole('option', { name: /Tono italiano/ })).toBeVisible();
      await harness.screenshot(page, `file-viewer-motion-audio-desktop-en-${browser}`);
      await page.keyboard.press('Escape');
      expect(
        (await new AxeBuilder({ page }).include('.motion-player').analyze()).violations,
      ).toEqual([]);
    } finally {
      await closeProbe();
    }
  });

  it('seeks across the indexed file with bounded buffering and survives rapid track selections', async () => {
    await open();
    await ready();
    const player = page.locator('.motion-player');
    const video = player.locator('video');
    for (const target of [28, 3, 21]) {
      await video.evaluate((element: HTMLVideoElement, seconds) => {
        element.currentTime = seconds;
      }, target);
      await browserExpect.poll(time, { timeout: 15000 }).toBeCloseTo(target, 1);
      await browserExpect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), {
          timeout: 15000,
        })
        .toBeGreaterThanOrEqual(2);
      const buffered = await video.evaluate((element: HTMLVideoElement) => ({
        time: element.currentTime,
        start: element.buffered.length ? element.buffered.start(0) : 0,
        end: element.buffered.length ? element.buffered.end(element.buffered.length - 1) : 0,
      }));
      expect(buffered.end - buffered.time).toBeLessThanOrEqual(15);
      expect(buffered.time - buffered.start).toBeLessThanOrEqual(10);
    }
    for (const name of [/Tono italiano/, /English tone/, /Tono italiano/]) await select(name);
    await ready();
    await installProbe();
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    try {
      if (await canAnalyse()) {
        await browserExpect.poll(frequency, { timeout: 15000 }).toBeGreaterThan(850);
        expect(await frequency()).toBeLessThan(910);
      }
      await browserExpect.poll(time).toBeGreaterThan(21.1);
      expect(await time()).toBeGreaterThanOrEqual(20.8);
    } finally {
      await closeProbe();
    }
    const detached = await video.elementHandle();
    if (!detached) throw new Error('Missing video');
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

  it('repeats and replays from the MSE endpoint after seeking beyond the initial buffer', async () => {
    await open();
    await ready();
    const player = page.locator('.motion-player');
    const video = player.locator('video');
    await player.getByRole('button', { name: 'Repeat', exact: true }).click();
    await video.evaluate((element: HTMLVideoElement) => {
      element.currentTime = 39.5;
    });
    await browserExpect.poll(time, { timeout: 15000 }).toBeGreaterThan(39);
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), {
        timeout: 15000,
      })
      .toBeGreaterThanOrEqual(2);
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await browserExpect.poll(time, { timeout: 15000 }).toBeLessThan(3);
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
      .toBe(false);
    await player.getByRole('button', { name: 'Pause', exact: true }).click();
    await player.getByRole('button', { name: 'Repeat', exact: true }).click();
    await video.evaluate((element: HTMLVideoElement) => {
      element.currentTime = 40;
    });
    await browserExpect.poll(time, { timeout: 15000 }).toBeGreaterThan(39.8);
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await browserExpect.poll(time, { timeout: 15000 }).toBeLessThan(3);
    await browserExpect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
      .toBe(false);
  });

  it('aborts a held container read on exit and keeps Italian track options reachable on mobile', async () => {
    hold = true;
    try {
      await open('motion-held.mkv');
      await browserExpect.poll(() => pending.size).toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Back to files', exact: true }).click();
      await browserExpect.poll(() => pending.size).toBe(0);
    } finally {
      hold = false;
      for (const response of pending) response.destroy();
    }
    await journeyRequest(harness, page, '/api/auth/update-user', { locale: 'it' });
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await ready();
    const player = page.locator('.motion-player');
    await player.getByRole('combobox', { name: /^Traccia audio/ }).click();
    await browserExpect(page.getByRole('option', { name: /Tono italiano/ })).toBeVisible();
    await harness.screenshot(page, `file-viewer-motion-audio-mobile-it-${browser}`);
    await page.getByRole('option', { name: /Tono italiano/ }).click();
    await ready();
    await page.setViewportSize({ width: 320, height: 740 });
    const overflow = await player.evaluate((element) => ({
      width: element.clientWidth,
      content: element.scrollWidth,
    }));
    expect(overflow.content).toBeLessThanOrEqual(overflow.width + 1);
    expect((await new AxeBuilder({ page }).include('.motion-player').analyze()).violations).toEqual(
      [],
    );
    expect(errors).toEqual([]);
  });
});
