import { expect, it } from 'vitest';
import { openworldSupportsSrv } from './version-policy.js';

it.each([
  [null, false],
  ['unknown', false],
  ['snapshot-latest', false],
  ['a1.2.10-preview', false],
  ['pre-a1.2.10', false],
  ['a1.2.10-1', false],
  ['a1.1.99', false],
  ['a1.2.9', false],
  ['pre-a1.2.10-1', false],
  ['a1.2.10', true],
  ['a1.2.11', true],
  ['pre-a1.2.11-1', true],
  ['a1.3.0', true],
  ['a2.0.0', true],
] as const)('resolves Openworld SRV for %s as %s', (version, expected) => {
  expect(openworldSupportsSrv(version)).toBe(expected);
});
