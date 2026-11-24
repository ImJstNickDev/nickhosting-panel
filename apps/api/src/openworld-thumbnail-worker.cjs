const { Readable } = require('node:stream');
const { parentPort, workerData } = require('node:worker_threads');
const { crc32, createInflate } = require('node:zlib');
const { PNG } = require('pngjs');

function readImage(input) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    input.length < 45 ||
    input.length > 16 * 1024 * 1024 ||
    !input.subarray(0, 8).equals(signature)
  )
    throw new Error('Invalid PNG');
  const width = input.readUInt32BE(16);
  const height = input.readUInt32BE(20);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[input[25]];
  if (
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 8192 * 4320 ||
    !channels ||
    input[24] !== 8 ||
    input[26] !== 0 ||
    input[27] !== 0 ||
    input[28] !== 0
  )
    throw new Error('Unsupported PNG header');
  let offset = 8;
  const data = [];
  for (let chunks = 0; chunks < 16384 && offset + 12 <= input.length; chunks++) {
    const length = input.readUInt32BE(offset);
    const end = offset + length + 12;
    if (
      end > input.length ||
      crc32(input.subarray(offset + 4, end - 4)) !== input.readUInt32BE(end - 4)
    )
      break;
    const type = input.toString('latin1', offset + 4, offset + 8);
    if (chunks === 0) {
      if (type !== 'IHDR' || length !== 13) break;
    } else if (type === 'IDAT') data.push(input.subarray(offset + 8, end - 4));
    else if (type === 'IEND') {
      if (length === 0 && end === input.length && data.length)
        return { width, height, channels, data };
      break;
    } else if (
      !/^[a-z][A-Za-z][A-Z][A-Za-z]$/.test(type) ||
      ['acTL', 'fcTL', 'fdAT'].includes(type)
    )
      break;
    offset = end;
  }
  throw new Error('Invalid PNG framing');
}

function paeth(left, up, corner) {
  const a = Math.abs(up - corner),
    b = Math.abs(left - corner),
    c = Math.abs(left + up - 2 * corner);
  return a <= b && a <= c ? left : b <= c ? up : corner;
}

function unfilter(filter, pixels, prev, channels) {
  if (filter === 0) return;
  if (filter > 4) throw new Error('Invalid PNG filter');
  for (let i = 0; i < pixels.length; i++) {
    const left = i >= channels ? pixels[i - channels] : 0;
    const up = prev[i];
    if (filter === 1) pixels[i] += left;
    else if (filter === 2) pixels[i] += up;
    else if (filter === 3) pixels[i] += (left + up) >>> 1;
    else pixels[i] += paeth(left, up, i >= channels ? prev[i - channels] : 0);
  }
}

// Decode two scanlines at a time. Two simultaneous 8K screenshots still fit the
// API's memory budget, and original pixel buffers never enter its event loop.
async function thumbnail(input) {
  const { width, height, channels, data } = readImage(input);
  const scale = Math.min(1, 320 / Math.max(width, height));
  const output = new PNG({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  });
  const counts = new Uint32Array(output.width * output.height);
  const sums = new Uint32Array(counts.length * 4);
  const columns = Array.from({ length: width }, (_, x) => Math.floor((x * output.width) / width));
  const stride = width * channels;
  let prior = Buffer.alloc(stride);
  let row = Buffer.alloc(stride);
  let y = 0,
    filled = -1,
    filter = 0;
  const stream = Readable.from(data).pipe(createInflate({ chunkSize: 64 * 1024 }));
  for await (const chunk of stream) {
    let at = 0;
    while (at < chunk.length) {
      if (y >= height) throw new Error('Excess PNG data');
      if (filled === -1) {
        filter = chunk[at++];
        filled = 0;
      }
      const bytes = Math.min(chunk.length - at, stride - filled);
      chunk.copy(row, filled, at, at + bytes);
      at += bytes;
      filled += bytes;
      if (filled !== stride) continue;
      unfilter(filter, row, prior, channels);
      const destRow = Math.floor((y * output.height) / height) * output.width;
      for (let x = 0, i = 0; x < width; x++, i += channels) {
        const pixel = destRow + columns[x],
          target = pixel * 4;
        counts[pixel]++;
        sums[target] += row[i];
        sums[target + 1] += channels < 3 ? row[i] : row[i + 1];
        sums[target + 2] += channels < 3 ? row[i] : row[i + 2];
        sums[target + 3] += channels === 2 || channels === 4 ? row[i + channels - 1] : 255;
      }
      y++;
      filled = -1;
      [prior, row] = [row, prior];
    }
  }
  if (y !== height || filled !== -1) throw new Error('Truncated PNG');
  for (let i = 0; i < sums.length; i++) output.data[i] = Math.round(sums[i] / counts[i >>> 2]);
  return PNG.sync.write(output);
}

thumbnail(Buffer.from(workerData.buffer, workerData.byteOffset, workerData.byteLength)).then(
  (png) => {
    const bytes = Uint8Array.from(png);
    parentPort.postMessage(bytes, [bytes.buffer]);
  },
  () => parentPort.postMessage(null),
);
