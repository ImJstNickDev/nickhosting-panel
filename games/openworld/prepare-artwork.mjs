// Cache the publisher's images for NickPanel. The public source repository contains no game assets.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

const local = new URL('./src/ui/assets/local/', import.meta.url);
const assets = [
  [
    'game.webp',
    'shot-5-800.webp',
    '624afacca14a7ad2848966e31bd608e699ba72b30bbbdc952f5d78196104678f',
  ],
  [
    'runtime.png',
    'icon-256.png',
    '3ffdb01d73684b13ecd8f868a1eaa62c739700de00cf9ad2bd42e0b393fd226f',
  ],
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
await mkdir(local, { recursive: true });
for (const [name, source, digest] of assets) {
  const file = new URL(name, local);
  try {
    if (hash(await readFile(file)) === digest) continue;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(new URL(source, 'https://www.play-openworld.com/assets/img/'), {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Cannot download Openworld artwork: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== digest) throw new Error(`Openworld artwork checksum mismatch for ${name}`);
  const pending = new URL(randomUUID(), local);
  try {
    await writeFile(pending, bytes, { flag: 'wx' });
    await rename(pending, file);
  } finally {
    await rm(pending, { force: true });
  }
}
