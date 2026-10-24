/** Preview budgets only. Streamed media and downloads have no whole-file memory limit. */
export const previewLimits = {
  imageBytes: 64 * 1024 * 1024,
  icoBytes: 16 * 1024 * 1024,
  jsonBytes: 8 * 1024 * 1024,
  textBytes: 1024 * 1024,
  jsonNodes: 100_000,
  jsonDepth: 128,
  jsonParseMs: 5000,
  iconFrames: 256,
  iconPixels: 16_777_216,
} as const;
