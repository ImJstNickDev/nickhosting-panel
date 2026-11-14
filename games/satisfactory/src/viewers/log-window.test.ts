import type { GameViewerLogPage } from '@nickhosting/game-sdk/ui';
import { expect, it } from 'vitest';
import { extendLogWindow } from './log-window.js';

const page = (offset: number, count = 200, revision = 'one'): GameViewerLogPage => ({
  offset,
  revision,
  total: 40000,
  totalLines: 40000,
  rows: Array.from({ length: count }, (_, i) => ({
    line: offset + i + 1,
    text: `Row ${offset + i + 1}`,
    level: 'info',
  })),
});
it('prepends older rows and evicts only the far newer edge at600 rows', () => {
  const result = extendLogWindow(page(600, 600), page(400), 'before');
  expect(result.offset).toBe(400);
  expect(result.rows).toHaveLength(600);
  expect(result.rows[0]?.line).toBe(401);
  expect(result.rows.at(-1)?.line).toBe(1000);
  expect(result.rows[200]).toBeDefined();
});
it('appends newer rows and adjusts offset after far older edge eviction', () => {
  const result = extendLogWindow(page(0, 600), page(600), 'after');
  expect(result.offset).toBe(200);
  expect(result.rows).toHaveLength(600);
  expect(result.rows[0]?.line).toBe(201);
  expect(result.rows.at(-1)?.line).toBe(800);
});
it('does not merge different revisions or missing intervals', () => {
  const changed = page(200, 200, 'two');
  expect(extendLogWindow(page(0), changed, 'after')).toBe(changed);
  const gap = page(400);
  expect(extendLogWindow(page(0), gap, 'after')).toBe(gap);
});
it('keeps row objects for existing visible content and supports partial last pages', () => {
  const old = page(0, 200),
    next = page(200, 3);
  const result = extendLogWindow(old, next, 'after');
  expect(result.rows).toHaveLength(203);
  expect(result.rows[50]).toBe(old.rows[50]);
  expect(result.offset).toBe(0);
});
