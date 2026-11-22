import { buffers, decodeAtlas } from './atlas-geometry.js';
import type { AtlasRequest } from './atlas-types.js';

self.onmessage = ({
  data,
}: MessageEvent<{ id: number; request: AtlasRequest; face: number; bytes: ArrayBuffer }>) => {
  try {
    const terrain = decodeAtlas(data.request, data.face, data.bytes);
    postMessage({ id: data.id, terrain }, { transfer: buffers(terrain) });
  } catch {
    postMessage({ id: data.id, error: true });
  }
};
