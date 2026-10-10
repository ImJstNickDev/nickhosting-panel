import { describe, expect, it } from 'vitest';
import { resolveRuntimeImage, runtimeImagePolicySchema } from './runtime-images.js';

describe('integration runtime images', () => {
  const context = { gameVersion: 'Summer Update', requirements: { engine: '2' } };
  const policy = runtimeImagePolicySchema.parse({
    mode: 'rules',
    rules: [{ id: 'engine-two', image: 'registry.test/game:2', requirements: { engine: '2' } }],
  });
  it('supports a fixed integration image independently of version numbering', () => {
    expect(resolveRuntimeImage({ mode: 'fixed', image: 'registry.test/game:1' }, context)).toEqual({
      image: 'registry.test/game:1',
    });
  });
  it('matches trusted requirements and rejects missing or mismatched requirements', () => {
    expect(resolveRuntimeImage(policy, context)).toEqual({
      image: 'registry.test/game:2',
      ruleId: 'engine-two',
    });
    for (const requirements of [{}, { engine: '3' }] as Record<string, string>[])
      expect(() => resolveRuntimeImage(policy, { ...context, requirements })).toThrow();
  });
  it('rejects ambiguous matches instead of taking the first', () => {
    expect(() =>
      resolveRuntimeImage(
        {
          mode: 'rules',
          rules: [
            { id: 'one', image: 'registry.test/game:1', requirements: { engine: '2' } },
            { id: 'two', image: 'registry.test/game:2', requirements: { engine: '2' } },
          ],
        },
        context,
      ),
    ).toThrow();
  });
  it('delegates inclusive ranges to the integration ordering, without SemVer assumptions', () => {
    const versions = ['Winter Update', 'Spring Update', 'Summer Update'];
    const ranged = runtimeImagePolicySchema.parse({
      mode: 'rules',
      rules: [
        {
          id: 'season',
          image: 'registry.test/game:2',
          versions: { min: 'Spring Update', max: 'Summer Update' },
          requirements: { engine: '2' },
        },
      ],
    });
    const compareVersions = (a: string, b: string) =>
      versions.includes(a) && versions.includes(b)
        ? versions.indexOf(a) - versions.indexOf(b)
        : undefined;
    for (const gameVersion of ['Spring Update', 'Summer Update'])
      expect(resolveRuntimeImage(ranged, { ...context, gameVersion, compareVersions }).image).toBe(
        'registry.test/game:2',
      );
    for (const gameVersion of ['Winter Update', 'Future Update'])
      expect(() =>
        resolveRuntimeImage(ranged, { ...context, gameVersion, compareVersions }),
      ).toThrow();
    expect(() => resolveRuntimeImage(ranged, context)).toThrow();
    expect(() =>
      resolveRuntimeImage(ranged, { ...context, compareVersions: () => Number.NaN }),
    ).toThrow();
    expect(() =>
      resolveRuntimeImage(ranged, { ...context, compareVersions, requirements: {} }),
    ).toThrow();
  });
  it('rejects reversed ranges, empty rules, duplicate IDs and malformed image references', () => {
    for (const policy of [
      { mode: 'rules', rules: [] },
      { mode: 'rules', rules: [{ id: 'any', image: 'test:1' }] },
      { mode: 'fixed', image: 'https://registry.test/image?token=private' },
      {
        mode: 'rules',
        rules: [1, 2].map(() => ({ id: 'same', image: 'test:1', requirements: { engine: '2' } })),
      },
    ])
      expect(runtimeImagePolicySchema.safeParse(policy).success).toBe(false);
    expect(() =>
      resolveRuntimeImage(
        {
          mode: 'rules',
          rules: [{ id: 'reversed', image: 'test:1', versions: { min: 'b', max: 'a' } }],
        },
        { ...context, compareVersions: (a, b) => a.localeCompare(b) },
      ),
    ).toThrow();
  });
});
