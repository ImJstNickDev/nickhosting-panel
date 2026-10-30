import { previewLimits } from '../core/limits.js';

/** Bound a single iconset before the library allocates decoded frames. */
export function validateIconset(bytes: Uint8Array<ArrayBuffer>) {
  if (bytes.byteLength < 6) throw { messageKey: 'viewer.imageUnavailable' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  if (
    view.getUint16(0, true) !== 0 ||
    view.getUint16(2, true) !== 1 ||
    count === 0 ||
    count > previewLimits.iconFrames ||
    bytes.byteLength < 6 + count * 16
  )
    throw { messageKey: 'viewer.imageUnavailable' };
  let pixels = 0;
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 16;
    const width = view.getUint8(at) || 256,
      height = view.getUint8(at + 1) || 256;
    pixels += width * height;
    const length = view.getUint32(at + 8, true),
      offset = view.getUint32(at + 12, true);
    if (
      pixels > previewLimits.iconPixels ||
      offset < 6 + count * 16 ||
      length === 0 ||
      offset + length > bytes.byteLength
    )
      throw { messageKey: 'viewer.imageUnavailable' };
    const png =
      length >= 8 &&
      view.getUint32(offset) === 0x89504e47 &&
      view.getUint32(offset + 4) === 0x0d0a1a0a;
    if (png) {
      if (
        length < 24 ||
        view.getUint32(offset + 16) !== width ||
        view.getUint32(offset + 20) !== height
      )
        throw { messageKey: 'viewer.imageUnavailable' };
    } else {
      // icojs's DIB decoder uses these dimensions for allocation, not the directory values.
      // ICO bitmap height includes the transparency mask beneath the color bitmap.
      const headerSize = length >= 40 ? view.getUint32(offset, true) : 0;
      if (
        ![40, 52, 56, 108, 124].includes(headerSize) ||
        headerSize > length ||
        view.getInt32(offset + 4, true) !== width ||
        view.getInt32(offset + 8, true) !== height * 2 ||
        view.getUint16(offset + 12, true) !== 1 ||
        ![1, 4, 8, 16, 24, 32].includes(view.getUint16(offset + 14, true)) ||
        view.getUint32(offset + 32, true) > 256
      )
        throw { messageKey: 'viewer.imageUnavailable' };
    }
  }
}
