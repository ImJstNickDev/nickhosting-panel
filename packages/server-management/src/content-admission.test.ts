import { resolveConfig } from '@nickhosting/core';
import { describe, expect, it } from 'vitest';
import {
  assertContentCapacity,
  type ContentClaimUsage,
  contentStorageRoot,
} from './content-admission.js';

const config = resolveConfig({
  contentSourceGlobalBytes: 1000,
  contentSourceUserBytes: 700,
  contentSourceConcurrent: 3,
  contentSourceUserConcurrent: 2,
  gameContentPolicies: {
    minecraft: { sourceGlobalBytes: 500, sourceUserBytes: 400, sourceConcurrent: 2 },
  },
}).values;
const claim = (gameId: string, ownerId: string, bytes: number, active = 1): ContentClaimUsage => ({
  gameId,
  ownerId,
  bytes: BigInt(bytes),
  active,
});
const input = { gameId: 'minecraft', ownerId: 'user-one', bytes: 200n };

describe('shared game content admission', () => {
  it('enforces one aggregate byte budget across independent games and owners', () => {
    expect(() =>
      assertContentCapacity(config, [claim('fixture-game', 'user-two', 801)], input),
    ).toThrow('resources_unavailable');
    expect(() =>
      assertContentCapacity(config, [claim('fixture-game', 'user-two', 800)], input),
    ).not.toThrow();
  });
  it('keeps each user charged across integrations', () => {
    expect(() =>
      assertContentCapacity(config, [claim('fixture-game', 'user-one', 501)], input),
    ).toThrow('resources_unavailable');
    expect(() =>
      assertContentCapacity(config, [claim('fixture-game', 'user-one', 500)], input),
    ).not.toThrow();
  });
  it('applies local game and game-user caps only to their scope', () => {
    expect(() =>
      assertContentCapacity(config, [claim('minecraft', 'user-two', 301)], input),
    ).toThrow('resources_unavailable');
    expect(() =>
      assertContentCapacity(config, [claim('minecraft', 'user-one', 201)], input),
    ).toThrow('resources_unavailable');
    expect(() =>
      assertContentCapacity(config, [claim('fixture-game', 'user-two', 301)], input),
    ).not.toThrow();
  });
  it('does not multiply global concurrency by the number of games', () => {
    const claims = [
      claim('fixture-one', 'u1', 10),
      claim('fixture-two', 'u2', 10),
      claim('fixture-three', 'u3', 10),
    ];
    expect(() => assertContentCapacity(config, claims, input)).toThrow('resources_unavailable');
  });
  it('combines active source transfers and expanded jobs while counting retained ready bytes', () => {
    const claims = [
      claim('minecraft', 'user-two', 100, 1),
      claim('minecraft', 'user-three', 100, 1),
    ];
    expect(() => assertContentCapacity(config, claims, input)).toThrow('resources_unavailable');
    expect(() =>
      assertContentCapacity(
        config,
        claims.map((row) => ({ ...row, active: 0 })),
        input,
      ),
    ).not.toThrow();
    expect(() =>
      assertContentCapacity(config, [claim('minecraft', 'user-two', 400, 0)], input),
    ).toThrow('resources_unavailable');
  });
  it('limits concurrent work for one user even across games', () => {
    expect(() =>
      assertContentCapacity(
        config,
        [claim('fixture-one', 'user-one', 10), claim('fixture-two', 'user-one', 10)],
        input,
      ),
    ).toThrow('resources_unavailable');
  });
  it('cannot escape the owned mountdata area', () => {
    for (const root of ['/tmp', './mountdata', './mountdata/../escape'])
      expect(() => contentStorageRoot(root)).toThrow('configuration_invalid');
    expect(contentStorageRoot('./mountdata/fixture-content')).toMatch(
      /\/mountdata\/fixture-content$/,
    );
  });
});
