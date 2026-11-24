// Mask rows are aligned to 16 columns. Compare four ranks at a time and upload
// only the changed rectangle when a streamed tile refines an existing texture.
export function changedMaskArea(previous: Uint8Array, next: Uint8Array, width: number) {
  const before = new Uint32Array(previous.buffer, previous.byteOffset, previous.byteLength / 4);
  const after = new Uint32Array(next.buffer, next.byteOffset, next.byteLength / 4);
  const wordsPerRow = width / 4;
  let minX = wordsPerRow;
  let maxX = -1;
  let minY = next.length / width;
  let maxY = -1;
  for (let row = 0; row < after.length; row += wordsPerRow) {
    let left = 0;
    while (left < wordsPerRow && before[row + left] === after[row + left]) left++;
    if (left === wordsPerRow) continue;
    let right = wordsPerRow - 1;
    while (right > left && before[row + right] === after[row + right]) right--;
    minX = Math.min(left, minX);
    maxX = Math.max(right, maxX);
    const y = row / wordsPerRow;
    minY = Math.min(minY, y);
    maxY = y;
  }
  return maxX < 0
    ? null
    : { x: minX * 4, y: minY, width: (maxX - minX + 1) * 4, height: maxY - minY + 1 };
}
