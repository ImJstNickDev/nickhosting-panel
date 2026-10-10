import { sha256 } from '@noble/hashes/sha2.js';

globalThis.onmessage = async (event: MessageEvent<Blob>) => {
  const file = event.data;
  try {
    const hash = sha256.create();
    const chunkSize = 1024 * 1024;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      hash.update(new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer()));
      globalThis.postMessage({ bytes: Math.min(offset + chunkSize, file.size) });
    }
    globalThis.postMessage({
      sha256: Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    });
  } catch {
    globalThis.postMessage({ error: 'web.errors.fileRead' });
  }
};
