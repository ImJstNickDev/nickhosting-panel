/** Rebuild with: scripts/dev.sh node apps/web/tests/fixtures/generate-motion-subtitles.mjs
 * Original media and captions only. Reuses the first twelve seconds / first audio track
 * of generate-motion-audio.mjs, then writes Matroska subtitle tracks, blocks and seek indexes.
 * No transcoder, provider connection, infrastructure or third-party artwork is used.
 */
import { readFile, writeFile } from 'node:fs/promises';

const original = Buffer.from(
  await readFile(new URL('./motion-audio.mkv.base64', import.meta.url), 'utf8'),
  'base64',
);
const id = {
  segment: 0x18538067,
  info: 0x1549a966,
  tracks: 0x1654ae6b,
  track: 0xae,
  cluster: 0x1f43b675,
  time: 0xe7,
  block: 0xa1,
  simple: 0xa3,
  group: 0xa0,
  seek: 0x114d9b74,
  cues: 0x1c53bb6b,
};
function vint(bytes, offset, identifier = false) {
  let length = 1;
  while (length <= 8 && !(bytes[offset] & (1 << (8 - length)))) length++;
  if (length > 8 || offset + length > bytes.length) throw new Error('Invalid fixture EBML');
  let value = identifier ? bytes[offset] : bytes[offset] & ((1 << (8 - length)) - 1);
  for (let n = 1; n < length; n++) value = value * 256 + bytes[offset + n];
  return { value, length };
}
function elements(bytes) {
  const result = [];
  for (let offset = 0; offset < bytes.length; ) {
    const tag = vint(bytes, offset, true);
    const size = vint(bytes, offset + tag.length);
    const start = offset + tag.length + size.length;
    const end = start + size.value;
    if (end > bytes.length) throw new Error('Truncated fixture EBML');
    result.push({
      id: tag.value,
      body: bytes.subarray(start, end),
      raw: bytes.subarray(offset, end),
    });
    offset = end;
  }
  return result;
}
function number(value, width) {
  if (!width) width = Math.max(1, Math.ceil(Math.log2(value + 1) / 8));
  const result = Buffer.alloc(width);
  result.writeUIntBE(value, 0, width);
  return result;
}
function size(value) {
  let width = 1;
  while (value >= 2 ** (7 * width) - 1) width++;
  const result = number(value, width);
  result[0] |= 1 << (8 - width);
  return result;
}
function element(tag, body) {
  const value = Array.isArray(body)
    ? Buffer.concat(body)
    : typeof body === 'string'
      ? Buffer.from(body)
      : body;
  return Buffer.concat([number(tag), size(value.length), value]);
}
function uint(tag, value) {
  return element(tag, number(value));
}
function value(bytes) {
  return bytes.readUIntBE(0, bytes.length);
}
function field(entry, tag) {
  return elements(entry.body).find((part) => part.id === tag);
}
const parts = elements(original);
const header = parts[0].raw;
const originalSegment = elements(parts.find((part) => part.id === id.segment).body);
const originalInfo = originalSegment.find((part) => part.id === id.info);
const duration = Buffer.alloc(8);
duration.writeDoubleBE(12000);
const info = element(
  id.info,
  elements(originalInfo.body).map((part) =>
    part.id === 0x4489 ? element(0x4489, duration) : part.raw,
  ),
);
const nativeTracks = elements(originalSegment.find((part) => part.id === id.tracks).body)
  .filter((entry) => value(field(entry, 0xd7).body) <= 2)
  .map((entry) => entry.raw);
const assHeader = `[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 180\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,24,&H0000FFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1,0,2,8,8,20,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
const ssaHeader = `[Script Info]\nScriptType: v4.00\nPlayResX: 320\nPlayResY: 180\n\n[V4 Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding\nStyle: Default,Arial,24,65535,255,0,0,0,0,1,1,0,2,8,8,20,0,1\n\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
const trackTypes = [
  {
    name: 'English text',
    codec: 'S_TEXT/UTF8',
    language: 'eng',
    default: true,
    cues: ['English first caption', 'English second caption &lt;img src=x onerror=alert(1)&gt;'],
  },
  {
    name: 'Styled ASS',
    codec: 'S_TEXT/ASS',
    language: 'eng',
    private: assHeader,
    cues: [
      '0,0,Default,,0,0,0,,{\\b1}Styled first caption',
      '1,0,Default,,0,0,0,,Styled second caption',
    ],
  },
  {
    name: 'Legacy SSA',
    codec: 'S_TEXT/SSA',
    language: 'eng',
    private: ssaHeader,
    cues: ['0,0,Default,,0,0,0,,Legacy first caption', '1,0,Default,,0,0,0,,Legacy second caption'],
  },
  {
    name: 'WebVTT italiano',
    codec: 'S_TEXT/WEBVTT',
    language: 'ita',
    private: 'WEBVTT\n',
    cues: ['Prima didascalia\nSeconda riga', 'Seconda didascalia'],
    additions: ['line:80%\nfirst', '\nsecond'],
  },
  { name: 'Bitmap PGS', codec: 'S_HDMV/PGS', language: 'eng', cues: [] },
];
function subtitleTrack(track, index) {
  return element(id.track, [
    uint(0xd7, index + 3),
    uint(0x73c5, index + 3),
    uint(0x83, 17),
    uint(0x88, track.default ? 1 : 0),
    uint(0x9c, 0),
    element(0x536e, track.name),
    element(0x22b59c, track.language),
    element(0x86, track.codec),
    ...(track.private ? [element(0x63a2, track.private)] : []),
  ]);
}
function subtitleBlock(track, index, cue, relative) {
  const prefix = Buffer.alloc(4);
  prefix[0] = 0x80 | (index + 3);
  prefix.writeInt16BE(relative, 1);
  return element(id.group, [
    element(id.block, [prefix, Buffer.from(track.cues[cue])]),
    uint(0x9b, 3000),
    ...(track.additions
      ? [element(0x75a1, [element(0xa6, [uint(0xee, 1), element(0xa5, track.additions[cue])])])]
      : []),
  ]);
}
function seekHead(positions) {
  return element(
    id.seek,
    [id.info, id.tracks, id.cues].map((tag) =>
      element(0x4dbb, [
        element(0x53ab, number(tag)),
        element(0x53ac, number(positions[tag] ?? 0, 6)),
      ]),
    ),
  );
}
for (const single of [false, true]) {
  const subtitleTracks = single ? trackTypes.slice(0, 1) : trackTypes;
  const tracks = element(id.tracks, [...nativeTracks, ...subtitleTracks.map(subtitleTrack)]);
  const clusters = originalSegment
    .filter((part) => part.id === id.cluster)
    .flatMap((part) => {
      const entries = elements(part.body);
      const timestamp = value(entries.find((entry) => entry.id === id.time).body);
      if (timestamp >= 12000) return [];
      const retained = entries
        .filter((entry) => {
          const block =
            entry.id === id.simple
              ? entry.body
              : entry.id === id.group
                ? field(entry, id.block)?.body
                : undefined;
          return !block || vint(block, 0).value <= 2;
        })
        .map((entry) => entry.raw);
      const subtitleCues = [];
      for (const [index, track] of subtitleTracks.entries()) {
        for (const [cue, start] of [1000, 6000].entries()) {
          if (track.cues[cue] && start >= timestamp && start < timestamp + 1000) {
            subtitleCues.push({
              time: start,
              track: index + 3,
              relative: retained.reduce((sum, bytes) => sum + bytes.length, 0),
            });
            retained.push(subtitleBlock(track, index, cue, start - timestamp));
          }
        }
      }
      return [{ timestamp, subtitleCues, raw: element(id.cluster, retained) }];
    });
  const emptySeek = seekHead({});
  let position = emptySeek.length + info.length + tracks.length;
  const points = clusters.flatMap((cluster) => {
    const point = element(0xbb, [
      uint(0xb3, cluster.timestamp),
      element(0xb7, [uint(0xf7, 1), uint(0xf1, position)]),
    ]);
    const subtitlePoints = cluster.subtitleCues.map((cue) =>
      element(0xbb, [
        uint(0xb3, cue.time),
        element(0xb7, [
          uint(0xf7, cue.track),
          uint(0xf1, position),
          uint(0xf0, cue.relative),
          uint(0xb2, 3000),
        ]),
      ]),
    );
    position += cluster.raw.length;
    return [point, ...subtitlePoints];
  });
  const cues = element(id.cues, points);
  const seek = seekHead({
    [id.info]: emptySeek.length,
    [id.tracks]: emptySeek.length + info.length,
    [id.cues]: position,
  });
  const bytes = Buffer.concat([
    header,
    element(id.segment, [seek, info, tracks, ...clusters.map((cluster) => cluster.raw), cues]),
  ]);
  const name = `motion-subtitles${single ? '-single' : ''}.mkv.base64`;
  await writeFile(new URL(`./${name}`, import.meta.url), `${bytes.toString('base64')}\n`);
  console.info(
    `${name}: ${bytes.length} bytes, one audio, ${subtitleTracks.length} subtitles, 12 seconds`,
  );
}
