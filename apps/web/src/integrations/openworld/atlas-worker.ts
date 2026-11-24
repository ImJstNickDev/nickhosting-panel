import { buffers, decodeAtlas } from './atlas-geometry.js';
import { voxelSprites } from './atlas-materials.js';
import type { AtlasRequest } from './atlas-types.js';

self.onmessage = ({
  data,
}: MessageEvent<{
  id: number;
  request: AtlasRequest;
  face: number;
  bytes: ArrayBuffer;
  spriteIds?: ReadonlySet<number>;
}>) => {
  try {
    const decoded = decodeAtlas(data.request, data.face, data.bytes);
    const terrain =
      decoded.kind === 'quads' && data.request.kind === 'mesh' && data.spriteIds?.size
        ? voxelSprites(decoded, data.request.lod, data.spriteIds)
        : decoded;
    postMessage({ id: data.id, terrain }, { transfer: buffers(terrain) });
  } catch {
    postMessage({ id: data.id, error: true });
  }
};
