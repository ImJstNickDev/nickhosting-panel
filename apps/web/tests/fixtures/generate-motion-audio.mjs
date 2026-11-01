/** Rebuild with: scripts/dev.sh node apps/web/tests/fixtures/generate-motion-audio.mjs
 * Original canvas/sine artwork, encoded locally using the project's pinned browser and Mediabunny.
 * Starts one temporary loopback HTTP listener so WebCodecs runs in a secure context; no app/infra access.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { chromium } from '@playwright/test';

const moduleBytes = await readFile(
  new URL('../../node_modules/mediabunny/dist/bundles/mediabunny.mjs', import.meta.url),
);
const listener = createServer((request, response) => {
  response.setHeader(
    'Content-Type',
    request.url === '/bunny.mjs' ? 'text/javascript' : 'text/html',
  );
  response.end(
    request.url === '/bunny.mjs'
      ? moduleBytes
      : '<!doctype html><title>Original fixture generator</title>',
  );
});
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const address = listener.address();
if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
const libraries = `${homedir()}/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu`;
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(libraries)
    ? {
        env: {
          ...process.env,
          LD_LIBRARY_PATH: [libraries, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
        },
      }
    : {}),
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  const encoded = await page.evaluate(async () => {
    const { Output, BufferTarget, MkvOutputFormat, CanvasSource, AudioSampleSource, AudioSample } =
      await import('/bunny.mjs');
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Missing 2D canvas');
    const output = new Output({
      target: new BufferTarget(),
      format: new MkvOutputFormat({ minimumClusterDuration: 1 }),
    });
    const video = new CanvasSource(canvas, { codec: 'vp9', bitrate: 20_000, keyFrameInterval: 1 });
    const audio = [
      new AudioSampleSource({ codec: 'opus', bitrate: 16_000 }),
      new AudioSampleSource({ codec: 'opus', bitrate: 16_000 }),
    ];
    output.addVideoTrack(video, { name: 'Original sync marker', frameRate: 4 });
    output.addAudioTrack(audio[0], {
      name: 'English tone',
      languageCode: 'eng',
      disposition: { default: true },
    });
    output.addAudioTrack(audio[1], { name: 'Tono italiano', languageCode: 'ita' });
    await output.start();
    for (let frame = 0; frame < 160; frame++) {
      const timestamp = frame / 4;
      context.fillStyle =
        frame % 4 === 0
          ? '#f1d180'
          : ['#236071', '#b56337', '#3c7350', '#664c8a'][Math.floor(frame / 40) % 4];
      context.fillRect(0, 0, 320, 180);
      context.fillStyle = '#101519';
      context.font = '20px monospace';
      context.fillText(`SYNC ${timestamp.toFixed(2)} s`, 25, 90);
      await video.add(timestamp, 0.25, { keyFrame: frame % 4 === 0 });
      for (let track = 0; track < 2; track++) {
        const samples = new Float32Array(12_000);
        for (let n = 0; n < samples.length; n++) {
          const seconds = timestamp + n / 48_000;
          samples[n] =
            (seconds % 1 < 0.05 ? 0.7 : 0.25) *
            Math.sin(2 * Math.PI * (track === 0 ? 440 : 880) * seconds);
        }
        const sample = new AudioSample({
          data: samples,
          format: 'f32-planar',
          numberOfChannels: 1,
          sampleRate: 48_000,
          timestamp,
        });
        await audio[track].add(sample);
        sample.close();
      }
    }
    video.close();
    for (const source of audio) source.close();
    await output.finalize();
    let binary = '';
    for (const byte of new Uint8Array(output.target.buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  await writeFile(new URL('./motion-audio.mkv.base64', import.meta.url), `${encoded}\n`);
  console.info(`Wrote original multitrack fixture: ${Buffer.from(encoded, 'base64').length} bytes`);
} finally {
  await browser.close();
  listener.close();
}
