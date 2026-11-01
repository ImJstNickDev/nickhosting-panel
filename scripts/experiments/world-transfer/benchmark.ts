import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { storagePath } from '../../../deploy/storage-root.mjs';
import { prepareArchiveTransfer } from '../../../packages/content-providers/src/archive-transfer.js';

// Synthetic local work only. These timings do not measure upload, Wings extraction
// or promotion, and do not establish the end-to-end three-second target.
const parent = storagePath('test-assets/world-transfer-feasibility');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(`${parent}/benchmark-`);
try {
  for (const compress of [false, true]) {
    const path = `${root}/${compress ? 'deflate' : 'stored'}.zip`;
    const archive = new ZipFile();
    const written = pipeline(archive.outputStream, createWriteStream(path, { flags: 'wx' }));
    const mappings = [];
    for (let index = 0; index < 512; index++) {
      const source = `wrapper/region/file-${index}.mca`;
      mappings.push({ source, target: `world/region/file-${index}.mca` });
      archive.addBuffer(randomBytes(64 * 1024), source, { compress });
    }
    archive.end();
    await written;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const verification = {
      path,
      sha256: hash.digest('hex'),
      identity: await lstat(path, { bigint: true }),
    };
    const start = performance.now();
    const transfer = await prepareArchiveTransfer(path, mappings, { verification });
    const prepared = performance.now();
    const reader = transfer.open().getReader();
    let transferred = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      transferred += next.value.byteLength;
    }
    reader.releaseLock();
    const receipt = await transfer.completion;
    const finished = performance.now();
    if (transferred !== transfer.contentLength || receipt.files.length !== mappings.length)
      throw new Error('Incomplete synthetic transfer');
    process.stdout.write(
      `${JSON.stringify({
        format: compress ? 'DEFLATE' : 'STORED',
        files: mappings.length,
        expandedBytes: receipt.bytes,
        archiveBytes: transfer.contentLength,
        prepareMs: Math.round(prepared - start),
        verifiedStreamMs: Math.round(finished - prepared),
        totalLocalMs: Math.round(finished - start),
      })}\n`,
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
