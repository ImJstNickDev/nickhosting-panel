import { expect, it } from 'vitest';
import { satisfactoryIntegration } from './manifest.js';
import {
  buildSatisfactoryPlan,
  satisfactoryEggEnvironment,
  satisfactoryPortArguments,
} from './runtime.js';

it('declares both game transports and a distinct reliable port', () => {
  expect(satisfactoryIntegration.manifest.ports).toEqual([
    { role: 'game', transport: 'both', required: true },
    { role: 'reliable', transport: 'tcp', required: true },
  ]);
  expect(buildSatisfactoryPlan({}, 'public').configuration).toEqual({
    branch: 'public',
    autoUpdate: true,
  });
});
it('binds explicit allocated ports and advertised reliable port without shell interpolation', () => {
  expect(satisfactoryPortArguments({ game: 7777, reliable: 8888, externalReliable: 9999 })).toEqual(
    ['-Port=7777', '-ReliablePort=8888', '-ExternalReliablePort=9999'],
  );
  expect(
    satisfactoryEggEnvironment({}, { game: 7777, reliable: 8888, externalReliable: 9999 })
      .EXTERNAL_RELIABLE_PORT,
  ).toBe('9999');
  expect(() =>
    satisfactoryPortArguments({ game: 7777, reliable: 7777, externalReliable: 9999 }),
  ).toThrow();
  expect(() => buildSatisfactoryPlan({ branch: '$(bad)' }, 'public')).toThrow();
});
